"""Attendance marking: QR check-in, voice check-in, and manual override.

Three distinct actors write attendance, and they get three distinct endpoints
rather than one polymorphic one:

* a **student** scanning a QR code (``POST /qr``)
* a **student** speaking their passphrase (``POST /voice``)
* a **teacher** correcting the record (``POST /override``)

Keeping them separate is what makes the authorisation obvious at a glance: the
student endpoints can only ever mark *the caller* present, so there is no
``student_id`` parameter to forget to validate. The teacher endpoint takes a
``student_id`` and a mandatory reason, and every call lands in the audit log.

Both self-service endpoints are rate-limited, per the brief. The teacher's
override is not — a teacher fixing a roster of thirty students should not hit a
wall halfway through.
"""
from __future__ import annotations

import base64
import binascii
import logging

from flask import Blueprint, jsonify, request

from .. import db
from ..auth import guards
from ..extensions import limiter
from ..models.constants import (
    AttendanceMethod,
    AttendanceStatus,
    Role,
    SessionStatus,
    VerificationMode,
)
from ..pipelines import voice as voice_pipeline
from ..services import analytics, attendance, qr
from ..utils.errors import ApiError, bad_request, forbidden
from ..utils.serialization import oid
from ..utils.timeutil import ensure_aware, iso, utcnow
from ..utils.validators import body, clamp_int, clean_reason, require
from ._helpers import csv_response, date_range, timestamped

log = logging.getLogger(__name__)

bp = Blueprint("attendance", __name__, url_prefix="/api/attendance")

# A 10-second 16 kHz mono WAV is ~320 KB. 4 MB is a wide margin that still refuses
# someone uploading a music file.
MAX_AUDIO_BYTES = 4 * 1024 * 1024


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #
def _me() -> dict:
    """The ``students`` profile for the signed-in student."""
    return attendance.student_for_user(guards.current_user_id())


def _decode_audio(raw) -> bytes:
    """Decode a base64 / data-URL WAV payload from the request body."""
    if not isinstance(raw, str) or not raw.strip():
        raise bad_request("audio must be a base64-encoded WAV string")
    payload = raw.strip()
    if payload.startswith("data:"):
        _, _, payload = payload.partition(",")
    payload += "=" * (-len(payload) % 4)
    try:
        decoded = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError):
        raise bad_request("audio is not valid base64")
    if not decoded:
        raise bad_request("The recording was empty. Try again and speak clearly.")
    if len(decoded) > MAX_AUDIO_BYTES:
        raise bad_request(
            f"Recording is larger than {MAX_AUDIO_BYTES // (1024 * 1024)} MB. "
            f"Keep it under {int(voice_pipeline.MAX_CLIP_SECONDS)} seconds."
        )
    return decoded


def _assert_session_open(session) -> None:
    """Early-out before spending CPU on a session that cannot accept a check-in.

    ``attendance.mark_present`` enforces this authoritatively; this is a cheap
    pre-check so the voice route does not run a Resemblyzer embedding only to
    discover the window closed. Both raise the same codes, so the client sees one
    behaviour either way.
    """
    if session.get("status") == SessionStatus.ENDED:
        raise ApiError(
            "This session has ended, so check-in is closed. Speak to your teacher.",
            409,
            code="session_ended",
        )
    end = ensure_aware(session.get("end_time"))
    if end and end < utcnow():
        raise ApiError(
            "This session's check-in window has closed. Speak to your teacher.",
            409,
            code="window_closed",
        )


def _mark_result_response(result, session, *, method: str) -> tuple:
    """Uniform response for a self-service check-in attempt.

    Three outcomes, all HTTP 200:

    * newly marked present — ``result.created``
    * *already* present — a repeat tap or a retried request. Not an error: the
      student did nothing wrong and an error page would send them to find a
      teacher.
    * blocked by a teacher's manual override — the student is **still absent**.
      Reporting success here would be a lie, so ``ok`` is false and the message
      explains who to talk to.
    """
    subject = db.subjects().find_one({"_id": session["subject_id"]}, {"name": 1, "code": 1})
    record = result.record or {}
    return (
        jsonify(
            {
                "ok": not result.blocked_by_override,
                "status": result.status,
                "created": result.created,
                "already_present": (
                    not result.created
                    and result.status == AttendanceStatus.PRESENT
                    and not result.blocked_by_override
                ),
                "blocked_by_override": result.blocked_by_override,
                "method": record.get("method_used") or method,
                "confidence_score": record.get("confidence_score"),
                "marked_at": iso(ensure_aware(record.get("timestamp"))),
                "session": {
                    "id": str(session["_id"]),
                    "title": session.get("title"),
                    "subject": (subject or {}).get("name"),
                    "subject_code": (subject or {}).get("code"),
                },
                "message": result.message,
            }
        ),
        200,
    )


