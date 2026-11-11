"""Class sessions: create, live view, QR display, class-photo upload, review queue.

This is where the four verification modes from the brief become concrete. The mode
is fixed on the session document at creation time and every downstream endpoint
reads it rather than re-deciding: uploading a photo to a QR-only session is a 400,
not a silent no-op, and the teacher dashboard renders the panels the mode calls
for.

The live view is polled, not pushed. A teacher watching a class fill in wants
updates every few seconds, and a 3-second poll of one indexed query is far less
machinery than a websocket layer — the brief explicitly allows this. Rate limits
are applied per-endpoint precisely so this polling is never throttled.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from flask import Blueprint, jsonify, request

from .. import db
from ..auth import guards
from ..extensions import limiter
from ..models.constants import (
    AttendanceStatus,
    AuditAction,
    PhotoReviewStatus,
    ReviewResolution,
    Role,
    SessionStatus,
    VerificationMode,
)
from ..models.schemas import session_doc
from ..services import (
    analytics,
    attendance,
    audit,
    class_photo,
    face_crop_store,
    qr,
)
from ..utils.errors import bad_request, conflict
from ..utils.serialization import oid, oid_or_none, serialize_doc
from ..utils.timeutil import ensure_aware, iso, parse_iso, utcnow
from ..utils.validators import (
    body,
    clamp_int,
    clean_enum,
    clean_name,
    clean_reason,
    clean_verification_mode,
)
from ._helpers import csv_response, date_range, timestamped

log = logging.getLogger(__name__)

bp = Blueprint("sessions", __name__, url_prefix="/api/sessions")

# A class photo of a large lecture hall at full phone resolution is a few MB. 16 MB
# leaves generous headroom while still refusing an accidental video upload.
MAX_PHOTO_BYTES = 16 * 1024 * 1024
DEFAULT_SESSION_MINUTES = 60
MAX_SESSION_HOURS = 12


# --------------------------------------------------------------------------- #
# Views
# --------------------------------------------------------------------------- #
def _session_view(session, *, subject=None, present=None, roster_size=None) -> dict:
    """The session shape every endpoint here returns, so the client sees one schema."""
    view = serialize_doc(session, drop=("qr_current_token", "qr_current_nonce", "qr_previous_nonce"))
    mode = str(session.get("verification_mode"))
    view["mode_label"] = VerificationMode.LABELS.get(mode, mode)
    view["uses_photo"] = VerificationMode.includes_photo(mode)
    view["uses_qr"] = VerificationMode.includes_qr(mode)
    view["uses_voice"] = VerificationMode.includes_voice(mode)
    view["is_open"] = _is_open(session)
    if subject is not None:
        view["subject"] = {
            "id": str(subject["_id"]),
            "name": subject.get("name"),
            "code": subject.get("code"),
        }
    if present is not None:
        view["present_count"] = present
    if roster_size is not None:
        view["roster_size"] = roster_size
        view["absent_count"] = max(roster_size - (present or 0), 0)
    return view


def _is_open(session) -> bool:
    """A session accepts self-service check-ins while active and within its window."""
    if session.get("status") != SessionStatus.ACTIVE:
        return False
    end = ensure_aware(session.get("end_time"))
    return not end or end >= utcnow()


def _load_session(session_id: str):
    """Fetch a session and assert the caller may act on it."""
    session = db.sessions().find_one({"_id": oid(session_id)})
    return guards.assert_can_manage_session(session)


# --------------------------------------------------------------------------- #
# CRUD
# --------------------------------------------------------------------------- #
@bp.get("")
@guards.role_required(*Role.STAFF)
def list_sessions():
    """Sessions the caller can act on, newest first."""
    query = guards.scope()

    subject_id = request.args.get("subject_id")
    if subject_id:
        subject = guards.assert_can_manage_subject(
            db.subjects().find_one({"_id": oid(subject_id)})
        )
        query["subject_id"] = subject["_id"]
    elif not guards.is_admin():
        # Without a subject filter a teacher still only sees their own subjects.
        query["subject_id"] = {"$in": guards.teacher_subject_ids()}

    status = request.args.get("status")
    if status:
        query["status"] = clean_enum(
            status, (SessionStatus.ACTIVE, SessionStatus.ENDED), "status"
        )
    since, until = date_range()
    if since or until:
        window = {}
        if since:
            window["$gte"] = since
        if until:
            window["$lte"] = until
        query["start_time"] = window

    limit = clamp_int(request.args.get("limit"), 50, minimum=1, maximum=200)
    sessions = list(db.sessions().find(query).sort("start_time", -1).limit(limit))
    if not sessions:
        return jsonify({"sessions": []})

    subjects = {
        s["_id"]: s
        for s in db.subjects().find(
            {"_id": {"$in": list({x["subject_id"] for x in sessions})}},
            {"name": 1, "code": 1},
        )
    }
    counts = attendance.counts_for_sessions([s["_id"] for s in sessions])
    roster_sizes = {
        str(row["_id"]): row["count"]
        for row in db.enrollments().aggregate(
            [
                {"$match": {"subject_id": {"$in": list(subjects.keys())}}},
                {"$group": {"_id": "$subject_id", "count": {"$sum": 1}}},
            ]
        )
    }
    return jsonify(
        {
            "sessions": [
                _session_view(
                    s,
                    subject=subjects.get(s["subject_id"]),
                    present=counts.get(str(s["_id"]), 0),
                    roster_size=roster_sizes.get(str(s["subject_id"]), 0),
                )
                for s in sessions
            ]
        }
    )


@bp.post("")
@guards.role_required(*Role.STAFF)
def create_session():
    """Open a class session in one of the four verification modes.

    Defaults to starting now and running for an hour, because the overwhelmingly
    common case is a teacher opening a session as class begins. An explicit
    ``start_time``/``end_time`` pair supports scheduling ahead.
    """
    data = body()
    if not data.get("subject_id"):
        raise bad_request("subject_id is required")
    subject = guards.assert_can_manage_subject(
        db.subjects().find_one({"_id": oid(data["subject_id"])})
    )
    if subject.get("archived"):
        raise conflict("That subject is archived. Un-archive it before opening sessions.")

    mode = clean_verification_mode(data.get("verification_mode"))

    start = parse_iso(data.get("start_time")) or utcnow()
    end = parse_iso(data.get("end_time"))
    if end is None:
        minutes = clamp_int(
            data.get("duration_minutes"), DEFAULT_SESSION_MINUTES, minimum=5, maximum=MAX_SESSION_HOURS * 60
        )
        end = start + timedelta(minutes=minutes)
    if end <= start:
        raise bad_request("end_time must be after start_time")
    if (end - start).total_seconds() > MAX_SESSION_HOURS * 3600:
        raise bad_request(f"A session cannot run longer than {MAX_SESSION_HOURS} hours")

    roster_size = db.enrollments().count_documents({"subject_id": subject["_id"]})
    if roster_size == 0:
        raise conflict(
            "This subject has no students on its roster. Add students before opening a session.",
            hint="POST /api/subjects/<id>/roster",
        )

    # A second active session for the same subject is almost always a mistake (a
    # double-click, or a teacher who forgot to end this morning's class) and it
    # would split the class's attendance across two records.
    existing = db.sessions().find_one(
        {"subject_id": subject["_id"], "status": SessionStatus.ACTIVE}
    )
    if existing and _is_open(existing):
        raise conflict(
            "This subject already has an open session. End it before starting another.",
            session_id=str(existing["_id"]),
        )

    doc = session_doc(
        subject_id=subject["_id"],
        teacher_id=guards.current_user_id(),
        institution_id=subject["institution_id"],
        verification_mode=mode,
        start_time=start,
        end_time=end,
        title=clean_name(data["title"], field="title") if data.get("title") else None,
    )
    doc["_id"] = db.sessions().insert_one(doc).inserted_id

    audit.record(
        institution_id=subject["institution_id"],
        actor_id=guards.current_user_id(),
        action=AuditAction.SESSION_CREATED,
        target_id=doc["_id"],
        target_type="session",
        new_state={
            "subject": subject.get("code"),
            "verification_mode": mode,
            "start_time": iso(start),
            "end_time": iso(end),
        },
    )

    payload = {
        "session": _session_view(doc, subject=subject, present=0, roster_size=roster_size),
        "coverage": (
            class_photo.embedding_coverage(subject["_id"], subject["institution_id"])
            if VerificationMode.includes_photo(mode)
            else None
        ),
    }
    # Mint the first QR immediately so the teacher's screen has something to show
    # the moment the session opens.
    if VerificationMode.includes_qr(mode):
        payload["qr"] = qr.ensure_fresh_token(doc)
    return jsonify(payload), 201


@bp.get("/<session_id>")
@guards.role_required(*Role.STAFF)
def get_session(session_id: str):
    session = _load_session(session_id)
    subject = db.subjects().find_one({"_id": session["subject_id"]})
    roster = attendance.session_roster_view(session)
    present = sum(1 for r in roster if r["status"] == AttendanceStatus.PRESENT)
    return jsonify(
        {
            "session": _session_view(
                session, subject=subject, present=present, roster_size=len(roster)
            ),
            "roster": roster,
            "review_queue_count": face_crop_store.unresolved_count(session["_id"]),
        }
    )


@bp.patch("/<session_id>")
@guards.role_required(*Role.STAFF)
def update_session(session_id: str):
    """Adjust a session's title or extend its window.

    The verification mode is intentionally immutable once created: students may
    already have checked in under the original mode, and switching it afterwards
    would make the recorded ``method_used`` values inconsistent with the session.
    """
    session = _load_session(session_id)
    data = body()
    updates: dict = {}

    if "title" in data:
        updates["title"] = clean_name(data["title"], field="title") if data["title"] else None
    if data.get("end_time"):
        end = parse_iso(data["end_time"])
        if not end:
            raise bad_request("end_time must be an ISO-8601 timestamp")
        start = ensure_aware(session.get("start_time"))
        if start and end <= start:
            raise bad_request("end_time must be after the session start")
        updates["end_time"] = end
    if data.get("verification_mode"):
        raise conflict(
            "A session's verification mode cannot be changed after it is created. "
            "End this session and open a new one."
        )
    if not updates:
        raise bad_request("Nothing to update")

    updates["updated_at"] = utcnow()
    db.sessions().update_one({"_id": session["_id"]}, {"$set": updates})
    fresh = db.sessions().find_one({"_id": session["_id"]})
    return jsonify({"session": _session_view(fresh)})


@bp.post("/<session_id>/end")
@guards.role_required(*Role.STAFF)
def end_session(session_id: str):
    """Close a session: stop check-ins, kill the QR, discard any leftover crops.

    Ending is the retention boundary for this session's biometric artefacts. Any
    review-queue crop the teacher never got to is destroyed here rather than
    lingering until the TTL fires.
    """
    session = _load_session(session_id)
    if session.get("status") == SessionStatus.ENDED:
        return jsonify({"session": _session_view(session), "already_ended": True})

    now = utcnow()
    db.sessions().update_one(
        {"_id": session["_id"]},
        {
            "$set": {
                "status": SessionStatus.ENDED,
                "ended_at": now,
                "end_time": now,
                "updated_at": now,
            }
        },
    )
    qr.clear_token(session["_id"])
    discarded = face_crop_store.discard_session_crops(
        session["_id"], actor_id=guards.current_user_id()
    )

    present = attendance.present_count(session["_id"])
    roster_size = db.enrollments().count_documents({"subject_id": session["subject_id"]})
    audit.record(
        institution_id=session["institution_id"],
        actor_id=guards.current_user_id(),
        action=AuditAction.SESSION_ENDED,
        target_id=session["_id"],
        target_type="session",
        previous_state={"status": SessionStatus.ACTIVE},
        new_state={"status": SessionStatus.ENDED},
        metadata={
            "present": present,
            "roster_size": roster_size,
            "crops_discarded": discarded,
        },
    )
    fresh = db.sessions().find_one({"_id": session["_id"]})
    return jsonify(
        {
            "session": _session_view(fresh, present=present, roster_size=roster_size),
            "crops_discarded": discarded,
        }
    )


# --------------------------------------------------------------------------- #
# Live view (polled)
# --------------------------------------------------------------------------- #
@bp.get("/<session_id>/live")
@guards.role_required(*Role.STAFF)
def live(session_id: str):
    """Everything the live session screen needs, in one poll-friendly payload.

    Deliberately not rate-limited: this is the endpoint the dashboard polls every
    few seconds, and throttling it would break the feature it exists for.
    """
    session = _load_session(session_id)
    roster = attendance.session_roster_view(session)
    present = sum(1 for r in roster if r["status"] == AttendanceStatus.PRESENT)
    mode = str(session.get("verification_mode"))

    payload = {
        "session": _session_view(session, present=present, roster_size=len(roster)),
        "roster": roster,
        "present_count": present,
        "absent_count": len(roster) - present,
        "review_queue_count": face_crop_store.unresolved_count(session["_id"]),
        "server_time": iso(utcnow()),
    }
    if VerificationMode.includes_qr(mode) and _is_open(session):
        # Rotation happens inside ensure_fresh_token when the current nonce is
        # stale, so simply polling this endpoint keeps the displayed code moving.
        payload["qr"] = qr.ensure_fresh_token(session)
    return jsonify(payload)


@bp.get("/<session_id>/qr")
@guards.role_required(*Role.STAFF)
def current_qr(session_id: str):
    """The session's current QR token, rotating it if the last one went stale."""
    session = _load_session(session_id)
    if not VerificationMode.includes_qr(str(session.get("verification_mode"))):
        raise bad_request("This session does not use QR check-in.")
    if not _is_open(session):
        raise conflict("This session is closed, so no QR code is issued.")
    force = request.args.get("force") in ("1", "true", "yes")
    return jsonify({"qr": qr.ensure_fresh_token(session, force=force)})


