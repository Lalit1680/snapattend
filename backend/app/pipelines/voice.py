"""Voice pipeline: speaker embeddings via Resemblyzer.

Audio format decision
---------------------
Browsers cannot record WAV natively — ``MediaRecorder`` produces WebM/Opus, and
decoding that server-side would mean an ffmpeg dependency. Instead the frontend
decodes its own recording with the Web Audio API and re-encodes it as 16 kHz
mono 16-bit PCM WAV before upload (see ``frontend/src/lib/audio.js``). That keeps
the backend to ``soundfile``, which handles WAV natively, and puts the format
conversion where the audio already lives.

This module still accepts anything ``soundfile`` can read, so a WAV/FLAC/OGG file
from the standalone test harness works too.

Thresholds
----------
Resemblyzer returns 256-d **already unit-normalised** embeddings, so cosine
distance is directly comparable across utterances. Same-speaker pairs typically
land at 0.05-0.25; different speakers sit well above 0.4. The default
``VOICE_MATCH_THRESHOLD`` of 0.25 (i.e. cosine similarity >= 0.75) is a
deliberately conservative accept boundary for an attendance decision.
"""
from __future__ import annotations

import io
import logging
import threading
from dataclasses import dataclass, field
from typing import Optional, Sequence

import numpy as np

from ..config import Config

log = logging.getLogger(__name__)

# Resemblyzer's models are trained at 16 kHz; feeding anything else silently
# degrades the embedding, so we always resample to this rate.
TARGET_SAMPLE_RATE = 16_000
VOICE_EMBEDDING_DIM = 256

# A passphrase shorter than this carries too little speaker information. The
# encoder itself needs at least 1.6s of voiced audio for one full window.
MIN_VOICED_SECONDS = 1.5
MAX_CLIP_SECONDS = 20.0

# Peak amplitude below this means an effectively silent recording (muted mic).
SILENCE_PEAK_FLOOR = 0.01

# Enrollment samples of the same speaker reading the same phrase should agree.
ENROLLMENT_CONSISTENCY_MAX = 0.35

# The fixed sentence students read. Kept in one place so the UI, the emails and
# any future prompt-rotation logic agree on it.
DEFAULT_PASSPHRASE = "My voice is my attendance signature for this class."

_encoder = None
_encoder_lock = threading.Lock()


class VoicePipelineError(Exception):
    """A recoverable, user-facing problem with a voice operation."""


@dataclass
class VoiceSampleRejection:
    index: int
    reason: str
    message: str


@dataclass
class VoiceEnrollmentResult:
    ok: bool
    message: str
    embedding: Optional[list[float]] = None
    accepted_samples: int = 0
    rejections: list[VoiceSampleRejection] = field(default_factory=list)
    consistency: Optional[float] = None
    duration_seconds: Optional[float] = None


# --------------------------------------------------------------------------- #
# Model loading
# --------------------------------------------------------------------------- #
def _get_encoder():
    """Return a process-wide ``VoiceEncoder``.

    Loading the torch weights takes a couple of seconds and a few hundred MB, so
    it happens once, lazily, behind a lock. Importing Resemblyzer at module scope
    would make every Flask reload pay that cost even for requests that never
    touch voice.
    """
    global _encoder
    if _encoder is None:
        with _encoder_lock:
            if _encoder is None:
                try:
                    from resemblyzer import VoiceEncoder
                except ImportError as exc:  # pragma: no cover - environment dependent
                    raise VoicePipelineError(
                        "Voice recognition is unavailable: the 'Resemblyzer' package is not "
                        "installed. See the README's install notes."
                    ) from exc
                log.info("Loading Resemblyzer VoiceEncoder (CPU)")
                # Pinned to CPU: a classroom-scale deployment does not need GPU
                # inference for a 3-second clip, and forcing CPU avoids surprising
                # CUDA/driver failures on the machines this actually runs on.
                _encoder = VoiceEncoder(device="cpu", verbose=False)
    return _encoder


# --------------------------------------------------------------------------- #
# Audio decoding
# --------------------------------------------------------------------------- #
def _decode_audio(data: bytes) -> tuple[np.ndarray, int]:
    """Decode audio bytes to a mono float32 waveform at its native sample rate."""
    if not data:
        raise VoicePipelineError("The audio recording is empty")

    try:
        import soundfile as sf
    except ImportError as exc:  # pragma: no cover
        raise VoicePipelineError(
            "Voice recognition is unavailable: 'soundfile' is not installed."
        ) from exc

    try:
        waveform, sample_rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception as exc:
        raise VoicePipelineError(
            "Could not read the audio recording. Expected WAV/FLAC/OGG — WebM/Opus is "
            "not supported server-side (the browser converts to WAV before upload)."
        ) from exc

    if waveform.size == 0:
        raise VoicePipelineError("The audio recording contains no samples")

    # Average channels rather than taking the first: some laptops record a near
    # silent second channel that would halve the perceived level.
    mono = waveform.mean(axis=1).astype(np.float32)
    return mono, int(sample_rate)


