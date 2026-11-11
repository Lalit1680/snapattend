"""Biometric enrollment: samples in, embedding vectors out.

The write order here is deliberate and worth keeping:

1. Compute the embedding (pure, in-memory — ``pipelines.face`` / ``pipelines.voice``).
2. Upsert it into Chroma.
3. *Then* set the flag on the student document.

If step 2 fails, the flag stays false and the student is prompted to retry —
annoying but correct. If the order were reversed, a Chroma failure would leave a
student flagged as enrolled with no vector to match against, and they would
silently be marked absent from every class photo. The flag is the *claim*; the
vector is the *fact*, so the fact is written first.

The sample bytes themselves are never persisted. They arrive in the request body,
are turned into a vector, and go out of scope — see
``services/face_crop_store`` for the full retention inventory.
"""
from __future__ import annotations

import logging
from typing import Mapping, Optional, Sequence

from bson import ObjectId

from .. import db, vector_store
from ..models.constants import AuditAction, EnrollmentStatus
from ..pipelines import face as face_pipeline
from ..pipelines import voice as voice_pipeline
from ..utils.errors import ApiError, bad_request, unprocessable
from ..utils.timeutil import utcnow
from . import audit

log = logging.getLogger(__name__)

# The brief specifies 2-3 webcam samples for face enrollment.
MIN_FACE_SAMPLES = 2
MAX_FACE_SAMPLES = 5
MIN_VOICE_SAMPLES = 1
MAX_VOICE_SAMPLES = 3


def _rejection_payload(rejections: Sequence) -> list[dict]:
    return [
        {"index": r.index, "reason": r.reason, "message": r.message} for r in rejections
    ]


def _set_status(student_id: ObjectId) -> str:
    """Recompute and persist ``enrollment_status`` from the biometric flags.

    ``COMPLETE`` requires both modalities because the enrollment wizard collects
    both, and a student with only a face vector cannot check in to a voice-mode
    session.
    """
    student = db.students().find_one(
        {"_id": student_id}, {"face_enrolled": 1, "voice_enrolled": 1}
    )
    if not student:
        return EnrollmentStatus.INVITED
    status = (
        EnrollmentStatus.COMPLETE
        if student.get("face_enrolled") and student.get("voice_enrolled")
        else EnrollmentStatus.PENDING_BIOMETRICS
    )
    db.students().update_one(
        {"_id": student_id},
        {"$set": {"enrollment_status": status, "updated_at": utcnow()}},
    )
    return status


# --------------------------------------------------------------------------- #
# Face
# --------------------------------------------------------------------------- #
def enroll_face(
    *,
    student: Mapping,
    samples: Sequence[bytes],
    actor_id: Optional[ObjectId] = None,
) -> dict:
    """Average 2-3 webcam captures into one face vector and store it."""
    if len(samples) < MIN_FACE_SAMPLES:
        raise bad_request(
            f"At least {MIN_FACE_SAMPLES} face samples are required (received {len(samples)})."
        )
    if len(samples) > MAX_FACE_SAMPLES:
        samples = list(samples)[:MAX_FACE_SAMPLES]

    student_id: ObjectId = student["_id"]
    institution_id: ObjectId = student["institution_id"]

    try:
        result = face_pipeline.enroll_face_samples(samples, min_accepted=MIN_FACE_SAMPLES)
    except face_pipeline.FacePipelineError as exc:
        raise ApiError(str(exc), 503, code="face_pipeline_unavailable")

    if not result.ok or not result.embedding:
        # 422: the request was well-formed, the *content* was not usable. The
        # per-sample rejections tell the UI exactly which capture to retake.
        raise unprocessable(
            result.message,
            rejections=_rejection_payload(result.rejections),
            accepted_samples=result.accepted_samples,
            required_samples=MIN_FACE_SAMPLES,
        )

    vector_store.upsert_face_embedding(str(student_id), str(institution_id), result.embedding)

    db.students().update_one(
        {"_id": student_id},
        {
            "$set": {
                "face_enrolled": True,
                "face_sample_count": result.accepted_samples,
                "face_enrolled_at": utcnow(),
                "updated_at": utcnow(),
            }
        },
    )
    status = _set_status(student_id)

    audit.record(
        institution_id=institution_id,
        actor_id=actor_id or student.get("user_id"),
        action=AuditAction.BIOMETRIC_ENROLLED,
        target_id=student_id,
        target_type="student",
        new_state={"face_enrolled": True, "enrollment_status": status},
        metadata={
            "modality": "face",
            "samples_accepted": result.accepted_samples,
            "samples_submitted": len(samples),
            "consistency": result.consistency,
        },
    )

    return {
        "ok": True,
        "message": result.message,
        "modality": "face",
        "samples_accepted": result.accepted_samples,
        "consistency": result.consistency,
        "rejections": _rejection_payload(result.rejections),
        "enrollment_status": status,
    }


