"""Biometric enrollment endpoints — the student's own face and voice samples.

Samples arrive as base64 data URLs in a JSON body rather than multipart uploads.
That is a deliberate trade: the browser captures webcam frames onto a canvas and
audio into an AudioBuffer, both of which produce base64 far more naturally than
they produce a multipart form, and it keeps the frontend capture code short. The
~33% base64 overhead is irrelevant for two or three small images.

Nothing here writes an image or an audio file anywhere. The bytes are decoded,
handed to the pipeline, turned into a vector, and go out of scope when the request
ends — see ``services/enrollment`` for the ordering guarantees and
``services/face_crop_store`` for the full retention inventory.
"""
from __future__ import annotations

import base64
import binascii
import logging

from flask import Blueprint, jsonify

from .. import db
from ..auth import guards
from ..extensions import limiter
from ..models.constants import Role
from ..pipelines import voice as voice_pipeline
from ..services import attendance, enrollment as enrollment_service
from ..utils.errors import bad_request
from ..utils.validators import body, clean_reason, require

log = logging.getLogger(__name__)

bp = Blueprint("enroll", __name__, url_prefix="/api/enroll")

# A generous ceiling on one decoded sample. A 1080p JPEG frame is ~300 KB and a
# 5-second 16 kHz mono WAV is ~160 KB, so 8 MB catches abuse without ever
# rejecting a legitimate capture.
MAX_SAMPLE_BYTES = 8 * 1024 * 1024
MAX_SAMPLES = 5


def _decode_samples(raw, *, field: str) -> list[bytes]:
    """Decode a list of base64 / data-URL strings into raw bytes.

    Accepts both ``data:image/jpeg;base64,AAAA`` and a bare base64 payload,
    because ``canvas.toDataURL()`` produces the former and hand-written tests
    produce the latter.
    """
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple)) or not raw:
        raise bad_request(f"{field} must be a non-empty array of base64 samples")
    if len(raw) > MAX_SAMPLES:
        raise bad_request(f"Send at most {MAX_SAMPLES} samples per request")

    out: list[bytes] = []
    for index, item in enumerate(raw):
        if not isinstance(item, str) or not item.strip():
            raise bad_request(f"Sample {index + 1} is empty", index=index)
        payload = item.strip()
        if payload.startswith("data:"):
            _, _, payload = payload.partition(",")
        # Tolerate missing '=' padding, which some clients strip.
        payload += "=" * (-len(payload) % 4)
        try:
            decoded = base64.b64decode(payload, validate=False)
        except (binascii.Error, ValueError):
            raise bad_request(f"Sample {index + 1} is not valid base64", index=index)
        if not decoded:
            raise bad_request(f"Sample {index + 1} decoded to zero bytes", index=index)
        if len(decoded) > MAX_SAMPLE_BYTES:
            raise bad_request(
                f"Sample {index + 1} is larger than "
                f"{MAX_SAMPLE_BYTES // (1024 * 1024)} MB",
                index=index,
            )
        out.append(decoded)
    return out


def _my_student() -> dict:
    """The ``students`` row for the signed-in student, or a clear 403/404."""
    user = guards.current_user_doc()
    if user.get("role") != Role.STUDENT:
        raise bad_request(
            "Only a student account can enroll biometrics. Staff use the student "
            "management screen to reset a student's enrollment."
        )
    return attendance.student_for_user(user["_id"])


# --------------------------------------------------------------------------- #
# Status
# --------------------------------------------------------------------------- #
@bp.get("/status")
@guards.role_required(Role.STUDENT)
def status():
    """What the enrollment wizard still needs from this student."""
    student = _my_student()
    progress = enrollment_service.enrollment_progress(student)
    progress["face_sample_range"] = {
        "min": enrollment_service.MIN_FACE_SAMPLES,
        "max": enrollment_service.MAX_FACE_SAMPLES,
    }
    progress["voice_sample_range"] = {
        "min": enrollment_service.MIN_VOICE_SAMPLES,
        "max": enrollment_service.MAX_VOICE_SAMPLES,
    }
    progress["audio_requirements"] = {
        "sample_rate": voice_pipeline.TARGET_SAMPLE_RATE,
        "format": "16-bit PCM WAV, mono",
        "min_voiced_seconds": voice_pipeline.MIN_VOICED_SECONDS,
        "max_clip_seconds": voice_pipeline.MAX_CLIP_SECONDS,
    }
    return jsonify(progress)


