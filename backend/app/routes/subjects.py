"""Subjects and their rosters.

Ownership rules live in ``guards.assert_can_manage_subject`` rather than being
re-derived here: admins manage anything inside their institution, teachers manage
only subjects they are assigned to. Every read is filtered through
``guards.scope()`` so a subject id from another tenant returns 404, not data.

Subjects are archived rather than deleted once they have sessions. Deleting a
subject with attendance history would silently rewrite past reports; archiving
hides it from pickers while keeping the record intact.
"""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify, request
from pymongo.errors import DuplicateKeyError

from .. import db
from ..auth import guards
from ..models.constants import AuditAction, Role, UserStatus
from ..models.schemas import enrollment_doc, subject_doc
from ..services import analytics, attendance, audit
from ..utils.errors import bad_request, conflict
from ..utils.serialization import oid, serialize_doc
from ..utils.timeutil import utcnow
from ..utils.validators import (
    body,
    clean_name,
    clean_threshold,
    require,
)

log = logging.getLogger(__name__)

bp = Blueprint("subjects", __name__, url_prefix="/api/subjects")


def _clean_code(value) -> str:
    """Normalise a subject code.

    Uppercased and space-stripped so ``cs 101`` and ``CS101`` collide on the
    unique index instead of becoming two subjects nobody can tell apart.
    """
    code = str(value or "").strip().upper().replace(" ", "")
    if not (2 <= len(code) <= 24):
        raise bad_request("Subject code must be 2-24 characters")
    return code


def _teacher_ids(raw, *, institution_id) -> list:
    """Validate that every supplied teacher id is staff in this institution."""
    if raw in (None, ""):
        return []
    if not isinstance(raw, (list, tuple)):
        raise bad_request("teacher_ids must be an array")
    ids = [oid(value) for value in raw]
    if not ids:
        return []
    found = list(
        db.users().find(
            {
                "_id": {"$in": ids},
                "institution_id": institution_id,
                "role": {"$in": list(Role.STAFF)},
            },
            {"_id": 1},
        )
    )
    if len(found) != len(set(ids)):
        valid = {str(f["_id"]) for f in found}
        raise bad_request(
            "One or more teacher ids are not staff in this institution",
            invalid=[str(i) for i in ids if str(i) not in valid],
        )
    return [f["_id"] for f in found]


def _teacher_directory(subjects) -> dict:
    ids = {t for s in subjects for t in (s.get("teacher_ids") or [])}
    if not ids:
        return {}
    return {
        str(u["_id"]): {"id": str(u["_id"]), "name": u.get("name"), "email": u.get("email")}
        for u in db.users().find({"_id": {"$in": list(ids)}}, {"name": 1, "email": 1})
    }


def _subject_view(subject, *, directory=None, roster_size=None, session_count=None) -> dict:
    directory = directory if directory is not None else _teacher_directory([subject])
    view = serialize_doc(subject)
    view["teachers"] = [
        directory.get(str(t), {"id": str(t), "name": "Unknown"})
        for t in (subject.get("teacher_ids") or [])
    ]
    if roster_size is not None:
        view["roster_size"] = roster_size
    if session_count is not None:
        view["session_count"] = session_count
    return view


# --------------------------------------------------------------------------- #
# CRUD
# --------------------------------------------------------------------------- #
@bp.get("")
@guards.role_required(*Role.STAFF)
def list_subjects():
    """Subjects the caller can act on.

    A teacher sees only their own; an admin sees the whole institution. Roster and
    session counts are fetched in two aggregate queries rather than per subject,
    so the dashboard's subject list is one round trip regardless of size.
    """
    query = guards.scope()
    if not guards.is_admin():
        query["teacher_ids"] = guards.current_user_id()
    if request.args.get("include_archived") not in ("1", "true", "yes"):
        query["archived"] = {"$ne": True}

    subjects = list(db.subjects().find(query).sort("name", 1))
    if not subjects:
        return jsonify({"subjects": []})

    subject_ids = [s["_id"] for s in subjects]
    roster_counts = {
        str(row["_id"]): row["count"]
        for row in db.enrollments().aggregate(
            [
                {"$match": {"subject_id": {"$in": subject_ids}}},
                {"$group": {"_id": "$subject_id", "count": {"$sum": 1}}},
            ]
        )
    }
    session_counts = {
        str(row["_id"]): row["count"]
        for row in db.sessions().aggregate(
            [
                {"$match": {"subject_id": {"$in": subject_ids}}},
                {"$group": {"_id": "$subject_id", "count": {"$sum": 1}}},
            ]
        )
    }
    directory = _teacher_directory(subjects)
    return jsonify(
        {
            "subjects": [
                _subject_view(
                    s,
                    directory=directory,
                    roster_size=roster_counts.get(str(s["_id"]), 0),
                    session_count=session_counts.get(str(s["_id"]), 0),
                )
                for s in subjects
            ]
        }
    )


