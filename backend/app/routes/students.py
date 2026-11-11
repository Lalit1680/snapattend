"""Student accounts: invites, bulk CSV import, and staff-side profile management.

Every student account starts as an email invite — there is no public signup link
and no shared enrollment QR, which is what keeps institution membership
controlled and traceable (a requirement from the brief, not an accident of
design).

Bulk import is deliberately partial-success: a 200-row CSV with two typos imports
198 students and reports the two bad rows with line numbers. Rejecting the whole
file would make the feature useless in practice, since real registrar exports
always contain a stray row.
"""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify, request
from pymongo.errors import DuplicateKeyError

from .. import db
from ..auth import guards
from ..models.constants import AuditAction, Role, UserStatus
from ..models.schemas import enrollment_doc
from ..services import (
    analytics,
    attendance,
    audit,
    enrollment as enrollment_service,
    invites,
)
from ..utils.errors import bad_request, conflict
from ..utils.serialization import oid
from ..utils.timeutil import utcnow
from ..utils.validators import (
    body,
    clamp_int,
    clean_email,
    clean_name,
    clean_reason,
    parse_student_csv,
    require,
)
from ._helpers import csv_response, invite_response

log = logging.getLogger(__name__)

bp = Blueprint("students", __name__, url_prefix="/api/students")

# Guards against a stray multi-megabyte upload being parsed into memory. The row
# cap in parse_student_csv is the real limit; this is the cheap pre-check.
MAX_CSV_BYTES = 512 * 1024


def _clean_roll_number(value) -> str | None:
    if value in (None, ""):
        return None
    text = str(value).strip()
    if len(text) > 32:
        raise bad_request("Roll number must be 32 characters or fewer")
    return text


def _student_view(student, user=None) -> dict:
    user = user or db.users().find_one({"_id": student.get("user_id")}) or {}
    return {
        "student_id": str(student["_id"]),
        "user_id": str(student["user_id"]) if student.get("user_id") else None,
        "name": user.get("name"),
        "email": user.get("email"),
        "account_status": user.get("status"),
        "roll_number": student.get("roll_number"),
        "enrollment_status": student.get("enrollment_status"),
        "face_enrolled": bool(student.get("face_enrolled")),
        "voice_enrolled": bool(student.get("voice_enrolled")),
        "face_sample_count": student.get("face_sample_count", 0),
        "voice_sample_count": student.get("voice_sample_count", 0),
        "created_at": student.get("created_at"),
    }


# --------------------------------------------------------------------------- #
# Directory
# --------------------------------------------------------------------------- #
@bp.get("")
@guards.role_required(*Role.STAFF)
def list_students():
    """Institution-wide student directory with enrollment state.

    ``?subject_id=`` narrows it to one roster, which is what the teacher dashboard
    uses; without it an admin sees everyone.
    """
    institution_id = guards.current_institution_id()
    query = {"institution_id": institution_id}

    subject_id = request.args.get("subject_id")
    if subject_id:
        subject = guards.assert_can_manage_subject(
            db.subjects().find_one({"_id": oid(subject_id)})
        )
        roster = attendance.roster_student_ids(subject["_id"])
        if not roster:
            return jsonify({"students": [], "count": 0})
        query["_id"] = {"$in": roster}

    status = request.args.get("enrollment_status")
    if status:
        query["enrollment_status"] = status
    if request.args.get("face_enrolled") in ("0", "false"):
        query["face_enrolled"] = {"$ne": True}

    limit = clamp_int(request.args.get("limit"), 200, minimum=1, maximum=1000)
    students = list(db.students().find(query).limit(limit))
    if not students:
        return jsonify({"students": [], "count": 0})

    users = {
        u["_id"]: u
        for u in db.users().find(
            {"_id": {"$in": [s["user_id"] for s in students if s.get("user_id")]}},
            {"name": 1, "email": 1, "status": 1},
        )
    }
    rows = [_student_view(s, users.get(s.get("user_id"))) for s in students]

    search = (request.args.get("q") or "").strip().lower()
    if search:
        rows = [
            r
            for r in rows
            if search in (r["name"] or "").lower()
            or search in (r["email"] or "").lower()
            or search in (r["roll_number"] or "").lower()
        ]
    rows.sort(key=lambda r: (r["name"] or "").lower())
    return jsonify({"students": rows, "count": len(rows)})