# --------------------------------------------------------------------------- #
# Face
# --------------------------------------------------------------------------- #
@bp.post("/face")
@guards.role_required(Role.STUDENT)
@limiter.limit("20 per hour")
def enroll_face():
    """Submit 2-3 webcam frames; the averaged embedding replaces any previous one.

    Rate-limited because each call runs dlib's CNN-free HOG detector plus a 68-point
    landmark pass per sample. That is a second or two of CPU — cheap enough for a
    student enrolling once, expensive enough to be worth a ceiling.
    """
    student = _my_student()
    data = body()
    require(data, "samples")
    samples = _decode_samples(data["samples"], field="samples")
    result = enrollment_service.enroll_face(
        student=student, samples=samples, actor_id=guards.current_user_id()
    )
    return jsonify(result), 201


# --------------------------------------------------------------------------- #
# Voice
# --------------------------------------------------------------------------- #
@bp.post("/voice")
@guards.role_required(Role.STUDENT)
@limiter.limit("20 per hour")
def enroll_voice():
    """Submit passphrase recording(s) as 16 kHz mono WAV.

    The frontend converts MediaRecorder's WebM/Opus output to WAV in the browser
    (see ``frontend/src/lib/audio.js``). Doing it client-side means the server has
    no ffmpeg dependency, which is the single most annoying thing to require of
    someone setting this up locally.
    """
    student = _my_student()
    data = body()
    require(data, "samples")
    samples = _decode_samples(data["samples"], field="samples")
    result = enrollment_service.enroll_voice(
        student=student, samples=samples, actor_id=guards.current_user_id()
    )
    return jsonify(result), 201


# --------------------------------------------------------------------------- #
# Re-enrollment
# --------------------------------------------------------------------------- #
@bp.post("/reset")
@guards.role_required(Role.STUDENT)
@limiter.limit("10 per hour")
def reset():
    """Clear my own vectors so I can re-enroll.

    The brief calls for students to be able to re-enroll if recognition degrades
    (new glasses, a haircut, a cold changing their voice). No reason is required
    for acting on your own data, but the action is still audited.
    """
    student = _my_student()
    data = body()
    result = enrollment_service.reset_biometrics(
        student=student,
        face=bool(data.get("face", True)),
        voice=bool(data.get("voice", True)),
        actor_id=guards.current_user_id(),
        reason=clean_reason(data.get("reason"), required=False) or "Student re-enrollment",
    )
    return jsonify(result)


@bp.get("/passphrase")
@guards.role_required(Role.STUDENT)
def passphrase():
    """The phrase to read aloud, shown on the voice capture screen.

    Resemblyzer is text-independent — it models the speaker, not the words — so a
    fixed phrase is a UX device (it gives the student something to say and keeps
    sample length consistent), not a shared secret.
    """
    student = _my_student()
    return jsonify(
        {
            "passphrase": voice_pipeline.DEFAULT_PASSPHRASE,
            "min_voiced_seconds": voice_pipeline.MIN_VOICED_SECONDS,
            "max_clip_seconds": voice_pipeline.MAX_CLIP_SECONDS,
            "sample_rate": voice_pipeline.TARGET_SAMPLE_RATE,
            "already_enrolled": bool(student.get("voice_enrolled")),
            "note": (
                "Recognition matches your voice, not the words — read the phrase at a "
                "normal speaking pace."
            ),
        }
    )


@bp.get("/subjects")
@guards.role_required(Role.STUDENT)
def my_subjects():
    """Subjects I am enrolled in — shown alongside the enrollment prompt."""
    student = _my_student()
    subject_ids = attendance.enrolled_subject_ids(student["_id"])
    if not subject_ids:
        return jsonify({"subjects": []})
    subjects = list(
        db.subjects().find({"_id": {"$in": subject_ids}}, {"name": 1, "code": 1})
    )
    return jsonify(
        {
            "subjects": [
                {"id": str(s["_id"]), "name": s.get("name"), "code": s.get("code")}
                for s in subjects
            ]
        }
    )
