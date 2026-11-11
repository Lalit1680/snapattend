"""Standalone exercise of the face and voice pipelines. No Flask, no MongoDB.

The build order in the brief calls for the biometric pipelines to be provable on
their own, with clear input/output contracts, *before* they are wired into HTTP
routes. This is that proof. It runs the real dlib and Resemblyzer code paths
against files on disk, but substitutes an in-memory vector index for Chroma via
the ``query_fn`` parameter — so it exercises the matching logic and thresholds
without needing a database, a tenant, or a running server.

Layout it expects (all optional — it runs whatever it finds):

    samples/
      enroll/
        alice/  a1.jpg  a2.jpg  a3.jpg      <- 2-3 webcam-style frames per student
        bob/    b1.jpg  b2.jpg
      class/
        lecture1.jpg                        <- group photo containing those faces
      voice/
        alice.wav  bob.wav                  <- 16 kHz mono WAV passphrase clips
      voice_probe/
        alice.wav                           <- a *different* recording of alice

Usage::

    python scripts/test_pipelines.py                      # ./samples
    python scripts/test_pipelines.py --dir path/to/samples
    python scripts/test_pipelines.py --face-only
    python scripts/test_pipelines.py --threshold 0.15

Exit code is 0 when every stage that had input succeeded, 1 otherwise, so this is
usable as a smoke test after changing a threshold.
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Iterable, Optional, Sequence

# Allow "python scripts/test_pipelines.py" from the backend/ directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import Config  # noqa: E402
from app.pipelines import face as face_pipeline  # noqa: E402
from app.pipelines import voice as voice_pipeline  # noqa: E402

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
AUDIO_SUFFIXES = {".wav"}
FAKE_INSTITUTION = "test-institution"


# --------------------------------------------------------------------------- #
# A stand-in for Chroma
# --------------------------------------------------------------------------- #
@dataclass
class _Hit:
    """Mirrors ``vector_store.VectorMatch`` — the shape the pipelines expect."""

    student_id: str
    institution_id: str
    distance: float


class MemoryIndex:
    """Brute-force cosine index over unit-normalised vectors.

    Small enough to be obviously correct, which is the point: if a match looks
    wrong here, the bug is in the pipeline or the threshold, not in Chroma.
    """

    def __init__(self) -> None:
        self._vectors: dict[str, list[float]] = {}

    def add(self, student_id: str, embedding: Sequence[float]) -> None:
        self._vectors[str(student_id)] = _normalize(embedding)

    def __len__(self) -> int:
        return len(self._vectors)

    def student_ids(self) -> list[str]:
        return sorted(self._vectors)

    def query(
        self,
        embedding: Sequence[float],
        institution_id: str,
        student_ids: Optional[Iterable[str]] = None,
        n_results: int = 3,
    ) -> list[_Hit]:
        """Signature-compatible with ``vector_store.query_face`` / ``query_voice``."""
        probe = _normalize(embedding)
        allowed = {str(s) for s in student_ids} if student_ids else None
        hits = [
            _Hit(
                student_id=sid,
                institution_id=institution_id,
                distance=1.0 - _dot(probe, vec),  # Chroma's cosine distance
            )
            for sid, vec in self._vectors.items()
            if allowed is None or sid in allowed
        ]
        hits.sort(key=lambda h: h.distance)
        return hits[:n_results]


def _normalize(vector: Sequence[float]) -> list[float]:
    norm = sum(v * v for v in vector) ** 0.5
    return [v / norm for v in vector] if norm else list(vector)


def _dot(a: Sequence[float], b: Sequence[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


# --------------------------------------------------------------------------- #
# Output helpers
# --------------------------------------------------------------------------- #
class Report:
    """Accumulates pass/fail so the script can exit non-zero meaningfully."""

    def __init__(self) -> None:
        self.failures: list[str] = []
        self.skipped: list[str] = []

    def fail(self, message: str) -> None:
        self.failures.append(message)
        print(f"  FAIL  {message}")

    def ok(self, message: str) -> None:
        print(f"  ok    {message}")

    def skip(self, message: str) -> None:
        self.skipped.append(message)
        print(f"  skip  {message}")


def heading(text: str) -> None:
    print(f"\n{text}\n{'-' * len(text)}")


def _read(path: Path) -> bytes:
    return path.read_bytes()


def _sorted_files(directory: Path, suffixes: set[str]) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(p for p in directory.iterdir() if p.suffix.lower() in suffixes)


def _distance_detail(result) -> str:
    """Format the numeric part of a voice verification result.

    Every numeric field is optional — a clip that is too short never reaches the
    encoder, so there is no distance to report. Formatting ``None`` with ``:.4f``
    would turn a legitimate rejection into a ``TypeError``.
    """
    parts = []
    if result.distance is not None:
        parts.append(f"distance {result.distance:.4f}")
    if result.confidence is not None:
        parts.append(f"confidence {result.confidence:.0%}")
    if result.voiced_seconds is not None:
        parts.append(f"{result.voiced_seconds:.1f}s voiced")
    return ", ".join(parts) or "no measurement"


# --------------------------------------------------------------------------- #
# Face
# --------------------------------------------------------------------------- #
def run_face(root: Path, report: Report, *, threshold: Optional[float]) -> MemoryIndex:
    index = MemoryIndex()
    enroll_dir = root / "enroll"

    heading("Face enrollment")
    if not enroll_dir.is_dir():
        report.skip(f"no {enroll_dir} directory — skipping face enrollment")
        return index

    student_dirs = sorted(p for p in enroll_dir.iterdir() if p.is_dir())
    if not student_dirs:
        report.skip(f"{enroll_dir} contains no per-student folders")
        return index

    for student_dir in student_dirs:
        name = student_dir.name
        images = _sorted_files(student_dir, IMAGE_SUFFIXES)
        if not images:
            report.skip(f"{name}: no images")
            continue

        result = face_pipeline.enroll_face_samples([_read(p) for p in images])
        if not result.ok or not result.embedding:
            report.fail(f"{name}: {result.message}")
            for rejection in result.rejections:
                print(f"        sample {rejection.index + 1}: "
                      f"{rejection.reason} — {rejection.message}")
            continue

        index.add(name, result.embedding)
        consistency = (
            f", spread {result.consistency:.4f}" if result.consistency is not None else ""
        )
        report.ok(
            f"{name}: enrolled from {result.accepted_samples}/{len(images)} samples"
            f"{consistency}, dim {len(result.embedding)}"
        )
        for rejection in result.rejections:
            print(f"        rejected sample {rejection.index + 1}: {rejection.message}")

    print(f"\n  index now holds {len(index)} face vector(s)")

    heading("Face self-match (sanity check)")
    # An enrolled student's own averaged embedding must match itself at distance
    # ~0. If this fails, normalisation or the distance metric is wrong and no
    # amount of threshold tuning will save the class-photo stage.
    for student_dir in student_dirs:
        name = student_dir.name
        images = _sorted_files(student_dir, IMAGE_SUFFIXES)
        if not images:
            continue
        try:
            single = face_pipeline.embed_single_face(_read(images[0]))
        except Exception as exc:  # noqa: BLE001 - a pipeline error is a test failure
            report.fail(f"{name}: embed_single_face raised {type(exc).__name__}: {exc}")
            continue
        hits = index.query(single, FAKE_INSTITUTION, n_results=2)
        if not hits:
            report.fail(f"{name}: no hits from the index")
            continue
        best = hits[0]
        runner_up = f", runner-up {hits[1].student_id} @ {hits[1].distance:.4f}" if len(hits) > 1 else ""
        if best.student_id == name:
            report.ok(f"{name}: closest match is itself @ {best.distance:.4f}{runner_up}")
        else:
            report.fail(
                f"{name}: closest match was {best.student_id} @ {best.distance:.4f} "
                f"— expected {name}"
            )

    heading("Class photo matching")
    class_dir = root / "class"
    photos = _sorted_files(class_dir, IMAGE_SUFFIXES)
    if not photos:
        report.skip(f"no images in {class_dir}")
        return index
    if len(index) == 0:
        report.skip("no enrolled faces to match against")
        return index

    cfg = face_pipeline.FaceMatchConfig.from_config()
    if threshold is not None:
        # The config is frozen on purpose — a threshold that can be mutated
        # mid-run is a threshold nobody can reason about afterwards.
        cfg = replace(cfg, match_threshold=threshold)
    print(
        f"  thresholds: auto-match <= {cfg.match_threshold:.3f}, "
        f"review <= {cfg.review_ceiling:.3f}, ambiguity margin {cfg.ambiguity_margin:.3f}"
    )

    roster = index.student_ids()
    for photo in photos:
        result = face_pipeline.match_class_photo(
            _read(photo),
            institution_id=FAKE_INSTITUTION,
            roster_student_ids=roster,
            cfg=cfg,
            query_fn=index.query,
        )
        print(f"\n  {photo.name}")
        print(
            f"    {result.faces_detected} face(s) detected in "
            f"{result.processed_width}x{result.processed_height} "
            f"({result.duration_ms} ms)"
        )
        for warning in result.warnings:
            print(f"    warning: {warning}")

        if result.faces_detected == 0:
            report.fail(f"{photo.name}: no faces detected")
            continue

        for match in result.matches:
            print(
                f"    MATCH  face #{match.face_index}: {match.student_id} "
                f"(distance {match.distance:.4f}, confidence {match.confidence:.0%})"
            )
        for item in result.review_items:
            guess = ""
            if item.best_guess_student_id and item.distance is not None:
                guess = f", best guess {item.best_guess_student_id} @ {item.distance:.4f}"
            elif item.best_guess_student_id:
                guess = f", best guess {item.best_guess_student_id}"
            print(f"    REVIEW face #{item.face_index}: {item.reason}{guess}")
            # Proves the crop exists for the teacher UI without writing it to disk.
            print(f"           crop {len(item.crop_jpeg_b64)} base64 chars (kept in memory)")

        if result.matches:
            report.ok(
                f"{photo.name}: {result.auto_matched} auto-matched, "
                f"{result.needs_review} for review"
            )
        else:
            report.fail(
                f"{photo.name}: nothing auto-matched ({result.needs_review} in review). "
                f"Try raising FACE_MATCH_THRESHOLD or improving enrollment samples."
            )
    return index


# --------------------------------------------------------------------------- #
# Voice
# --------------------------------------------------------------------------- #
def run_voice(root: Path, report: Report, *, threshold: Optional[float]) -> None:
    heading("Voice enrollment")
    voice_dir = root / "voice"
    clips = _sorted_files(voice_dir, AUDIO_SUFFIXES)
    if not clips:
        report.skip(f"no .wav files in {voice_dir}")
        return

    index = MemoryIndex()
    for clip in clips:
        name = clip.stem
        result = voice_pipeline.enroll_voice_samples([_read(clip)])
        if not result.ok or not result.embedding:
            report.fail(f"{name}: {result.message}")
            for rejection in result.rejections:
                print(f"        {rejection.reason} — {rejection.message}")
            continue
        index.add(name, result.embedding)
        seconds = (
            f", {result.duration_seconds:.1f}s of audio"
            if result.duration_seconds is not None
            else ""
        )
        report.ok(f"{name}: enrolled, dim {len(result.embedding)}{seconds}")

    heading("Voice verification")
    if len(index) == 0:
        report.skip("nothing enrolled to verify against")
        return

    effective = threshold if threshold is not None else Config.VOICE_MATCH_THRESHOLD
    print(f"  threshold: accept when cosine distance <= {effective:.3f}")

    # Prefer a genuinely different recording; fall back to re-using the enrollment
    # clip, which only proves the plumbing works (it will always match at ~0).
    probe_dir = root / "voice_probe"
    probes = _sorted_files(probe_dir, AUDIO_SUFFIXES)
    if not probes:
        print(f"  (no {probe_dir} — re-using enrollment clips, so distances will be ~0)")
        probes = clips

    for probe in probes:
        claimed = probe.stem
        result = voice_pipeline.verify_voice(
            _read(probe),
            institution_id=FAKE_INSTITUTION,
            candidate_student_ids=[claimed],
            threshold=effective,
            query_fn=index.query,
        )
        detail = _distance_detail(result)
        if result.accepted:
            report.ok(f"{claimed}: accepted ({detail})")
        else:
            report.fail(f"{claimed}: rejected — {result.message} ({detail})")

    heading("Voice impostor check")
    # The important negative test: person A's recording must NOT verify as person
    # B. A 1:1 verifier that accepts anyone is worse than no verifier.
    names = index.student_ids()
    if len(names) < 2:
        report.skip("need at least two enrolled voices to test an impostor")
        return
    for probe in probes:
        speaker = probe.stem
        impostor_target = next((n for n in names if n != speaker), None)
        if impostor_target is None:
            continue
        result = voice_pipeline.verify_voice(
            _read(probe),
            institution_id=FAKE_INSTITUTION,
            candidate_student_ids=[impostor_target],
            threshold=effective,
            query_fn=index.query,
        )
        detail = _distance_detail(result)
        if result.accepted:
            report.fail(
                f"{speaker}'s voice was ACCEPTED as {impostor_target} ({detail}) "
                f"— VOICE_MATCH_THRESHOLD is too loose"
            )
        else:
            report.ok(f"{speaker} correctly rejected as {impostor_target} ({detail})")


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def main() -> int:
    parser = argparse.ArgumentParser(
        description="Exercise the face/voice pipelines against local files."
    )
    parser.add_argument(
        "--dir", default="samples", help="sample directory (default: ./samples)"
    )
    parser.add_argument("--face-only", action="store_true")
    parser.add_argument("--voice-only", action="store_true")
    parser.add_argument(
        "--threshold",
        type=float,
        default=None,
        help="override the match threshold for this run (cosine distance)",
    )
    args = parser.parse_args()

    root = Path(args.dir).resolve()
    print("SnapAttend pipeline harness")
    print(f"samples: {root}")
    print(f"face detection model: {Config.FACE_DETECTION_MODEL} "
          f"(upsample {Config.FACE_DETECTION_UPSAMPLE})")

    if not root.is_dir():
        print(
            f"\nNo sample directory at {root}.\n"
            f"Create it as described in this file's docstring, or pass --dir.\n"
            f"Nothing to do."
        )
        return 1

    report = Report()
    try:
        if not args.voice_only:
            run_face(root, report, threshold=args.threshold)
        if not args.face_only:
            run_voice(root, report, threshold=args.threshold)
    except ImportError as exc:
        # dlib / resemblyzer missing is the single most common setup failure, and
        # a bare traceback does not tell anyone what to do about it.
        print(f"\nMissing dependency: {exc}")
        print("Install the biometric extras:  pip install -r requirements.txt")
        print("dlib on Windows usually needs CMake + Visual Studio Build Tools;")
        print("see the troubleshooting section of README.md.")
        return 1

    heading("Summary")
    print(f"  {len(report.skipped)} skipped, {len(report.failures)} failed")
    if report.failures:
        for failure in report.failures:
            print(f"    - {failure}")
        return 1
    print("  all stages that had input passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
