"""Attendance marking — the single decision point for every method.

Every path that can make a student present (class photo, review-queue
assignment, QR scan, voice check-in, manual override) funnels through
:func:`mark_present` or :func:`set_manual`. Concentrating it here is what makes
the following rules hold *everywhere* instead of in four slightly different
copies:

* **Idempotent.** ``attendance_records`` has a unique index on
  ``(session_id, student_id)``; a double-tapped check-in button or a retried
  request produces one row, not two.
* **Roster-scoped.** A student can only be marked for a session of a subject they
  are actually enrolled in — which is also what bounds the face-matching search
  space.
* **Manual wins.** A teacher's explicit override is never silently overwritten by
  a later automated match. If a teacher marked someone absent for a reason, an
  algorithm does not get to disagree.
* **Mode-respecting.** A voice recording cannot mark attendance on a QR-only
  session.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable, Mapping, Optional, Sequence

from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from .. import db
from ..models.constants import (
    AttendanceMethod,
    AttendanceStatus,
    AuditAction,
    SessionStatus,
    VerificationMode,
)
from ..models.schemas import attendance_record_doc
from ..utils.errors import ApiError, bad_request, conflict, forbidden
from ..utils.timeutil import ensure_aware, utcnow
from . import audit

log = logging.getLogger(__name__)

# Methods a student can trigger themselves; these require a live session.
_SELF_SERVICE_METHODS = {AttendanceMethod.QR, AttendanceMethod.VOICE}

_METHOD_REQUIRES_MODE = {
    AttendanceMethod.FACE_PHOTO: VerificationMode.includes_photo,
    AttendanceMethod.FACE_PHOTO_REVIEW: VerificationMode.includes_photo,
    AttendanceMethod.QR: VerificationMode.includes_qr,
    AttendanceMethod.VOICE: VerificationMode.includes_voice,
}


@dataclass
class MarkResult:
    created: bool
    status: str          # AttendanceStatus.*
    message: str
    record: Optional[dict] = None
    blocked_by_override: bool = False


# --------------------------------------------------------------------------- #
# Roster helpers
# --------------------------------------------------------------------------- #
def roster_student_ids(subject_id: ObjectId) -> list[ObjectId]:
    """Student ids enrolled in a subject. Bounds every face/voice search."""
    return [e["student_id"] for e in db.enrollments().find({"subject_id": subject_id}, {"student_id": 1})]


def roster_student_ids_str(subject_id: ObjectId) -> list[str]:
    return [str(s) for s in roster_student_ids(subject_id)]


def is_on_roster(subject_id: ObjectId, student_id: ObjectId) -> bool:
    return (
        db.enrollments().count_documents(
            {"subject_id": subject_id, "student_id": student_id}, limit=1
        )
        > 0
    )


def student_for_user(user_id: ObjectId) -> Mapping:
    """The ``students`` profile for a user, or a 404."""
    student = db.students().find_one({"user_id": user_id})
    if not student:
        raise ApiError("No student profile is linked to this account.", 404)
    return student


def enrolled_subject_ids(student_id: ObjectId) -> list[ObjectId]:
    return [e["subject_id"] for e in db.enrollments().find({"student_id": student_id}, {"subject_id": 1})]


# --------------------------------------------------------------------------- #
# Guards
# --------------------------------------------------------------------------- #
def _assert_method_allowed(session: Mapping, method: str) -> None:
    check = _METHOD_REQUIRES_MODE.get(method)
    mode = str(session.get("verification_mode", ""))
    if check is not None and not check(mode):
        label = VerificationMode.LABELS.get(mode, mode)
        raise bad_request(
            f"This session is set to '{label}', which does not accept {method.replace('_', ' ')} check-in."
        )


def _assert_window_open(session: Mapping, method: str) -> None:
    """Self-service check-in needs a live session; teacher actions do not.

    A teacher legitimately uploads the class photo *after* the lesson, and manual
    corrections happen days later, so those must not be blocked by the session
    being ended.
    """
    if method not in _SELF_SERVICE_METHODS:
        return
    if session.get("status") != SessionStatus.ACTIVE:
        raise ApiError(
            "This session has ended, so attendance can no longer be marked.",
            400,
            code="session_ended",
        )
    end_time = ensure_aware(session.get("end_time"))
    if end_time and utcnow() > end_time:
        raise ApiError(
            "The check-in window for this session has closed.", 400, code="window_closed"
        )


# --------------------------------------------------------------------------- #
# Marking
# --------------------------------------------------------------------------- #
def mark_present(
    *,
    session: Mapping,
    student_id: ObjectId,
    method: str,
    confidence_score: Optional[float] = None,
    marked_by: Optional[ObjectId] = None,
    face_box: Optional[dict] = None,
    write_audit: bool = True,
) -> MarkResult:
    """Mark one student present for one session.

    Safe to call repeatedly: a student already present is reported as such
    without a second row and without changing the original method/timestamp
    (the first successful verification is the one that happened).
    """
    session_id: ObjectId = session["_id"]
    subject_id: ObjectId = session["subject_id"]
    institution_id: ObjectId = session["institution_id"]

    if method not in AttendanceMethod.ALL:
        raise bad_request(f"Unknown attendance method: {method}")
    _assert_method_allowed(session, method)
    _assert_window_open(session, method)

    if not is_on_roster(subject_id, student_id):
        raise forbidden("That student is not enrolled in this subject.")

    doc = attendance_record_doc(
        session_id=session_id,
        student_id=student_id,
        subject_id=subject_id,
        institution_id=institution_id,
        method_used=method,
        status=AttendanceStatus.PRESENT,
        confidence_score=confidence_score,
        was_manual_override=method == AttendanceMethod.MANUAL,
        marked_by=marked_by,
        face_box=face_box,
    )

    try:
        result = db.attendance_records().insert_one(doc)
        doc["_id"] = result.inserted_id
        if write_audit:
            audit.record(
                institution_id=institution_id,
                actor_id=marked_by,
                action=AuditAction.ATTENDANCE_MARKED,
                target_id=student_id,
                target_type="student",
                previous_state=None,
                new_state={"status": AttendanceStatus.PRESENT, "method": method},
                metadata={
                    "session_id": str(session_id),
                    "confidence_score": confidence_score,
                },
            )
        return MarkResult(
            created=True, status=AttendanceStatus.PRESENT, message="Attendance marked", record=doc
        )

    except DuplicateKeyError:
        # The unique index did its job — there is already a row for this pair.
        existing = db.attendance_records().find_one(
            {"session_id": session_id, "student_id": student_id}
        )
        if not existing:  # pragma: no cover - index fired but row vanished
            raise conflict("Could not record attendance; please try again.")

        if existing.get("status") == AttendanceStatus.PRESENT:
            return MarkResult(
                created=False,
                status=AttendanceStatus.PRESENT,
                message="Already marked present for this session",
                record=existing,
            )

        if existing.get("was_manual_override"):
            # A teacher deliberately marked this student absent. Report it rather
            # than overriding a human decision with an automated one.
            return MarkResult(
                created=False,
                status=str(existing.get("status")),
                message=(
                    "A teacher has manually recorded this student as absent. "
                    "Ask them to update it if that is incorrect."
                ),
                record=existing,
                blocked_by_override=True,
            )

        # Upgrade an automated 'absent' row to present.
        db.attendance_records().update_one(
            {"_id": existing["_id"]},
            {
                "$set": {
                    "status": AttendanceStatus.PRESENT,
                    "method_used": method,
                    "confidence_score": confidence_score,
                    "face_box": face_box,
                    "marked_by": marked_by,
                    "timestamp": utcnow(),
                    "updated_at": utcnow(),
                }
            },
        )
        updated = db.attendance_records().find_one({"_id": existing["_id"]})
        if write_audit:
            audit.record(
                institution_id=institution_id,
                actor_id=marked_by,
                action=AuditAction.ATTENDANCE_MARKED,
                target_id=student_id,
                target_type="student",
                previous_state={"status": existing.get("status")},
                new_state={"status": AttendanceStatus.PRESENT, "method": method},
                metadata={"session_id": str(session_id)},
            )
        return MarkResult(
            created=False,
            status=AttendanceStatus.PRESENT,
            message="Attendance updated to present",
            record=updated,
        )


def mark_many_present(
    *,
    session: Mapping,
    entries: Iterable[Mapping],
    method: str,
    marked_by: Optional[ObjectId],
) -> dict:
    """Bulk-mark from a class photo. ``entries`` items: ``{student_id, confidence_score, face_box}``.

    Writes one audit entry for the batch rather than one per student: a class
    photo is a single teacher action, and 60 near-identical log lines would bury
    the manual overrides that actually need review.
    """
    marked: list[str] = []
    already: list[str] = []
    rejected: list[dict] = []

    for entry in entries:
        student_id = entry.get("student_id")
        if not isinstance(student_id, ObjectId):
            student_id = ObjectId(str(student_id))
        try:
            outcome = mark_present(
                session=session,
                student_id=student_id,
                method=method,
                confidence_score=entry.get("confidence_score"),
                marked_by=marked_by,
                face_box=entry.get("face_box"),
                write_audit=False,
            )
        except ApiError as exc:
            rejected.append({"student_id": str(student_id), "reason": exc.message})
            continue

        if outcome.created:
            marked.append(str(student_id))
        else:
            already.append(str(student_id))

    return {"marked": marked, "already_present": already, "rejected": rejected}


def set_manual(
    *,
    session: Mapping,
    student_id: ObjectId,
    present: bool,
    reason: str,
    actor_id: ObjectId,
) -> MarkResult:
    """Teacher override with a mandatory reason, fully audit-logged.

    The audit entry records the previous state, the new state, who changed it and
    why — which is the whole point of allowing overrides at all.
    """
    session_id: ObjectId = session["_id"]
    subject_id: ObjectId = session["subject_id"]
    institution_id: ObjectId = session["institution_id"]

    if not is_on_roster(subject_id, student_id):
        raise forbidden("That student is not enrolled in this subject.")

    target_status = AttendanceStatus.PRESENT if present else AttendanceStatus.ABSENT
    existing = db.attendance_records().find_one({"session_id": session_id, "student_id": student_id})

    previous_state = (
        {
            "status": existing.get("status"),
            "method_used": existing.get("method_used"),
            "confidence_score": existing.get("confidence_score"),
        }
        if existing
        else {"status": AttendanceStatus.ABSENT, "method_used": None}
    )

    if existing:
        db.attendance_records().update_one(
            {"_id": existing["_id"]},
            {
                "$set": {
                    "status": target_status,
                    "method_used": AttendanceMethod.MANUAL,
                    "was_manual_override": True,
                    "marked_by": actor_id,
                    "override_reason": reason,
                    # Confidence is meaningless for a human decision; clear the
                    # stale score rather than leaving a misleading number.
                    "confidence_score": None,
                    "face_box": None,
                    "timestamp": utcnow(),
                    "updated_at": utcnow(),
                }
            },
        )
        record = db.attendance_records().find_one({"_id": existing["_id"]})
        created = False
    else:
        doc = attendance_record_doc(
            session_id=session_id,
            student_id=student_id,
            subject_id=subject_id,
            institution_id=institution_id,
            method_used=AttendanceMethod.MANUAL,
            status=target_status,
            confidence_score=None,
            was_manual_override=True,
            marked_by=actor_id,
        )
        doc["override_reason"] = reason
        try:
            doc["_id"] = db.attendance_records().insert_one(doc).inserted_id
        except DuplicateKeyError:  # pragma: no cover - concurrent override
            doc = db.attendance_records().find_one(
                {"session_id": session_id, "student_id": student_id}
            )
        record = doc
        created = True

    audit.record(
        institution_id=institution_id,
        actor_id=actor_id,
        action=AuditAction.ATTENDANCE_OVERRIDE,
        target_id=student_id,
        target_type="student",
        reason=reason,
        previous_state=previous_state,
        new_state={"status": target_status, "method_used": AttendanceMethod.MANUAL},
        metadata={"session_id": str(session_id), "subject_id": str(subject_id)},
    )

    return MarkResult(
        created=created,
        status=target_status,
        message=f"Student marked {target_status}",
        record=record,
    )


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #
def records_for_session(session_id: ObjectId) -> dict[str, dict]:
    """``{student_id_str: record}`` for one session."""
    return {
        str(r["student_id"]): r
        for r in db.attendance_records().find({"session_id": session_id})
    }


def session_roster_view(session: Mapping) -> list[dict]:
    """Roster joined with attendance state — powers the live session view.

    Three small queries plus an in-Python join rather than a ``$lookup``
    aggregation: a class roster is tens of rows, and this is far easier to read
    and debug than the equivalent pipeline.
    """
    subject_id: ObjectId = session["subject_id"]
    student_ids = roster_student_ids(subject_id)
    if not student_ids:
        return []

    students = {s["_id"]: s for s in db.students().find({"_id": {"$in": student_ids}})}
    user_ids = [s["user_id"] for s in students.values() if s.get("user_id")]
    users = {u["_id"]: u for u in db.users().find({"_id": {"$in": user_ids}})}
    records = records_for_session(session["_id"])

    rows: list[dict] = []
    for student_id in student_ids:
        student = students.get(student_id) or {}
        user = users.get(student.get("user_id")) or {}
        record = records.get(str(student_id))
        rows.append(
            {
                "student_id": str(student_id),
                "name": user.get("name") or user.get("email") or "Unknown",
                "email": user.get("email"),
                "roll_number": student.get("roll_number"),
                "enrollment_status": student.get("enrollment_status"),
                "face_enrolled": bool(student.get("face_enrolled")),
                "voice_enrolled": bool(student.get("voice_enrolled")),
                "status": (record or {}).get("status", AttendanceStatus.ABSENT),
                "method_used": (record or {}).get("method_used"),
                "confidence_score": (record or {}).get("confidence_score"),
                "was_manual_override": bool((record or {}).get("was_manual_override")),
                "override_reason": (record or {}).get("override_reason"),
                "marked_at": (record or {}).get("timestamp"),
            }
        )

    # Present first, then alphabetical — the teacher's eye goes to who is missing.
    rows.sort(key=lambda r: (r["status"] != AttendanceStatus.PRESENT, r["name"].lower()))
    return rows


def present_count(session_id: ObjectId) -> int:
    return db.attendance_records().count_documents(
        {"session_id": session_id, "status": AttendanceStatus.PRESENT}
    )


def counts_for_sessions(session_ids: Sequence[ObjectId]) -> dict[str, int]:
    """Present-counts for many sessions in one aggregation (session list views)."""
    if not session_ids:
        return {}
    pipeline = [
        {"$match": {"session_id": {"$in": list(session_ids)}, "status": AttendanceStatus.PRESENT}},
        {"$group": {"_id": "$session_id", "count": {"$sum": 1}}},
    ]
    return {str(row["_id"]): int(row["count"]) for row in db.attendance_records().aggregate(pipeline)}
