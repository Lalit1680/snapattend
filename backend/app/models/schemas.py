"""Document factories — the authoritative MongoDB schema.

MongoDB will happily accept whatever you hand it, which is exactly why every
insert in SnapAttend goes through a factory here. The benefit is concrete: a new
field gets a default on *every* document from day one, and reading this file
tells a new engineer the full data model without grepping for ``insert_one``.

Indexes for these collections live in :mod:`app.db`.
"""
from __future__ import annotations

from typing import Any, Optional, Sequence

from bson import ObjectId

from ..utils.timeutil import utcnow
from .constants import (
    AttendanceStatus,
    EnrollmentStatus,
    InviteStatus,
    PhotoReviewStatus,
    SessionStatus,
    UserStatus,
)


def institution_doc(*, name: str, slug: str, owner_user_id: Optional[ObjectId] = None) -> dict:
    return {
        "name": name,
        "slug": slug,
        "owner_user_id": owner_user_id,
        "settings": {
            # Institution-wide default; a subject may override it.
            "attendance_threshold": 75.0,
            # Master switch for the low-attendance alert cron.
            "low_attendance_alerts_enabled": True,
            # Minimum days between repeat alerts to the same student/subject.
            "alert_cooldown_days": 7,
        },
        "created_at": utcnow(),
    }


def user_doc(
    *,
    email: str,
    name: str,
    role: str,
    institution_id: ObjectId,
    password_hash: Optional[str] = None,
    status: str = UserStatus.INVITED,
) -> dict:
    return {
        "email": email,               # lowercased; unique index
        "name": name,
        "role": role,                 # admin | teacher | student
        "institution_id": institution_id,
        "password_hash": password_hash,  # None until the invite is accepted
        "status": status,
        "created_at": utcnow(),
        "updated_at": utcnow(),
        "last_login_at": None,
    }


def student_doc(*, user_id: ObjectId, institution_id: ObjectId, roll_number: str | None = None) -> dict:
    """Student profile.

    Deliberately holds **no vectors**. The face/voice embeddings live in Chroma
    keyed by this document's ``_id`` (stringified), so ``chroma_id`` is derivable
    rather than stored — one less field that can drift out of sync.
    """
    return {
        "user_id": user_id,           # -> users._id (role=student), unique
        "institution_id": institution_id,
        "roll_number": roll_number,
        "enrollment_status": EnrollmentStatus.INVITED,
        "face_enrolled": False,
        "voice_enrolled": False,
        "face_sample_count": 0,
        "voice_sample_count": 0,
        "face_enrolled_at": None,
        "voice_enrolled_at": None,
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }


def subject_doc(
    *,
    name: str,
    code: str,
    institution_id: ObjectId,
    teacher_ids: Sequence[ObjectId],
    attendance_threshold: float | None = None,
) -> dict:
    return {
        "name": name,
        "code": code,                 # unique per institution
        "institution_id": institution_id,
        "teacher_ids": list(teacher_ids),
        # None => inherit the institution setting at read time.
        "attendance_threshold": attendance_threshold,
        "archived": False,
        "created_at": utcnow(),
        "updated_at": utcnow(),
    }


def enrollment_doc(*, subject_id: ObjectId, student_id: ObjectId, institution_id: ObjectId) -> dict:
    """Roster membership: which students are in which subject.

    Kept as its own collection rather than an array on ``subjects`` because the
    class-photo pipeline queries it constantly ("who could this face be?") and an
    unbounded array on a hot document is a growth problem waiting to happen.
    """
    return {
        "subject_id": subject_id,
        "student_id": student_id,
        "institution_id": institution_id,
        "created_at": utcnow(),
    }


def session_doc(
    *,
    subject_id: ObjectId,
    teacher_id: ObjectId,
    institution_id: ObjectId,
    verification_mode: str,
    start_time: Any,
    end_time: Any,
    title: str | None = None,
) -> dict:
    return {
        "subject_id": subject_id,
        "teacher_id": teacher_id,
        "institution_id": institution_id,
        "title": title,
        "verification_mode": verification_mode,
        "start_time": start_time,
        "end_time": end_time,
        "status": SessionStatus.ACTIVE,
        # --- rotating QR state (see services/qr.py) ---
        "qr_current_token": None,
        "qr_current_nonce": None,
        # Previous nonce is retained for one rotation so a scan that lands on the
        # boundary still succeeds instead of failing for no user-visible reason.
        "qr_previous_nonce": None,
        "qr_token_expiry": None,
        # --- class-photo pipeline state ---
        "photo_review_status": PhotoReviewStatus.NONE,
        "photo_processed_at": None,
        "photo_stats": None,          # {faces_detected, auto_matched, needs_review}
        "created_at": utcnow(),
        "updated_at": utcnow(),
        "ended_at": None,
    }