# --------------------------------------------------------------------------- #
# Voice
# --------------------------------------------------------------------------- #
def enroll_voice(
    *,
    student: Mapping,
    samples: Sequence[bytes],
    actor_id: Optional[ObjectId] = None,
) -> dict:
    """Turn passphrase recordings into one voice vector and store it."""
    if len(samples) < MIN_VOICE_SAMPLES:
        raise bad_request("At least one voice recording is required.")
    if len(samples) > MAX_VOICE_SAMPLES:
        samples = list(samples)[:MAX_VOICE_SAMPLES]

    student_id: ObjectId = student["_id"]
    institution_id: ObjectId = student["institution_id"]

    try:
        result = voice_pipeline.enroll_voice_samples(samples, min_accepted=MIN_VOICE_SAMPLES)
    except voice_pipeline.VoicePipelineError as exc:
        raise ApiError(str(exc), 503, code="voice_pipeline_unavailable")

    if not result.ok or not result.embedding:
        raise unprocessable(
            result.message,
            rejections=_rejection_payload(result.rejections),
            accepted_samples=result.accepted_samples,
        )

    vector_store.upsert_voice_embedding(str(student_id), str(institution_id), result.embedding)

    db.students().update_one(
        {"_id": student_id},
        {
            "$set": {
                "voice_enrolled": True,
                "voice_sample_count": result.accepted_samples,
                "voice_enrolled_at": utcnow(),
                "updated_at": utcnow(),
            }
        },
    )
    status = _set_status(student_id)

    audit.record(
        institution_id=institution_id,
        actor_id=actor_id or student.get("user_id"),
        action=AuditAction.BIOMETRIC_ENROLLED,
        target_id=student_id,
        target_type="student",
        new_state={"voice_enrolled": True, "enrollment_status": status},
        metadata={
            "modality": "voice",
            "samples_accepted": result.accepted_samples,
            "duration_seconds": result.duration_seconds,
            "consistency": result.consistency,
        },
    )

    return {
        "ok": True,
        "message": result.message,
        "modality": "voice",
        "samples_accepted": result.accepted_samples,
        "duration_seconds": result.duration_seconds,
        "consistency": result.consistency,
        "rejections": _rejection_payload(result.rejections),
        "enrollment_status": status,
        "passphrase": voice_pipeline.DEFAULT_PASSPHRASE,
    }


# --------------------------------------------------------------------------- #
# Reset / re-enrollment
# --------------------------------------------------------------------------- #
def reset_biometrics(
    *,
    student: Mapping,
    face: bool = True,
    voice: bool = True,
    actor_id: Optional[ObjectId] = None,
    reason: Optional[str] = None,
) -> dict:
    """Delete a student's vectors so they can re-enroll.

    Used both by the student ("my glasses/haircut changed") and by staff. The
    vector is removed from Chroma, not merely unflagged — leaving an orphaned
    vector behind would keep matching a face the student has asked us to forget.
    """
    student_id: ObjectId = student["_id"]
    institution_id: ObjectId = student["institution_id"]

    vector_store.delete_student_embeddings(str(student_id), face=face, voice=voice)

    updates: dict = {"updated_at": utcnow()}
    if face:
        updates.update(
            {"face_enrolled": False, "face_sample_count": 0, "face_enrolled_at": None}
        )
    if voice:
        updates.update(
            {"voice_enrolled": False, "voice_sample_count": 0, "voice_enrolled_at": None}
        )
    db.students().update_one({"_id": student_id}, {"$set": updates})
    status = _set_status(student_id)

    audit.record(
        institution_id=institution_id,
        actor_id=actor_id,
        action=AuditAction.BIOMETRIC_RESET,
        target_id=student_id,
        target_type="student",
        reason=reason,
        previous_state={
            "face_enrolled": bool(student.get("face_enrolled")),
            "voice_enrolled": bool(student.get("voice_enrolled")),
        },
        new_state={
            "face_enrolled": False if face else bool(student.get("face_enrolled")),
            "voice_enrolled": False if voice else bool(student.get("voice_enrolled")),
        },
        metadata={"face": face, "voice": voice},
    )

    return {
        "ok": True,
        "message": "Biometric data cleared. You can enroll again from your dashboard.",
        "enrollment_status": status,
        "face_cleared": face,
        "voice_cleared": voice,
    }


# --------------------------------------------------------------------------- #
# Status
# --------------------------------------------------------------------------- #
def enrollment_progress(student: Mapping) -> dict:
    """What the student still owes us — drives the enrollment wizard's steps.

    ``vector_present`` is read back from Chroma rather than trusted from the flag,
    so the rare drift case (vector deleted out-of-band) shows up in the UI as
    "re-enroll" instead of as mysteriously failed recognition.
    """
    student_id = str(student["_id"])
    face_flag = bool(student.get("face_enrolled"))
    voice_flag = bool(student.get("voice_enrolled"))

    face_vector = (
        vector_store.has_embedding(vector_store.FACE_COLLECTION, student_id)
        if face_flag
        else False
    )
    voice_vector = (
        vector_store.has_embedding(vector_store.VOICE_COLLECTION, student_id)
        if voice_flag
        else False
    )

    steps = [
        {
            "key": "face",
            "label": "Face samples",
            "done": face_flag and face_vector,
            "detail": f"{student.get('face_sample_count', 0)} sample(s) on file",
            "required_samples": MIN_FACE_SAMPLES,
            "drift": face_flag and not face_vector,
        },
        {
            "key": "voice",
            "label": "Voice passphrase",
            "done": voice_flag and voice_vector,
            "detail": f"{student.get('voice_sample_count', 0)} recording(s) on file",
            "required_samples": MIN_VOICE_SAMPLES,
            "drift": voice_flag and not voice_vector,
        },
    ]
    return {
        "student_id": student_id,
        "enrollment_status": student.get("enrollment_status"),
        "complete": all(s["done"] for s in steps),
        "steps": steps,
        "passphrase": voice_pipeline.DEFAULT_PASSPHRASE,
    }