@bp.post("")
@guards.role_required(*Role.STAFF)
def create_subject():
    """Create a subject.

    A teacher creating a subject is assigned to it automatically — otherwise they
    would immediately lose access to the thing they just made.
    """
    data = body()
    require(data, "name", "code")
    institution_id = guards.current_institution_id()

    teacher_ids = _teacher_ids(data.get("teacher_ids"), institution_id=institution_id)
    if not guards.is_admin():
        me = guards.current_user_id()
        if me not in teacher_ids:
            teacher_ids.append(me)

    threshold = (
        clean_threshold(data["attendance_threshold"], field="attendance_threshold")
        if data.get("attendance_threshold") is not None
        else None
    )
    doc = subject_doc(
        name=clean_name(data["name"]),
        code=_clean_code(data["code"]),
        institution_id=institution_id,
        teacher_ids=teacher_ids,
        attendance_threshold=threshold,
    )
    try:
        doc["_id"] = db.subjects().insert_one(doc).inserted_id
    except DuplicateKeyError:
        raise conflict(f"A subject with code {doc['code']} already exists.")

    audit.record(
        institution_id=institution_id,
        actor_id=guards.current_user_id(),
        action=AuditAction.SUBJECT_CREATED,
        target_id=doc["_id"],
        target_type="subject",
        new_state={"name": doc["name"], "code": doc["code"]},
    )
    return jsonify({"subject": _subject_view(doc, roster_size=0, session_count=0)}), 201


@bp.get("/<subject_id>")
@guards.role_required(*Role.STAFF)
def get_subject(subject_id: str):
    subject = guards.assert_can_manage_subject(
        db.subjects().find_one({"_id": oid(subject_id)})
    )
    institution = db.institutions().find_one({"_id": subject["institution_id"]})
    roster = attendance.roster_student_ids(subject["_id"])
    return jsonify(
        {
            "subject": _subject_view(
                subject,
                roster_size=len(roster),
                session_count=db.sessions().count_documents({"subject_id": subject["_id"]}),
            ),
            "effective_threshold": analytics.effective_threshold(subject, institution),
        }
    )


@bp.patch("/<subject_id>")
@guards.role_required(*Role.STAFF)
def update_subject(subject_id: str):
    subject = guards.assert_can_manage_subject(
        db.subjects().find_one({"_id": oid(subject_id)})
    )
    data = body()
    updates: dict = {}

    if data.get("name"):
        updates["name"] = clean_name(data["name"])
    if data.get("code"):
        updates["code"] = _clean_code(data["code"])
    if "attendance_threshold" in data:
        # Explicit null means "go back to inheriting the institution setting",
        # which is different from "no change" — hence the `in data` check.
        updates["attendance_threshold"] = (
            None
            if data["attendance_threshold"] is None
            else clean_threshold(data["attendance_threshold"], field="attendance_threshold")
        )
    if "archived" in data:
        updates["archived"] = bool(data["archived"])
    if "teacher_ids" in data:
        if not guards.is_admin():
            raise conflict("Only an admin can change which teachers are assigned to a subject.")
        teacher_ids = _teacher_ids(
            data["teacher_ids"], institution_id=subject["institution_id"]
        )
        if not teacher_ids:
            raise bad_request("A subject needs at least one assigned teacher")
        updates["teacher_ids"] = teacher_ids

    if not updates:
        raise bad_request("Nothing to update")

    updates["updated_at"] = utcnow()
    try:
        db.subjects().update_one({"_id": subject["_id"]}, {"$set": updates})
    except DuplicateKeyError:
        raise conflict(f"A subject with code {updates.get('code')} already exists.")

    audit.record(
        institution_id=subject["institution_id"],
        actor_id=guards.current_user_id(),
        action=AuditAction.SUBJECT_UPDATED,
        target_id=subject["_id"],
        target_type="subject",
        previous_state={k: subject.get(k) for k in updates if k != "updated_at"},
        new_state={k: v for k, v in updates.items() if k != "updated_at"},
    )
    fresh = db.subjects().find_one({"_id": subject["_id"]})
    return jsonify({"subject": _subject_view(fresh)})


