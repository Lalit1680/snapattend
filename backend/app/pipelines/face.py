"""Face pipeline: per-student enrollment and bulk class-photo matching.

Two entry points, both pure functions over bytes:

``enroll_face_samples(samples)``
    2-3 webcam captures -> one averaged, unit-normalised 128-d embedding.

``match_class_photo(photo, roster)``
    One photo of a whole class -> confident matches + a review queue.

Matching policy (the part worth understanding)
----------------------------------------------
A detected face is only auto-marked when **all** of these hold:

1. The face box is large enough to carry real detail (``min_face_pixels``).
2. Its nearest roster neighbour is within ``match_threshold``.
3. The runner-up is at least ``ambiguity_margin`` further away — two students
   that are similarly close is a question for the teacher, not a coin flip.
4. That student has not already been claimed by a closer face in the same photo.

Anything else becomes a review-queue item with a machine-readable ``reason``.
The system never guesses on a student's attendance record; it escalates.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Callable, Optional, Sequence

import numpy as np

from ..config import Config
from ..models.constants import ReviewReason
from .imaging import (
    BLUR_VARIANCE_FLOOR,
    FaceBox,
    ImageDecodeError,
    LoadedImage,
    blur_variance,
    brightness,
    crop_face,
    load_image,
)

log = logging.getLogger(__name__)

# Faces smaller than this are not embedded at all — dlib's descriptor is
# meaningless at that scale and a "best guess" from it would mislead the teacher.
ABSOLUTE_MIN_FACE_PIXELS = 24

# Enrollment samples of one person taken seconds apart should be near-identical.
# A spread wider than this means the samples are not all the same face (or one is
# unusable), so we refuse rather than average them into a mushy embedding.
ENROLLMENT_CONSISTENCY_MAX = 0.20

# Overlapping detections of a single face are merged above this IoU.
NMS_IOU_THRESHOLD = 0.4

FACE_EMBEDDING_DIM = 128


class FacePipelineError(Exception):
    """A recoverable, user-facing problem with a face operation."""


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class FaceMatchConfig:
    match_threshold: float = 0.12
    review_ceiling: float = 0.28
    ambiguity_margin: float = 0.04
    min_face_pixels: int = 48
    detection_model: str = "hog"
    upsample: int = 1
    max_dim: int = 2400

    @classmethod
    def from_config(cls) -> "FaceMatchConfig":
        return cls(
            match_threshold=Config.FACE_MATCH_THRESHOLD,
            review_ceiling=Config.FACE_REVIEW_CEILING,
            ambiguity_margin=Config.FACE_AMBIGUITY_MARGIN,
            min_face_pixels=Config.MIN_FACE_PIXELS,
            detection_model=Config.FACE_DETECTION_MODEL,
            upsample=Config.FACE_DETECTION_UPSAMPLE,
            max_dim=Config.CLASS_PHOTO_MAX_DIM,
        )


# --------------------------------------------------------------------------- #
# Results
# --------------------------------------------------------------------------- #
@dataclass
class SampleRejection:
    index: int
    reason: str
    message: str


@dataclass
class FaceEnrollmentResult:
    ok: bool
    message: str
    embedding: Optional[list[float]] = None
    accepted_samples: int = 0
    rejections: list[SampleRejection] = field(default_factory=list)
    # Widest pairwise distance among accepted samples; a quality signal we log
    # so drifting enrollment quality is visible without re-running anything.
    consistency: Optional[float] = None


@dataclass
class ClassPhotoMatch:
    face_index: int
    student_id: str
    distance: float
    confidence: float
    box: dict


@dataclass
class ClassPhotoReviewItem:
    face_index: int
    box: dict
    crop_jpeg_b64: str
    reason: str
    best_guess_student_id: Optional[str] = None
    distance: Optional[float] = None
    confidence: Optional[float] = None


@dataclass
class ClassPhotoResult:
    faces_detected: int
    matches: list[ClassPhotoMatch] = field(default_factory=list)
    review_items: list[ClassPhotoReviewItem] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    processed_width: int = 0
    processed_height: int = 0
    duration_ms: int = 0

    @property
    def auto_matched(self) -> int:
        return len(self.matches)

    @property
    def needs_review(self) -> int:
        return len(self.review_items)

    def summary(self) -> dict:
        return {
            "faces_detected": self.faces_detected,
            "auto_matched": self.auto_matched,
            "needs_review": self.needs_review,
            "processed_width": self.processed_width,
            "processed_height": self.processed_height,
            "duration_ms": self.duration_ms,
            "warnings": list(self.warnings),
        }


# --------------------------------------------------------------------------- #
# Lazy dlib import
# --------------------------------------------------------------------------- #
def _face_recognition():
    """Import ``face_recognition`` on demand with an actionable error message.

    dlib is the single hardest dependency to install in this project, so a
    missing wheel should say so plainly rather than raising a bare ImportError
    from three frames deep in a request handler.
    """
    try:
        import face_recognition  # noqa: PLC0415 - intentional lazy import

        return face_recognition
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise FacePipelineError(
            "Face recognition is unavailable: the 'face_recognition' package (and its "
            "dlib dependency) is not installed. See the README's dlib install notes."
        ) from exc


def _cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine distance between two vectors, matching Chroma's metric."""
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 2.0
    return float(1.0 - float(np.dot(a, b) / (na * nb)))