# --------------------------------------------------------------------------- #
# Student: QR check-in
# --------------------------------------------------------------------------- #
@bp.post("/qr")
@guards.role_required(Role.STUDENT)
@limiter.limit("20 per minute; 200 per hour")
def check_in_qr():
    """Redeem a scanned QR token to mark myself present.

    The token carries the session id, an expiry and a rotating nonce, all signed.
    ``qr.resolve_token`` is what validates every one of those — this route never
    trusts a session id from the client, only the one the signature vouches for.
    That is the whole point of the design: a screenshot of yesterday's code, or of
    the code from thirty seconds ago, resolves to nothing.

    Rate-limited generously rather than tightly: a lecture hall of students all
    scanning at once is the expected load, and the limiter keys on the user, not
    the classroom.
    """
    data = body()
    require(data, "token")
    session = qr.resolve_token(str(data["token"]))
    _assert_session_open(session)

    student = _me()
    if student["institution_id"] != session["institution_id"]:
        # Should be unreachable — a signed token from another tenant would still
        # have to be scanned by a student of this one — but a cross-tenant write
        # is exactly the thing worth an explicit guard.
        raise forbidden("That code belongs to a different institution.")
    if not attendance.is_on_roster(session["subject_id"], student["_id"]):
        raise ApiError(
            "You are not enrolled in this subject, so you cannot check in to this class.",
            403,
            code="not_enrolled",
        )

    result = attendance.mark_present(
        session=session,
        student_id=student["_id"],
        method=AttendanceMethod.QR,
        marked_by=None,  # self-service: the student marked themselves
    )
    return _mark_result_response(result, session, method=AttendanceMethod.QR)


# --------------------------------------------------------------------------- #
# Student: voice check-in
# --------------------------------------------------------------------------- #
@bp.post("/voice")
@guards.role_required(Role.STUDENT)
@limiter.limit("10 per minute; 60 per hour")
def check_in_voice():
    """Verify my voice against my enrolled embedding and mark me present.

    This is a 1:1 verification, not a 1:N search. The candidate list is exactly
    ``[me]``, so a passing score confirms "this is the enrolled speaker for this
    account" rather than "this is whoever in the class sounds most like this". The
    open-set version would be far easier to fool.

    A rejection is a 200 with ``accepted: false``, not an error status. The client
    needs the distance and the reason to tell the student *why* ("too much
    background noise", "too short") and offer a retry, and an HTTP error would
    make that awkward for no benefit.
    """
    data = body()
    require(data, "session_id", "audio")
    session = guards.assert_same_institution(
        db.sessions().find_one({"_id": oid(data["session_id"])}), what="session"
    )
    if not VerificationMode.includes_voice(str(session.get("verification_mode"))):
        raise ApiError(
            "This class is not using voice check-in.",
            409,
            code="mode_mismatch",
            details={"verification_mode": session.get("verification_mode")},
        )
    _assert_session_open(session)

    student = _me()
    if not attendance.is_on_roster(session["subject_id"], student["_id"]):
        raise ApiError(
            "You are not enrolled in this subject, so you cannot check in to this class.",
            403,
            code="not_enrolled",
        )
    if not student.get("voice_enrolled"):
        raise ApiError(
            "Your voice is not enrolled yet. Record your passphrase from your dashboard first.",
            409,
            code="voice_not_enrolled",
        )

    audio = _decode_audio(data["audio"])
    try:
        verification = voice_pipeline.verify_voice(
            audio,
            institution_id=session["institution_id"],
            candidate_student_ids=[str(student["_id"])],
        )
    finally:
        del audio  # the recording never outlives the request

    if not verification.accepted:
        return (
            jsonify(
                {
                    "ok": False,
                    "accepted": False,
                    "message": verification.message,
                    "distance": verification.distance,
                    "confidence": verification.confidence,
                    "voiced_seconds": verification.voiced_seconds,
                    "can_retry": True,
                }
            ),
            200,
        )

    result = attendance.mark_present(
        session=session,
        student_id=student["_id"],
        method=AttendanceMethod.VOICE,
        confidence_score=verification.confidence,
        marked_by=None,
    )
    response, status = _mark_result_response(result, session, method=AttendanceMethod.VOICE)
    payload = response.get_json()
    payload["accepted"] = True
    payload["distance"] = verification.distance
    payload["confidence"] = verification.confidence
    return jsonify(payload), status