def attendance_record_doc(
    *,
    session_id: ObjectId,
    student_id: ObjectId,
    subject_id: ObjectId,
    institution_id: ObjectId,
    method_used: str,
    status: str = AttendanceStatus.PRESENT,
    confidence_score: float | None = None,
    was_manual_override: bool = False,
    marked_by: ObjectId | None = None,
    face_box: dict | None = None,
) -> dict:
    """One row per (session, student) — enforced by a unique index.

    ``face_box`` records *which* detected face in the class photo produced this
    match (coordinates only, never pixels), so a teacher auditing a session can
    see the match was positional and not a duplicate of another student.
    """
    return {
        "session_id": session_id,
        "student_id": student_id,
        "subject_id": subject_id,
        "institution_id": institution_id,
        "timestamp": utcnow(),
        "method_used": method_used,
        "status": status,
        "confidence_score": confidence_score,
        "was_manual_override": was_manual_override,
        "marked_by": marked_by,       # teacher id for manual/review actions, else None
        "face_box": face_box,
        "updated_at": utcnow(),
    }


def pending_face_match_doc(
    *,
    session_id: ObjectId,
    institution_id: ObjectId,
    subject_id: ObjectId,
    crop_jpeg_b64: str,
    face_box: dict,
    best_guess_student_id: ObjectId | None,
    confidence_score: float | None,
    distance: float | None,
    reason: str,
    expires_at: Any,
) -> dict:
    """A face from the class photo that could not be auto-matched.

    ``crop_jpeg_b64`` is the only place a face image is persisted at all, and it
    is scrubbed the moment the teacher resolves the item (or by the TTL index at
    ``expires_at``, whichever comes first). Nothing else in the system stores
    pixels.
    """
    return {
        "session_id": session_id,
        "institution_id": institution_id,
        "subject_id": subject_id,
        "crop_jpeg_b64": crop_jpeg_b64,
        "crop_discarded": False,
        "face_box": face_box,         # {top, right, bottom, left, width, height}
        "best_guess_student_id": best_guess_student_id,
        "confidence_score": confidence_score,
        "distance": distance,
        "reason": reason,             # ReviewReason.*
        "resolved": False,
        "resolution": None,           # ReviewResolution.*
        "assigned_student_id": None,
        "resolved_by": None,
        "resolved_at": None,
        "created_at": utcnow(),
        "expires_at": expires_at,     # TTL index deletes the doc at this time
    }


def audit_log_doc(
    *,
    institution_id: ObjectId,
    actor_id: ObjectId | None,
    action: str,
    target_id: Any = None,
    target_type: str | None = None,
    reason: str | None = None,
    previous_state: Any = None,
    new_state: Any = None,
    metadata: dict | None = None,
) -> dict:
    return {
        "institution_id": institution_id,
        "actor_id": actor_id,         # None for system/cron actions
        "action": action,             # AuditAction.*
        "target_id": target_id,
        "target_type": target_type,
        "reason": reason,
        "previous_state": previous_state,
        "new_state": new_state,
        "metadata": metadata or {},
        "timestamp": utcnow(),
    }


def invite_doc(
    *,
    email: str,
    institution_id: ObjectId,
    invite_type: str,
    token_hash: str,
    invited_by: ObjectId | None,
    user_id: ObjectId | None,
    expires_at: Any,
) -> dict:
    """An outstanding email invite.

    Only the token's SHA-256 is stored (see ``utils/tokens.token_fingerprint``),
    so the row is useful for tracking and revocation but useless for forging a
    working link.
    """
    return {
        "email": email,
        "institution_id": institution_id,
        "invite_type": invite_type,   # teacher | student
        "token_hash": token_hash,     # unique index
        "status": InviteStatus.PENDING,
        "invited_by": invited_by,
        "user_id": user_id,           # pre-created user row this invite activates
        "created_at": utcnow(),
        "expires_at": expires_at,
        "accepted_at": None,
        "sent_count": 1,
    }


def alert_log_doc(
    *,
    institution_id: ObjectId,
    student_id: ObjectId,
    subject_id: ObjectId,
    percentage: float,
    threshold: float,
) -> dict:
    return {
        "institution_id": institution_id,
        "student_id": student_id,
        "subject_id": subject_id,
        "percentage": percentage,
        "threshold": threshold,
        "sent_at": utcnow(),
    }
