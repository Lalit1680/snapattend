"""Unauthenticated endpoints. Deliberately tiny.

There is exactly one: resolving a scanned QR token into a human-readable
description of the class. It exists because of the order of events on a phone —
the camera app opens the URL, and only *then* does the student find out whether
they are logged in. Without this endpoint the scan page would have to show a bare
login form with no indication of what it is for, which is how students end up
scanning the wrong code and not knowing it.

What it returns is bounded on purpose: subject name, code, teacher name, and
whether the window is open. No roster, no attendance state, no student data. A
token is short-lived and signed, but it still travels through a camera app and
possibly a browser history, so it must not be a key to anything.

Marking attendance still requires a logged-in student — this endpoint never
writes.
"""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify, request

from .. import db
from ..auth import guards
from ..extensions import limiter
from ..models.constants import AttendanceStatus, Role, VerificationMode
from ..services import attendance, qr
from ..utils.errors import ApiError, bad_request
from ..utils.timeutil import iso, utcnow

log = logging.getLogger(__name__)

bp = Blueprint("public", __name__, url_prefix="/api/public")


@bp.get("/scan")
@guards.optional_auth
@limiter.limit("60 per minute")
def scan():
    """Describe the session behind a scanned QR token.

    Rate-limited despite being read-only: it is the one unauthenticated endpoint
    that does signature verification and a database lookup, which makes it the
    obvious thing to point a script at.

    When a student *is* logged in, the response also says whether they are on the
    roster and whether they are already marked — so the scan page can render
    "You're already checked in" instead of a button that will fail.
    """
    token = request.args.get("t") or request.args.get("token")
    if not token:
        raise bad_request("Missing QR token", hint="Scan the code shown by your teacher.")

    # resolve_token raises with a specific code (token_invalid, qr_rotated,
    # session_ended, window_closed) which the scan page turns into a plain-English
    # explanation. "Rotated" in particular is worth distinguishing: it means the
    # code was real but is now stale, and the fix is simply to scan again.
    session = qr.resolve_token(token)
    subject = db.subjects().find_one({"_id": session["subject_id"]}, {"name": 1, "code": 1})
    payload = qr.public_session_summary(session, subject)
    payload["server_time"] = iso(utcnow())

    user = guards.current_user_optional()
    payload["authenticated"] = user is not None

    if user is None:
        payload["student"] = {
            "can_check_in": False,
            "reason": "not_signed_in",
            "message": "Sign in to check in to this class.",
        }
    elif user.get("role") != Role.STUDENT:
        # A teacher scanning their own screen is a normal thing to do while
        # testing. Say so rather than showing them a broken check-in button.
        payload["student"] = {
            "can_check_in": False,
            "reason": "staff_account",
            "message": "You are signed in as staff — only students can check in.",
        }
    else:
        payload["student"] = _student_state(session, user)
    return jsonify(payload)


def _student_state(session, user) -> dict:
    """Whether the signed-in student can act on this session, and why not."""
    try:
        student = attendance.student_for_user(user["_id"])
    except ApiError:
        # A user with the student role but no ``students`` profile — shouldn't
        # happen, but it is a data problem, not a reason to 500 the scan page.
        return {
            "can_check_in": False,
            "reason": "no_student_profile",
            "message": "Your student profile is incomplete. Contact your institution.",
        }

    if student["institution_id"] != session["institution_id"]:
        return {
            "can_check_in": False,
            "reason": "wrong_institution",
            "message": "That code belongs to a different institution.",
        }
    if not attendance.is_on_roster(session["subject_id"], student["_id"]):
        return {
            "can_check_in": False,
            "reason": "not_enrolled",
            "message": "You are not enrolled in this subject.",
        }

    record = db.attendance_records().find_one(
        {"session_id": session["_id"], "student_id": student["_id"]},
        {"status": 1, "method_used": 1, "timestamp": 1},
    )
    if record and record.get("status") == AttendanceStatus.PRESENT:
        return {
            "can_check_in": False,
            "already_present": True,
            "reason": "already_present",
            "method_used": record.get("method_used"),
            "marked_at": iso(record.get("timestamp")),
            "message": "You are already marked present for this class.",
        }

    return {
        "can_check_in": True,
        "already_present": False,
        "student_id": str(student["_id"]),
        "action": (
            "voice"
            if VerificationMode.includes_voice(str(session.get("verification_mode")))
            else "qr"
        ),
        "message": "Tap to check in.",
    }