@bp.get("/<student_id>")
@guards.role_required(*Role.STAFF)
def get_student(student_id: str):
    student = guards.assert_same_institution(
        db.students().find_one({"_id": oid(student_id)}), what="student"
    )
    subject_ids = attendance.enrolled_subject_ids(student["_id"])
    subjects = list(db.subjects().find({"_id": {"$in": subject_ids}}, {"name": 1, "code": 1}))
    return jsonify(
        {
            "student": _student_view(student),
            "subjects": [
                {"id": str(s["_id"]), "name": s.get("name"), "code": s.get("code")}
                for s in subjects
            ],
            "enrollment": enrollment_service.enrollment_progress(student),
        }
    )


# --------------------------------------------------------------------------- #
# Invites
# --------------------------------------------------------------------------- #
@bp.post("")
@guards.role_required(*Role.STAFF)
def invite_student():
    """Invite one student, optionally enrolling them into a subject immediately."""
    data = body()
    require(data, "email", "name")
    institution_id = guards.current_institution_id()

    subject = None
    if data.get("subject_id"):
        subject = guards.assert_can_manage_subject(
            db.subjects().find_one({"_id": oid(data["subject_id"])})
        )

    result = invites.create_invite(
        email=clean_email(data["email"]),
        name=clean_name(data["name"]),
        role=Role.STUDENT,
        institution_id=institution_id,
        invited_by=guards.current_user_id(),
    )

    payload = invite_response(result)
    student = db.students().find_one({"user_id": result["user_id"]})

    roll_number = _clean_roll_number(data.get("roll_number"))
    if roll_number and student:
        db.students().update_one(
            {"_id": student["_id"]},
            {"$set": {"roll_number": roll_number, "updated_at": utcnow()}},
        )

    if subject and student:
        payload["enrolled_in_subject"] = _enroll_in_subject(
            subject=subject, student_id=student["_id"], institution_id=institution_id
        )
    if student:
        payload["student_id"] = str(student["_id"])
    return jsonify(payload), 201


def _enroll_in_subject(*, subject, student_id, institution_id) -> bool:
    """Add a student to a roster, tolerating an existing membership."""
    try:
        db.enrollments().insert_one(
            enrollment_doc(
                subject_id=subject["_id"],
                student_id=student_id,
                institution_id=institution_id,
            )
        )
    except DuplicateKeyError:
        return False
    audit.record(
        institution_id=institution_id,
        actor_id=guards.current_user_id(),
        action=AuditAction.ROSTER_ADDED,
        target_id=subject["_id"],
        target_type="subject",
        new_state={"student_ids": [str(student_id)]},
        metadata={"via": "student_invite"},
    )
    return True


@bp.post("/import")
@guards.role_required(*Role.STAFF)
def import_students():
    """Bulk-invite students from a CSV upload.

    Accepts either a ``multipart/form-data`` file field named ``file`` or a JSON
    body with a ``csv`` string, because the dashboard uses a file picker and
    scripts/tests find the JSON form far easier to drive.

    ``subject_id`` (optional) enrolls every successfully invited student into that
    subject in the same pass — importing a class list and then adding all of them
    to the class is one action from the teacher's point of view.
    """
    institution_id = guards.current_institution_id()

    raw: bytes | str | None = None
    if "file" in request.files:
        upload = request.files["file"]
        raw = upload.read(MAX_CSV_BYTES + 1)
        if raw and len(raw) > MAX_CSV_BYTES:
            raise bad_request(
                f"CSV file is larger than {MAX_CSV_BYTES // 1024} KB. Split it into batches."
            )
        subject_id = request.form.get("subject_id")
        dry_run = str(request.form.get("dry_run", "")).lower() in ("1", "true", "yes")
    else:
        data = body()
        require(data, "csv")
        raw = str(data["csv"])
        subject_id = data.get("subject_id")
        dry_run = bool(data.get("dry_run"))

    if not raw:
        raise bad_request("No CSV content was uploaded")

    subject = None
    if subject_id:
        subject = guards.assert_can_manage_subject(
            db.subjects().find_one({"_id": oid(subject_id)})
        )

    valid, errors = parse_student_csv(raw)
    if not valid:
        raise bad_request(
            "No valid rows found in that CSV. Expected a 'name,email' header.",
            row_errors=errors[:25],
            error_count=len(errors),
        )

    if dry_run:
        # Lets the UI show "18 students will be invited, 2 rows have problems"
        # before anything is written or emailed.
        return jsonify(
            {
                "dry_run": True,
                "would_invite": valid,
                "would_invite_count": len(valid),
                "row_errors": errors,
                "subject": subject.get("name") if subject else None,
            }
        )

    result = invites.bulk_invite_students(
        rows=valid,
        institution_id=institution_id,
        invited_by=guards.current_user_id(),
    )

    enrolled = 0
    if subject and result["invited"]:
        user_ids = [oid(r["student_user_id"]) for r in result["invited"]]
        students = list(db.students().find({"user_id": {"$in": user_ids}}, {"_id": 1}))
        for student in students:
            if _enroll_in_subject(
                subject=subject, student_id=student["_id"], institution_id=institution_id
            ):
                enrolled += 1

    return (
        jsonify(
            {
                "ok": True,
                "invited": result["invited"],
                "invited_count": result["invited_count"],
                "skipped": result["skipped"],
                "row_errors": errors,
                "enrolled_in_subject": enrolled,
                "subject": subject.get("name") if subject else None,
                "emails_sent": len(result["invited"]),
            }
        ),
        201,
    )