@bp.delete("/<subject_id>")
@guards.role_required(*Role.STAFF)
def delete_subject(subject_id: str):
    """Delete a subject that has no sessions; archive it if it does.

    Hard-deleting a subject with recorded attendance would orphan those records
    and change every historical report, so the endpoint refuses and tells the
    caller to archive instead.
    """
    subject = guards.assert_can_manage_subject(
        db.subjects().find_one({"_id": oid(subject_id)})
    )
    session_count = db.sessions().count_documents({"subject_id": subject["_id"]})
    if session_count:
        raise conflict(
            f"This subject has {session_count} recorded session(s). Archive it instead of "
            f"deleting so its attendance history stays intact.",
            session_count=session_count,
            hint="PATCH this subject with {\"archived\": true}",
        )

    db.enrollments().delete_many({"subject_id": subject["_id"]})
    db.subjects().delete_one({"_id": subject["_id"]})

    audit.record(
        institution_id=subject["institution_id"],
        actor_id=guards.current_user_id(),
        action=AuditAction.SUBJECT_DELETED,
        target_id=subject["_id"],
        target_type="subject",
        previous_state={"name": subject.get("name"), "code": subject.get("code")},
    )
    return jsonify({"ok": True, "deleted": True})


# --------------------------------------------------------------------------- #
# Roster
# --------------------------------------------------------------------------- #
@bp.get("/<subject_id>/roster")
@guards.role_required(*Role.STAFF)
def get_roster(subject_id: str):
    """Who is enrolled, and whether each of them can be recognised from a photo."""
    subject = guards.assert_can_manage_subject(
        db.subjects().find_one({"_id": oid(subject_id)})
    )
    student_ids = attendance.roster_student_ids(subject["_id"])
    if not student_ids:
        return jsonify({"roster": [], "count": 0})

    directory = analytics.student_directory(student_ids)
    profiles = {
        str(s["_id"]): s for s in db.students().find({"_id": {"$in": student_ids}})
    }
    joined = {
        str(e["student_id"]): e.get("created_at")
        for e in db.enrollments().find(
            {"subject_id": subject["_id"]}, {"student_id": 1, "created_at": 1}
        )
    }
    roster = []
    for sid in student_ids:
        key = str(sid)
        profile = profiles.get(key, {})
        info = directory.get(key, {})
        roster.append(
            {
                "student_id": key,
                "name": info.get("name", "Unknown"),
                "email": info.get("email"),
                "roll_number": profile.get("roll_number"),
                "enrollment_status": profile.get("enrollment_status"),
                "face_enrolled": bool(profile.get("face_enrolled")),
                "voice_enrolled": bool(profile.get("voice_enrolled")),
                "joined_at": joined.get(key),
            }
        )
    roster.sort(key=lambda r: (r["name"] or "").lower())
    return jsonify({"roster": roster, "count": len(roster)})