def _resample(waveform: np.ndarray, source_rate: int) -> np.ndarray:
    if source_rate == TARGET_SAMPLE_RATE:
        return waveform
    try:
        import librosa

        return librosa.resample(waveform, orig_sr=source_rate, target_sr=TARGET_SAMPLE_RATE)
    except ImportError:  # pragma: no cover
        # Linear-interpolation fallback. Lower quality than librosa's polyphase
        # filter but far better than feeding the encoder the wrong sample rate.
        log.warning("librosa unavailable; using linear resampling")
        duration = waveform.shape[0] / float(source_rate)
        target_length = max(1, int(round(duration * TARGET_SAMPLE_RATE)))
        source_positions = np.linspace(0, waveform.shape[0] - 1, num=waveform.shape[0])
        target_positions = np.linspace(0, waveform.shape[0] - 1, num=target_length)
        return np.interp(target_positions, source_positions, waveform).astype(np.float32)


def _preprocess(data: bytes) -> tuple[np.ndarray, float]:
    """Decode -> mono -> 16 kHz -> normalised, silence-trimmed waveform.

    Returns ``(waveform, voiced_seconds)``. Resemblyzer's ``preprocess_wav`` does
    the normalisation and VAD-based silence trimming; if its optional ``webrtcvad``
    dependency is unavailable we fall back to trimming disabled rather than
    failing the request outright.
    """
    mono, sample_rate = _decode_audio(data)

    raw_seconds = mono.shape[0] / float(sample_rate)
    if raw_seconds > MAX_CLIP_SECONDS:
        # Guard against someone uploading a podcast: truncate rather than reject,
        # since the passphrase is at the start anyway.
        mono = mono[: int(MAX_CLIP_SECONDS * sample_rate)]

    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    if peak < SILENCE_PEAK_FLOOR:
        raise VoicePipelineError(
            "The recording is silent. Check that your microphone is unmuted and try again."
        )

    resampled = _resample(mono, sample_rate)

    try:
        from resemblyzer import preprocess_wav

        try:
            processed = preprocess_wav(resampled, source_sr=TARGET_SAMPLE_RATE)
        except Exception as exc:
            log.warning("VAD silence-trimming unavailable (%s); continuing untrimmed", exc)
            processed = preprocess_wav(
                resampled, source_sr=TARGET_SAMPLE_RATE, trim_silence=False
            )
    except ImportError as exc:  # pragma: no cover
        raise VoicePipelineError(
            "Voice recognition is unavailable: the 'Resemblyzer' package is not installed."
        ) from exc

    processed = np.asarray(processed, dtype=np.float32)
    voiced_seconds = processed.shape[0] / float(TARGET_SAMPLE_RATE)
    if voiced_seconds < MIN_VOICED_SECONDS:
        raise VoicePipelineError(
            f"Only {voiced_seconds:.1f}s of speech was detected; at least "
            f"{MIN_VOICED_SECONDS:.1f}s is needed. Please read the whole phrase clearly."
        )
    return processed, voiced_seconds


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def compute_voice_embedding(audio_bytes: bytes) -> tuple[list[float], float]:
    """Return ``(embedding, voiced_seconds)`` for one recording.

    The embedding comes back unit-normalised straight from Resemblyzer, which is
    what our cosine thresholds assume.
    """
    waveform, voiced_seconds = _preprocess(audio_bytes)
    encoder = _get_encoder()
    try:
        embedding = encoder.embed_utterance(waveform)
    except Exception as exc:
        raise VoicePipelineError(f"Could not compute a voice embedding: {exc}") from exc

    vector = np.asarray(embedding, dtype=np.float64).ravel()
    if vector.shape[0] != VOICE_EMBEDDING_DIM:
        raise VoicePipelineError(
            f"Unexpected embedding size {vector.shape[0]} (expected {VOICE_EMBEDDING_DIM})"
        )
    norm = float(np.linalg.norm(vector))
    if norm == 0:
        raise VoicePipelineError("Voice embedding computation produced an empty vector")
    return (vector / norm).tolist(), round(voiced_seconds, 2)


def _cosine_distance(a: Sequence[float], b: Sequence[float]) -> float:
    va, vb = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    na, nb = np.linalg.norm(va), np.linalg.norm(vb)
    if na == 0 or nb == 0:
        return 2.0
    return float(1.0 - float(np.dot(va, vb) / (na * nb)))