# --------------------------------------------------------------------------- #
# Teacher: manual override
# --------------------------------------------------------------------------- #
@bp.post("/override")
@guards.role_required(*Role.STAFF)
def override():
    """Set a student present or absent by hand, with a mandatory reason.

    The brief requires the reason and the audit trail, and both are enforced a
    layer down: ``clean_reason`` refuses an empty or one-word justification, and
    ``attendance.set_manual`` writes the previous state, the actor and the
    timestamp to the audit collection. A teacher cannot silently rewrite
    attendance, which is the property that makes the override feature safe to
    offer at all.
    """
    data = body()
    require(data, "session_id", "student_id", "present")
    session = guards.assert_can_manage_session(
        db.sessions().find_one({"_id": oid(data["session_id"])})
    )
    student_id = oid(data["student_id"])
    if not attendance.is_on_roster(session["subject_id"], student_id):
        raise bad_request(
            "That student is not on this subject's roster.",
            hint="Add them to the roster first, then override.",
        )
    if not isinstance(data["present"], bool):
        raise bad_request("present must be true or false")

    result = attendance.set_manual(
        session=session,
        student_id=student_id,
        present=bool(data["present"]),
        reason=clean_reason(data.get("reason")),
        actor_id=guards.current_user_id(),
    )
    return jsonify(result)


@bp.post("/override/bulk")
@guards.role_required(*Role.STAFF)
def override_bulk():
    """Apply the same override to several students in one call.

    Exists because "mark the six students who were on the field trip present" is
    otherwise six requests, and a teacher typing the same reason six times will
    start typing "x". One reason, one audit entry per student, still fully logged.
    """
    data = body()
    require(data, "session_id", "student_ids", "present")
    session = guards.assert_can_manage_session(
        db.sessions().find_one({"_id": oid(data["session_id"])})
    )
    if not isinstance(data["present"], bool):
        raise bad_request("present must be true or false")
    raw_ids = data["student_ids"]
    if not isinstance(raw_ids, (list, tuple)) or not raw_ids:
        raise bad_request("student_ids must be a non-empty array")
    if len(raw_ids) > 200:
        raise bad_request("Override at most 200 students per request")

    reason = clean_reason(data.get("reason"))
    roster = set(attendance.roster_student_ids_str(session["subject_id"]))
    applied, skipped = [], []
    for raw in raw_ids:
        student_id = oid(raw)
        if str(student_id) not in roster:
            skipped.append({"student_id": str(student_id), "reason": "not_on_roster"})
            continue
        attendance.set_manual(
            session=session,
            student_id=student_id,
            present=bool(data["present"]),
            reason=reason,
            actor_id=guards.current_user_id(),
        )
        applied.append(str(student_id))

    return jsonify(
        {
            "ok": True,
            "applied": applied,
            "applied_count": len(applied),
            "skipped": skipped,
            "status": AttendanceStatus.PRESENT if data["present"] else AttendanceStatus.ABSENT,
        }
    )


# --------------------------------------------------------------------------- #
# Student: my own attendance
# --------------------------------------------------------------------------- #
@bp.get("/me")
@guards.role_required(Role.STUDENT)
def my_attendance():
    """My attendance percentage per subject, plus recent sessions.

    Scoped by construction: the student id comes from the JWT's user, never from a
    query parameter, so there is no version of this endpoint that reads someone
    else's record.
    """
    student = _me()
    since, until = date_range()
    limit = clamp_int(request.args.get("limit"), 30, minimum=1, maximum=100)
    report = analytics.student_report(
        student_id=student["_id"],
        institution_id=student["institution_id"],
        since=since,
        until=until,
    )
    return jsonify(
        {
            "report": report,
            "history": analytics.student_history(
                student_id=student["_id"],
                institution_id=student["institution_id"],
                limit=limit,
            ),
            "enrollment": {
                "face_enrolled": bool(student.get("face_enrolled")),
                "voice_enrolled": bool(student.get("voice_enrolled")),
                "status": student.get("enrollment_status"),
            },
        }
    )