# --------------------------------------------------------------------------- #
# Detection helpers
# --------------------------------------------------------------------------- #
def _iou(a: FaceBox, b: FaceBox) -> float:
    inter_left = max(a.left, b.left)
    inter_top = max(a.top, b.top)
    inter_right = min(a.right, b.right)
    inter_bottom = min(a.bottom, b.bottom)
    inter_w = max(0, inter_right - inter_left)
    inter_h = max(0, inter_bottom - inter_top)
    intersection = inter_w * inter_h
    if intersection == 0:
        return 0.0
    union = (a.width * a.height) + (b.width * b.height) - intersection
    return intersection / union if union else 0.0


def _suppress_overlaps(boxes: list[FaceBox]) -> list[FaceBox]:
    """Drop duplicate detections of the same face (keep the largest).

    HOG occasionally returns two boxes for one face at different upsample
    scales. Without this, one student generates two review-queue entries and the
    teacher has to dismiss a phantom.
    """
    ordered = sorted(boxes, key=lambda b: b.width * b.height, reverse=True)
    kept: list[FaceBox] = []
    for box in ordered:
        if all(_iou(box, k) < NMS_IOU_THRESHOLD for k in kept):
            kept.append(box)
    # Restore reading order (top-to-bottom, left-to-right) so face indices are
    # stable and intuitive when a teacher looks at the review queue.
    kept.sort(key=lambda b: (b.top, b.left))
    return kept


def detect_faces(image: LoadedImage, cfg: FaceMatchConfig) -> list[FaceBox]:
    fr = _face_recognition()
    model = cfg.detection_model if cfg.detection_model in ("hog", "cnn") else "hog"
    try:
        raw = fr.face_locations(
            image.rgb,
            number_of_times_to_upsample=max(0, min(2, cfg.upsample)),
            model=model,
        )
    except (RuntimeError, MemoryError) as exc:
        # cnn model on a large image without a GPU is the usual cause.
        raise FacePipelineError(
            f"Face detection failed ({exc}). Try a smaller image or "
            f"FACE_DETECTION_MODEL=hog."
        ) from exc

    boxes = [
        FaceBox(
            top=int(top),
            right=int(right),
            bottom=int(bottom),
            left=int(left),
            image_width=image.width,
            image_height=image.height,
        )
        for (top, right, bottom, left) in raw
    ]
    return _suppress_overlaps(boxes)


def _encode_faces(
    image: LoadedImage, boxes: Sequence[FaceBox], *, num_jitters: int
) -> list[Optional[np.ndarray]]:
    """Compute one 128-d descriptor per box.

    Encodes in a single batched call (dlib re-uses the loaded model) and uses the
    68-point landmark model, which aligns faces better than the 5-point default
    and measurably improves matching on the off-axis faces common in a class
    photo.
    """
    if not boxes:
        return []
    fr = _face_recognition()
    locations = [(b.top, b.right, b.bottom, b.left) for b in boxes]
    try:
        encodings = fr.face_encodings(
            image.rgb,
            known_face_locations=locations,
            num_jitters=max(1, num_jitters),
            model="large",
        )
    except Exception as exc:  # pragma: no cover - dlib internal failure
        raise FacePipelineError(f"Could not compute face embeddings: {exc}") from exc

    out: list[Optional[np.ndarray]] = []
    for idx in range(len(boxes)):
        vector = encodings[idx] if idx < len(encodings) else None
        if vector is None or len(vector) != FACE_EMBEDDING_DIM:
            out.append(None)
        else:
            out.append(np.asarray(vector, dtype=np.float64))
    return out