@bp.get("/import/template")
@guards.role_required(*Role.STAFF)
def import_template():
    """The CSV shape the importer expects, so nobody has to guess."""
    csv_text = "name,email\r\nAda Lovelace,ada@example.edu\r\nAlan Turing,alan@example.edu\r\n"
    return csv_response(csv_text, "snapattend-students-template.csv")


# --------------------------------------------------------------------------- #
# Profile edits
# --------------------------------------------------------------------------- #
@bp.patch("/<student_id>")
@guards.role_required(*Role.STAFF)
def update_student(student_id: str):
    """Correct a roll number or display name."""
    student = guards.assert_same_institution(
        db.students().find_one({"_id": oid(student_id)}), what="student"
    )
    data = body()

    if "roll_number" in data:
        db.students().update_one(
            {"_id": student["_id"]},
            {
                "$set": {
                    "roll_number": _clean_roll_number(data["roll_number"]),
                    "updated_at": utcnow(),
                }
            },
        )
    if data.get("name"):
        db.users().update_one(
            {"_id": student["user_id"]},
            {"$set": {"name": clean_name(data["name"]), "updated_at": utcnow()}},
        )
    if "roll_number" not in data and not data.get("name"):
        raise bad_request("Nothing to update")

    return jsonify({"student": _student_view(db.students().find_one({"_id": student["_id"]}))})


@bp.post("/<student_id>/reset-biometrics")
@guards.role_required(*Role.STAFF)
def reset_biometrics(student_id: str):
    """Clear a student's face/voice vectors so they can re-enroll.

    A reason is required: this is a destructive action on someone else's account,
    and the audit trail is what makes it defensible after the fact.
    """
    student = guards.assert_same_institution(
        db.students().find_one({"_id": oid(student_id)}), what="student"
    )
    data = body()
    reason = clean_reason(data.get("reason"))
    face = bool(data.get("face", True))
    voice = bool(data.get("voice", True))
    if not (face or voice):
        raise bad_request("Nothing to reset — set face and/or voice to true")

    result = enrollment_service.reset_biometrics(
        student=student,
        face=face,
        voice=voice,
        actor_id=guards.current_user_id(),
        reason=reason,
    )
    return jsonify(result)


@bp.get("/<student_id>/attendance")
@guards.role_required(*Role.STAFF)
def student_attendance(student_id: str):
    """A single student's attendance across subjects — the drill-down view."""
    student = guards.assert_same_institution(
        db.students().find_one({"_id": oid(student_id)}), what="student"
    )
    institution_id = guards.current_institution_id()
    report = analytics.student_report(
        student_id=student["_id"], institution_id=institution_id
    )

    if not guards.is_admin():
        # A teacher may only see the subjects they teach, even when looking at a
        # student who is enrolled in more.
        allowed = {str(s) for s in guards.teacher_subject_ids()}
        report["subjects"] = [
            row for row in report["subjects"] if row["subject_id"] in allowed
        ]

    limit = clamp_int(request.args.get("limit"), 50, minimum=1, maximum=200)
    return jsonify(
        {
            "student": _student_view(student),
            "report": report,
            "history": analytics.student_history(
                student_id=student["_id"], institution_id=institution_id, limit=limit
            ),
        }
    )


@bp.post("/<student_id>/resend-invite")
@guards.role_required(*Role.STAFF)
def resend_student_invite(student_id: str):
    """Re-send an invitation email for a student who never activated."""
    student = guards.assert_same_institution(
        db.students().find_one({"_id": oid(student_id)}), what="student"
    )
    user = db.users().find_one({"_id": student.get("user_id")})
    if not user:
        raise conflict("That student has no linked account")
    if user.get("status") == UserStatus.ACTIVE:
        raise conflict("That student has already activated their account.")

    result = invites.resend(
        user["email"],
        institution_id=guards.current_institution_id(),
        actor_id=guards.current_user_id(),
    )
    return jsonify(invite_response(result))