# --------------------------------------------------------------------------- #
# Class photo
# --------------------------------------------------------------------------- #
@bp.get("/<session_id>/coverage")
@guards.role_required(*Role.STAFF)
def coverage(session_id: str):
    """How much of the roster is face-enrolled — shown before a photo upload.

    Surfacing this first means a teacher learns that six students cannot be matched
    *before* they take the photo, not after wondering why those six were absent.
    """
    session = _load_session(session_id)
    return jsonify(
        class_photo.embedding_coverage(session["subject_id"], session["institution_id"])
    )


@bp.post("/<session_id>/photo")
@guards.role_required(*Role.STAFF)
@limiter.limit("30 per hour")
def upload_photo(session_id: str):
    """Upload one class photo; every confident match is marked present.

    The photo is read into memory, matched, and dropped. It is never written to
    disk or to MongoDB — the only pixels that outlive the request are the
    review-queue crops, and those are deleted as soon as the teacher resolves them.

    Rate-limited because each upload runs face detection plus one embedding per
    detected face, which is the most expensive operation in the product.
    """
    session = _load_session(session_id)
    if session.get("status") == SessionStatus.ENDED:
        raise conflict("This session has ended. Reopen a new session to mark attendance.")

    upload = request.files.get("photo") or request.files.get("file")
    if upload is None:
        raise bad_request(
            "Attach the class photo as a multipart form field named 'photo'",
            content_type=request.content_type,
        )

    photo_bytes = upload.read(MAX_PHOTO_BYTES + 1)
    if not photo_bytes:
        raise bad_request("The uploaded file was empty")
    if len(photo_bytes) > MAX_PHOTO_BYTES:
        raise bad_request(
            f"Photo is larger than {MAX_PHOTO_BYTES // (1024 * 1024)} MB. "
            f"Most phone cameras produce a suitable file at default settings."
        )

    try:
        result = class_photo.process_class_photo(
            session=session,
            photo_bytes=photo_bytes,
            actor_id=guards.current_user_id(),
        )
    finally:
        # Explicit, even though the local would fall out of scope anyway: this is
        # the one place raw biometric pixels exist in the request, and being loud
        # about dropping them is the point.
        del photo_bytes

    return jsonify(result), 201