@bp.get("/me/open-sessions")
@guards.role_required(Role.STUDENT)
def my_open_sessions():
    """Live sessions I can act on right now — the student portal's home card.

    Only modes with a student-facing action appear here. A photo-only session is
    the teacher's job, so surfacing it with no button would just be confusing.
    """
    student = _me()
    subject_ids = attendance.enrolled_subject_ids(student["_id"])
    if not subject_ids:
        return jsonify({"sessions": []})

    now = utcnow()
    sessions = list(
        db.sessions()
        .find(
            {
                "subject_id": {"$in": subject_ids},
                "institution_id": student["institution_id"],
                "status": SessionStatus.ACTIVE,
            }
        )
        .sort("start_time", -1)
        .limit(20)
    )
    subjects = {
        s["_id"]: s
        for s in db.subjects().find(
            {"_id": {"$in": list({x["subject_id"] for x in sessions})}},
            {"name": 1, "code": 1},
        )
    }
    records = {
        str(r["session_id"]): r
        for r in db.attendance_records().find(
            {
                "session_id": {"$in": [s["_id"] for s in sessions]},
                "student_id": student["_id"],
            }
        )
    }

    rows = []
    for session in sessions:
        end = ensure_aware(session.get("end_time"))
        if end and end < now:
            continue
        mode = str(session.get("verification_mode"))
        if not VerificationMode.student_self_service(mode):
            continue
        record = records.get(str(session["_id"]))
        subject = subjects.get(session["subject_id"]) or {}
        rows.append(
            {
                "session_id": str(session["_id"]),
                "title": session.get("title"),
                "subject": subject.get("name"),
                "subject_code": subject.get("code"),
                "verification_mode": mode,
                "mode_label": VerificationMode.LABELS.get(mode, mode),
                "action": "voice" if VerificationMode.includes_voice(mode) else "qr",
                "closes_at": iso(end),
                "already_present": bool(
                    record and record.get("status") == AttendanceStatus.PRESENT
                ),
                "needs_voice_enrollment": (
                    VerificationMode.includes_voice(mode) and not student.get("voice_enrolled")
                ),
            }
        )
    return jsonify({"sessions": rows, "server_time": iso(now)})


@bp.get("/me/export")
@guards.role_required(Role.STUDENT)
def export_my_attendance():
    """My own attendance as a CSV — useful when disputing a defaulter list."""
    student = _me()
    since, until = date_range()
    report = analytics.student_report(
        student_id=student["_id"],
        institution_id=student["institution_id"],
        since=since,
        until=until,
    )
    user = guards.current_user_doc()
    text = analytics.student_report_csv(
        report,
        student={
            "name": user.get("name"),
            "email": user.get("email"),
            "roll_number": student.get("roll_number"),
        },
    )
    return csv_response(text, timestamped("my-attendance"))


# --------------------------------------------------------------------------- #
# Session record lookup (staff)
# --------------------------------------------------------------------------- #
@bp.get("/session/<session_id>")
@guards.role_required(*Role.STAFF)
def session_records(session_id: str):
    """Raw attendance rows for one session, with how each was verified."""
    session = guards.assert_can_manage_session(
        db.sessions().find_one({"_id": oid(session_id)})
    )
    rows = attendance.session_roster_view(session)
    present = sum(1 for r in rows if r["status"] == AttendanceStatus.PRESENT)
    by_method: dict[str, int] = {}
    for row in rows:
        if row["status"] == AttendanceStatus.PRESENT:
            key = row.get("method_used") or "unknown"
            by_method[key] = by_method.get(key, 0) + 1
    return jsonify(
        {
            "session_id": str(session["_id"]),
            "verification_mode": session.get("verification_mode"),
            "rows": rows,
            "present_count": present,
            "absent_count": len(rows) - present,
            "by_method": by_method,
        }
    )