# --------------------------------------------------------------------------- #
# Enrollment
# --------------------------------------------------------------------------- #
def enroll_face_samples(
    samples: Sequence[bytes],
    *,
    min_accepted: int = 2,
    max_dim: Optional[int] = None,
) -> FaceEnrollmentResult:
    """Turn webcam captures into one averaged face embedding.

    Each sample is validated independently (exactly one face, sharp enough, big
    enough) and rejected with a specific reason so the UI can tell the student
    what to fix. Surviving samples must also agree with each other before their
    average is accepted.
    """
    if not samples:
        return FaceEnrollmentResult(ok=False, message="No face samples were provided")

    cfg = FaceMatchConfig.from_config()
    limit = max_dim or Config.ENROLLMENT_PHOTO_MAX_DIM

    embeddings: list[np.ndarray] = []
    rejections: list[SampleRejection] = []

    for index, raw in enumerate(samples):
        try:
            image = load_image(raw, max_dim=limit)
        except ImageDecodeError as exc:
            rejections.append(SampleRejection(index, "decode_failed", str(exc)))
            continue

        if brightness(image.rgb) < 25:
            rejections.append(
                SampleRejection(index, "too_dark", "The image is too dark — find better lighting")
            )
            continue

        boxes = detect_faces(image, cfg)
        if not boxes:
            rejections.append(
                SampleRejection(
                    index, "no_face", "No face detected — look straight at the camera"
                )
            )
            continue
        if len(boxes) > 1:
            # Averaging two people's faces would create an embedding that matches
            # neither, so this has to be a hard rejection.
            rejections.append(
                SampleRejection(
                    index,
                    "multiple_faces",
                    f"{len(boxes)} faces detected — make sure you are alone in frame",
                )
            )
            continue

        box = boxes[0]
        if box.longest_edge < cfg.min_face_pixels:
            rejections.append(
                SampleRejection(index, "face_too_small", "Move closer to the camera")
            )
            continue

        crop_region = image.rgb[box.top : box.bottom, box.left : box.right]
        if crop_region.size and blur_variance(crop_region) < BLUR_VARIANCE_FLOOR:
            rejections.append(
                SampleRejection(index, "too_blurry", "The image is blurry — hold still and retake")
            )
            continue

        encoded = _encode_faces(image, [box], num_jitters=3)
        if not encoded or encoded[0] is None:
            rejections.append(
                SampleRejection(index, "encode_failed", "Could not read facial features from this frame")
            )
            continue

        embeddings.append(encoded[0])

    if len(embeddings) < min_accepted:
        return FaceEnrollmentResult(
            ok=False,
            message=(
                f"Only {len(embeddings)} of {len(samples)} samples were usable; "
                f"at least {min_accepted} are required. Please retake."
            ),
            accepted_samples=len(embeddings),
            rejections=rejections,
        )

    consistency = 0.0
    for i in range(len(embeddings)):
        for j in range(i + 1, len(embeddings)):
            consistency = max(consistency, _cosine_distance(embeddings[i], embeddings[j]))

    if consistency > ENROLLMENT_CONSISTENCY_MAX:
        return FaceEnrollmentResult(
            ok=False,
            message=(
                "The samples do not look like the same person. Please retake all of them, "
                "making sure only you are in frame."
            ),
            accepted_samples=len(embeddings),
            rejections=rejections,
            consistency=round(consistency, 4),
        )

    # Average then normalise: averaging in raw space and normalising once keeps
    # every sample equally weighted, which is what we want from N captures of the
    # same face seconds apart.
    mean_vector = np.mean(np.stack(embeddings, axis=0), axis=0)
    norm = float(np.linalg.norm(mean_vector))
    if norm == 0:
        return FaceEnrollmentResult(
            ok=False,
            message="Face embedding computation failed. Please retake your samples.",
            accepted_samples=len(embeddings),
            rejections=rejections,
        )

    return FaceEnrollmentResult(
        ok=True,
        message=f"Face enrolled from {len(embeddings)} sample(s)",
        embedding=(mean_vector / norm).tolist(),
        accepted_samples=len(embeddings),
        rejections=rejections,
        consistency=round(consistency, 4),
    )