# --------------------------------------------------------------------------- #
# Review queue
# --------------------------------------------------------------------------- #
@bp.get("/<session_id>/review")
@guards.role_required(*Role.STAFF)
def review_queue(session_id: str):
    """Faces the pipeline could not confidently match, with their crops.

    Crops are returned as base64 JPEG in the JSON rather than as URLs to a static
    file, so there is no image endpoint to leak and nothing on disk to forget to
    clean up.
    """
    session = _load_session(session_id)
    include_resolved = request.args.get("include_resolved") in ("1", "true", "yes")
    items = face_crop_store.list_review_items(
        session["_id"], include_resolved=include_resolved
    )
    return jsonify(
        {
            "items": items,
            "count": len([i for i in items if not i.get("resolved")]),
            "assignable_students": class_photo.assignable_students(session),
            "photo_review_status": session.get("photo_review_status", PhotoReviewStatus.NONE),
        }
    )


@bp.post("/<session_id>/review/<pending_id>")
@guards.role_required(*Role.STAFF)
def resolve_review(session_id: str, pending_id: str):
    """Apply the teacher's decision to one queued face.

    ``resolution`` is one of ``assigned`` (with ``student_id``), ``dismissed`` or
    ``not_a_student``. In every case the crop is destroyed immediately after the
    decision is recorded.
    """
    session = _load_session(session_id)
    data = body()
    resolution = clean_enum(
        data.get("resolution"),
        (
            ReviewResolution.ASSIGNED,
            ReviewResolution.DISMISSED,
            ReviewResolution.NOT_A_STUDENT,
        ),
        "resolution",
    )
    assigned = oid_or_none(data.get("student_id"))
    if resolution == ReviewResolution.ASSIGNED:
        if not assigned:
            raise bad_request("student_id is required when assigning a face")
        if not attendance.is_on_roster(session["subject_id"], assigned):
            raise bad_request("That student is not on this subject's roster")

    result = class_photo.resolve_review_item(
        session=session,
        pending_id=oid(pending_id),
        resolution=resolution,
        assigned_student_id=assigned,
        reason=clean_reason(data.get("reason"), required=False) or None,
        actor_id=guards.current_user_id(),
    )
    return jsonify(result)


@bp.delete("/<session_id>/review")
@guards.role_required(*Role.STAFF)
def discard_review_queue(session_id: str):
    """Give up on the remaining faces and destroy their crops now.

    "I'll sort the rest out manually" is a normal outcome, and it should not leave
    face crops sitting in the database until the TTL fires.
    """
    session = _load_session(session_id)
    discarded = face_crop_store.discard_session_crops(
        session["_id"], actor_id=guards.current_user_id()
    )
    db.sessions().update_one(
        {"_id": session["_id"]},
        {
            "$set": {
                "photo_review_status": PhotoReviewStatus.RESOLVED,
                "updated_at": utcnow(),
            }
        },
    )
    return jsonify({"ok": True, "crops_discarded": discarded})


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
@bp.get("/<session_id>/export")
@guards.role_required(*Role.STAFF)
def export_session(session_id: str):
    """One session's roster and verification method as a CSV download."""
    session = _load_session(session_id)
    subject = db.subjects().find_one({"_id": session["subject_id"]})
    rows = attendance.session_roster_view(session)
    text = analytics.session_csv(session=session, rows=rows, subject=subject)
    name = timestamped(f"session-{(subject or {}).get('code', 'class')}")
    return csv_response(text, name)