def enroll_voice_samples(
    samples: Sequence[bytes], *, min_accepted: int = 1
) -> VoiceEnrollmentResult:
    """Turn 1-2 passphrase recordings into one averaged voice embedding.

    A single good recording is enough to enroll (unlike face, where multiple
    angles genuinely help), but when two are supplied we cross-check them and
    reject the pair if they sound like different speakers.
    """
    if not samples:
        return VoiceEnrollmentResult(ok=False, message="No voice samples were provided")

    embeddings: list[list[float]] = []
    rejections: list[VoiceSampleRejection] = []
    total_seconds = 0.0

    for index, raw in enumerate(samples):
        try:
            embedding, seconds = compute_voice_embedding(raw)
        except VoicePipelineError as exc:
            rejections.append(VoiceSampleRejection(index, "unusable_audio", str(exc)))
            continue
        embeddings.append(embedding)
        total_seconds += seconds

    if len(embeddings) < min_accepted:
        return VoiceEnrollmentResult(
            ok=False,
            message=(
                rejections[0].message
                if len(rejections) == 1
                else f"None of the {len(samples)} recordings were usable. Please re-record."
            ),
            accepted_samples=len(embeddings),
            rejections=rejections,
        )

    consistency = 0.0
    for i in range(len(embeddings)):
        for j in range(i + 1, len(embeddings)):
            consistency = max(consistency, _cosine_distance(embeddings[i], embeddings[j]))

    if consistency > ENROLLMENT_CONSISTENCY_MAX:
        return VoiceEnrollmentResult(
            ok=False,
            message=(
                "The two recordings do not sound like the same speaker. Please re-record "
                "both in a quiet place."
            ),
            accepted_samples=len(embeddings),
            rejections=rejections,
            consistency=round(consistency, 4),
        )

    mean_vector = np.mean(np.asarray(embeddings, dtype=np.float64), axis=0)
    norm = float(np.linalg.norm(mean_vector))
    if norm == 0:
        return VoiceEnrollmentResult(
            ok=False,
            message="Voice embedding computation failed. Please re-record.",
            accepted_samples=len(embeddings),
            rejections=rejections,
        )

    return VoiceEnrollmentResult(
        ok=True,
        message=f"Voice enrolled from {len(embeddings)} recording(s)",
        embedding=(mean_vector / norm).tolist(),
        accepted_samples=len(embeddings),
        rejections=rejections,
        consistency=round(consistency, 4),
        duration_seconds=round(total_seconds, 2),
    )


@dataclass
class VoiceVerificationResult:
    accepted: bool
    student_id: Optional[str]
    distance: Optional[float]
    confidence: Optional[float]
    message: str
    voiced_seconds: Optional[float] = None


def verify_voice(
    audio_bytes: bytes,
    *,
    institution_id: str,
    candidate_student_ids: Sequence[str],
    threshold: Optional[float] = None,
    query_fn=None,
) -> VoiceVerificationResult:
    """Match a live recording against a scoped set of enrolled voices.

    ``candidate_student_ids`` is normally a single-element list — the logged-in
    student — because voice check-in is self-service and we are *verifying* a
    claimed identity, not searching for one. Accepting a list keeps the function
    usable for open-set identification if that is ever needed, while the scoping
    guarantee (institution + roster) still holds.
    """
    if query_fn is None:
        from .. import vector_store

        query_fn = vector_store.query_voice

    limit = threshold if threshold is not None else Config.VOICE_MATCH_THRESHOLD
    embedding, voiced_seconds = compute_voice_embedding(audio_bytes)

    ranked = query_fn(
        embedding,
        institution_id,
        list(candidate_student_ids),
        n_results=min(3, max(1, len(candidate_student_ids))),
    )
    if not ranked:
        return VoiceVerificationResult(
            accepted=False,
            student_id=None,
            distance=None,
            confidence=None,
            message="No enrolled voice sample was found to compare against.",
            voiced_seconds=voiced_seconds,
        )

    best = ranked[0]
    if best.distance <= limit:
        return VoiceVerificationResult(
            accepted=True,
            student_id=best.student_id,
            distance=round(best.distance, 5),
            confidence=best.confidence,
            message="Voice verified",
            voiced_seconds=voiced_seconds,
        )
    return VoiceVerificationResult(
        accepted=False,
        student_id=best.student_id,
        distance=round(best.distance, 5),
        confidence=best.confidence,
        message=(
            "Your voice did not match closely enough. Re-record in a quieter place, "
            "speaking at a normal pace."
        ),
        voiced_seconds=voiced_seconds,
    )