@bp.post("/<subject_id>/roster")
@guards.role_required(*Role.STAFF)
def add_to_roster(subject_id: str):
    """Add students to a subject.

    Accepts ``student_ids`` (a list) so the UI can add a whole batch in one call.
    Already-enrolled students are reported rather than erroring, which makes the
    call safely repeatable.
    """
    subject = guards.assert_can_manage_subject(
        db.subjects().find_one({"_id": oid(subject_id)})
    )
    data = body()
    raw_ids = data.get("student_ids")
    if raw_ids in (None, "") and data.get("student_id"):
        raw_ids = [data["student_id"]]
    if not isinstance(raw_ids, (list, tuple)) or not raw_ids:
        raise bad_request("Provide student_ids as a non-empty array")

    institution_id = subject["institution_id"]
    requested = [oid(v) for v in raw_ids]
    # Confirm each student belongs to this institution before enrolling them.
    valid = {
        s["_id"]
        for s in db.students().find(
            {"_id": {"$in": requested}, "institution_id": institution_id}, {"_id": 1}
        )
    }
    rejected = [str(i) for i in requested if i not in valid]

    added, already = [], []
    for student_id in requested:
        if student_id not in valid:
            continue
        try:
            db.enrollments().insert_one(
                enrollment_doc(
                    subject_id=subject["_id"],
                    student_id=student_id,
                    institution_id=institution_id,
                )
            )
            added.append(str(student_id))
        except DuplicateKeyError:
            already.append(str(student_id))

    if added:
        audit.record(
            institution_id=institution_id,
            actor_id=guards.current_user_id(),
            action=AuditAction.ROSTER_ADDED,
            target_id=subject["_id"],
            target_type="subject",
            new_state={"student_ids": added},
            metadata={"count": len(added)},
        )
    return jsonify(
        {
            "ok": True,
            "added": added,
            "already_enrolled": already,
            "rejected": rejected,
            "roster_size": db.enrollments().count_documents({"subject_id": subject["_id"]}),
        }
    )


@bp.delete("/<subject_id>/roster/<student_id>")
@guards.role_required(*Role.STAFF)
def remove_from_roster(subject_id: str, student_id: str):
    """Remove a student from a subject.

    Their existing attendance records stay put deliberately: they really were in
    those classes, and deleting the rows would quietly alter past reports. Removal
    only stops future sessions from counting against them.
    """
    subject = guards.assert_can_manage_subject(
        db.subjects().find_one({"_id": oid(subject_id)})
    )
    result = db.enrollments().delete_one(
        {"subject_id": subject["_id"], "student_id": oid(student_id)}
    )
    if not result.deleted_count:
        raise bad_request("That student is not on this subject's roster")

    audit.record(
        institution_id=subject["institution_id"],
        actor_id=guards.current_user_id(),
        action=AuditAction.ROSTER_REMOVED,
        target_id=subject["_id"],
        target_type="subject",
        previous_state={"student_id": student_id},
        metadata={"note": "attendance history retained"},
    )
    return jsonify(
        {
            "ok": True,
            "removed": student_id,
            "roster_size": db.enrollments().count_documents({"subject_id": subject["_id"]}),
        }
    )


@bp.get("/<subject_id>/available-students")
@guards.role_required(*Role.STAFF)
def available_students(subject_id: str):
    """Institution students not yet on this roster — the "add students" picker."""
    subject = guards.assert_can_manage_subject(
        db.subjects().find_one({"_id": oid(subject_id)})
    )
    enrolled = set(attendance.roster_student_ids(subject["_id"]))
    students = list(
        db.students().find({"institution_id": subject["institution_id"]})
    )
    candidates = [s for s in students if s["_id"] not in enrolled]
    if not candidates:
        return jsonify({"students": []})

    user_ids = [s["user_id"] for s in candidates if s.get("user_id")]
    users = {
        u["_id"]: u
        for u in db.users().find(
            {"_id": {"$in": user_ids}, "status": {"$ne": UserStatus.DISABLED}},
            {"name": 1, "email": 1, "status": 1},
        )
    }
    rows = []
    for student in candidates:
        user = users.get(student.get("user_id"))
        if not user:
            continue  # disabled account — not offerable
        rows.append(
            {
                "student_id": str(student["_id"]),
                "name": user.get("name"),
                "email": user.get("email"),
                "roll_number": student.get("roll_number"),
                "enrollment_status": student.get("enrollment_status"),
                "face_enrolled": bool(student.get("face_enrolled")),
                "account_status": user.get("status"),
            }
        )
    rows.sort(key=lambda r: (r["name"] or "").lower())
    return jsonify({"students": rows, "count": len(rows)})