# --------------------------------------------------------------------------- #
# Class photo matching
# --------------------------------------------------------------------------- #
QueryFn = Callable[..., list]


@dataclass
class _Candidate:
    """Internal scoring record for one detected face during assignment."""

    face_index: int
    ranked: list  # VectorMatch objects, ascending distance
    forced_review: Optional[str] = None

    @property
    def best_distance(self) -> float:
        # Faces with no candidates sort last (2.0 is the cosine maximum).
        return self.ranked[0].distance if self.ranked else 2.0


def match_class_photo(
    photo_bytes: bytes,
    *,
    institution_id: str,
    roster_student_ids: Sequence[str],
    cfg: Optional[FaceMatchConfig] = None,
    query_fn: Optional[QueryFn] = None,
) -> ClassPhotoResult:
    """Detect every face in a class photo and split them into matches vs review.

    ``query_fn`` defaults to the Chroma-backed nearest-neighbour search and is
    injectable so this function can be exercised against a stub index without a
    vector store — see ``scripts/test_pipelines.py``.

    The photo bytes are used only within this call; nothing here writes them
    anywhere. The returned review items carry small JPEG crops, which are the one
    piece of imagery the caller may persist (briefly) for teacher review.
    """
    started = time.perf_counter()
    cfg = cfg or FaceMatchConfig.from_config()
    if query_fn is None:
        from .. import vector_store

        query_fn = vector_store.query_face

    warnings: list[str] = []
    roster = [str(s) for s in roster_student_ids if s]

    image = load_image(photo_bytes, max_dim=cfg.max_dim)
    if image.scale < 1.0:
        warnings.append(
            f"Image downscaled from {image.original_width}x{image.original_height} "
            f"to {image.width}x{image.height} for processing"
        )
    if brightness(image.rgb) < 30:
        warnings.append("The photo is very dark, which reduces detection accuracy")

    boxes = detect_faces(image, cfg)
    if not boxes:
        # An explicit, non-error result: zero faces is a legitimate outcome the
        # teacher needs to see and act on, not an exception.
        return ClassPhotoResult(
            faces_detected=0,
            warnings=warnings
            + [
                "No faces were detected in this photo. Check framing and lighting, "
                "then upload again."
            ],
            processed_width=image.width,
            processed_height=image.height,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    if not roster:
        warnings.append(
            "No students are enrolled in this class, so every detected face needs review"
        )

    # Faces too small to embed are recorded up front; the rest get descriptors.
    embeddable: list[int] = []
    for idx, box in enumerate(boxes):
        if box.longest_edge >= ABSOLUTE_MIN_FACE_PIXELS:
            embeddable.append(idx)

    encodings: dict[int, Optional[np.ndarray]] = {i: None for i in range(len(boxes))}
    if embeddable:
        computed = _encode_faces(image, [boxes[i] for i in embeddable], num_jitters=1)
        for slot, face_idx in enumerate(embeddable):
            encodings[face_idx] = computed[slot] if slot < len(computed) else None

    # ---- Score every face against the roster ------------------------------
    candidates: list[_Candidate] = []
    for idx, box in enumerate(boxes):
        forced: Optional[str] = None
        if box.longest_edge < cfg.min_face_pixels:
            # Detected, but too few pixels to trust — the brief explicitly wants
            # these surfaced for review rather than force-matched.
            forced = ReviewReason.LOW_RESOLUTION
        vector = encodings.get(idx)
        ranked: list = []
        if vector is not None and roster:
            try:
                ranked = query_fn(
                    vector.tolist(),
                    institution_id,
                    roster,
                    n_results=min(3, len(roster)),
                )
            except Exception as exc:  # pragma: no cover - vector store failure
                log.error("Vector query failed for face %s: %s", idx, exc)
                warnings.append("Embedding search failed for one or more faces")
        candidates.append(_Candidate(face_index=idx, ranked=ranked, forced_review=forced))

    # ---- Greedy assignment, closest match first ---------------------------
    # Sorting by distance means the most confident face wins a contested student,
    # which is both intuitive and stable regardless of detection order.
    candidates.sort(key=lambda c: c.best_distance)

    matches: list[ClassPhotoMatch] = []
    review: list[ClassPhotoReviewItem] = []
    claimed: dict[str, int] = {}  # student_id -> winning face index

    for candidate in candidates:
        box = boxes[candidate.face_index]
        best = candidate.ranked[0] if candidate.ranked else None
        runner_up = candidate.ranked[1] if len(candidate.ranked) > 1 else None

        reason: Optional[str] = candidate.forced_review
        if reason is None:
            if best is None:
                reason = ReviewReason.NO_MATCH
            elif best.distance > cfg.review_ceiling:
                # Nothing in the roster is even plausibly this person.
                reason = ReviewReason.NO_MATCH
            elif best.distance > cfg.match_threshold:
                reason = ReviewReason.LOW_CONFIDENCE
            elif runner_up is not None and (runner_up.distance - best.distance) < cfg.ambiguity_margin:
                reason = ReviewReason.AMBIGUOUS
            elif best.student_id in claimed:
                # Another, closer face already matched this student. Either this
                # is a duplicate detection or one of the two is wrong — a human
                # decides, we do not.
                reason = ReviewReason.AMBIGUOUS

        if reason is None and best is not None:
            claimed[best.student_id] = candidate.face_index
            matches.append(
                ClassPhotoMatch(
                    face_index=candidate.face_index,
                    student_id=best.student_id,
                    distance=round(best.distance, 5),
                    confidence=best.confidence,
                    box=box.to_dict(),
                )
            )
            continue

        # Review item: prefer an unclaimed best guess so the teacher's default
        # suggestion is actionable rather than a student already accounted for.
        guess = None
        for option in candidate.ranked:
            if option.student_id not in claimed and option.distance <= cfg.review_ceiling:
                guess = option
                break
        if guess is None and candidate.ranked:
            guess = candidate.ranked[0] if candidate.ranked[0].distance <= cfg.review_ceiling else None

        try:
            crop_b64 = crop_face(image.rgb, box)
        except ImageDecodeError as exc:
            log.warning("Skipping review crop for face %s: %s", candidate.face_index, exc)
            continue

        review.append(
            ClassPhotoReviewItem(
                face_index=candidate.face_index,
                box=box.to_dict(),
                crop_jpeg_b64=crop_b64,
                reason=reason or ReviewReason.NO_MATCH,
                best_guess_student_id=guess.student_id if guess else None,
                distance=round(guess.distance, 5) if guess else None,
                confidence=guess.confidence if guess else None,
            )
        )

    matches.sort(key=lambda m: m.face_index)
    review.sort(key=lambda r: r.face_index)

    result = ClassPhotoResult(
        faces_detected=len(boxes),
        matches=matches,
        review_items=review,
        warnings=warnings,
        processed_width=image.width,
        processed_height=image.height,
        duration_ms=int((time.perf_counter() - started) * 1000),
    )
    log.info(
        "Class photo processed: %s faces, %s auto-matched, %s for review (%sms)",
        result.faces_detected,
        result.auto_matched,
        result.needs_review,
        result.duration_ms,
    )
    return result


# --------------------------------------------------------------------------- #
# Single-face verification (used by re-enrollment sanity checks)
# --------------------------------------------------------------------------- #
def embed_single_face(image_bytes: bytes, *, max_dim: Optional[int] = None) -> list[float]:
    """Embed a photo containing exactly one face, or raise ``FacePipelineError``."""
    cfg = FaceMatchConfig.from_config()
    image = load_image(image_bytes, max_dim=max_dim or Config.ENROLLMENT_PHOTO_MAX_DIM)
    boxes = detect_faces(image, cfg)
    if not boxes:
        raise FacePipelineError("No face detected in the image")
    if len(boxes) > 1:
        raise FacePipelineError("More than one face detected; expected exactly one")
    encoded = _encode_faces(image, boxes, num_jitters=2)
    if not encoded or encoded[0] is None:
        raise FacePipelineError("Could not compute a face embedding")
    vector = encoded[0]
    norm = float(np.linalg.norm(vector))
    return (vector / norm).tolist() if norm else vector.tolist()
