"""Reporting endpoints: percentages, trends, defaulters, and CSV exports.

Every number here comes out of ``services/analytics``, which owns two rules worth
restating because they are the difference between a report people trust and one
they argue with:

* **Late joiners are not punished.** A student's denominator counts only sessions
  held since they joined that subject's roster, not every session ever.
* **Empty sessions do not count.** A session where nobody was marked present is
  almost always a session that never really happened (a cancelled class, a
  mis-click), and letting it drag everyone's percentage down makes the whole
  report useless.

Scoping follows the same rule as the rest of the API: admins see the institution,
teachers see the subjects they teach. The filter is applied to the *query*, not to
the response, so a teacher cannot request a subject they do not own and get a 200
with an empty body — they get a 404.
"""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify, request

from .. import db
from ..auth import guards
from ..models.constants import AttendanceStatus, Role
from ..services import analytics, attendance
from ..utils.errors import bad_request
from ..utils.serialization import oid
from ..utils.validators import clamp_int, clean_threshold
from ._helpers import csv_response, date_range, timestamped

log = logging.getLogger(__name__)

bp = Blueprint("analytics", __name__, url_prefix="/api/analytics")


def _visible_subject_ids() -> list:
    """Subject ids the caller may report on."""
    if guards.is_admin():
        return [
            s["_id"]
            for s in db.subjects().find(
                {"institution_id": guards.current_institution_id()}, {"_id": 1}
            )
        ]
    return guards.teacher_subject_ids()


def _requested_subject_ids() -> list:
    """Honour an optional ``?subject_id=`` (repeatable), intersected with scope.

    Intersecting rather than trusting the parameter is the whole guard: passing
    another teacher's subject id narrows the result to nothing instead of widening
    access.
    """
    visible = _visible_subject_ids()
    requested = request.args.getlist("subject_id")
    if not requested:
        return visible
    allowed = {str(s) for s in visible}
    picked = [oid(value) for value in requested if str(oid(value)) in allowed]
    return picked


# --------------------------------------------------------------------------- #
# Overview
# --------------------------------------------------------------------------- #
@bp.get("/overview")
@guards.role_required(*Role.STAFF)
def overview():
    """Headline numbers for the dashboard landing card.

    Admins get the institution-wide view; teachers get one scoped to their own
    subjects, because "average attendance across the school" is not a teacher's
    number to see.
    """
    institution_id = guards.current_institution_id()
    if guards.is_admin():
        return jsonify(analytics.institution_overview(institution_id))
    return jsonify(
        analytics.teacher_overview(
            institution_id=institution_id, subject_ids=guards.teacher_subject_ids()
        )
    )


# --------------------------------------------------------------------------- #
# Per-subject
# --------------------------------------------------------------------------- #
@bp.get("/subjects/<subject_id>")
@guards.role_required(*Role.STAFF)
def subject_report(subject_id: str):
    """Per-student attendance percentages for one subject."""
    subject = guards.assert_can_manage_subject(
        db.subjects().find_one({"_id": oid(subject_id)})
    )
    institution = db.institutions().find_one({"_id": subject["institution_id"]})
    since, until = date_range()
    return jsonify(
        analytics.subject_report(
            subject=subject, institution=institution, since=since, until=until
        )
    )


@bp.get("/subjects/<subject_id>/trend")
@guards.role_required(*Role.STAFF)
def subject_trend(subject_id: str):
    """Session-by-session attendance rate — the dashboard's line chart.

    Returned oldest-first so the frontend can plot it without reversing, and
    capped at 60 points because a chart with 300 x-axis ticks is unreadable.
    """
    subject = guards.assert_can_manage_subject(
        db.subjects().find_one({"_id": oid(subject_id)})
    )
    limit = clamp_int(request.args.get("limit"), 20, minimum=2, maximum=60)
    since, until = date_range()
    trend = analytics.subject_trend(
        subject=subject, limit=limit, since=since, until=until
    )
    trend["subject"] = {
        "id": str(subject["_id"]),
        "name": subject.get("name"),
        "code": subject.get("code"),
    }
    return jsonify(trend)


@bp.get("/subjects/<subject_id>/export")
@guards.role_required(*Role.STAFF)
def export_subject(subject_id: str):
    """The subject report as a CSV download."""
    subject = guards.assert_can_manage_subject(
        db.subjects().find_one({"_id": oid(subject_id)})
    )
    institution = db.institutions().find_one({"_id": subject["institution_id"]})
    since, until = date_range()
    report = analytics.subject_report(
        subject=subject, institution=institution, since=since, until=until
    )
    text = analytics.subject_report_csv(report)
    return csv_response(text, timestamped(f"attendance-{subject.get('code', 'subject')}"))


# --------------------------------------------------------------------------- #
# Per-student
# --------------------------------------------------------------------------- #
@bp.get("/students/<student_id>")
@guards.role_required(*Role.STAFF)
def student_report(student_id: str):
    """One student across their subjects, filtered to what the caller may see."""
    student = guards.assert_same_institution(
        db.students().find_one({"_id": oid(student_id)}), what="student"
    )
    since, until = date_range()
    report = analytics.student_report(
        student_id=student["_id"],
        institution_id=student["institution_id"],
        since=since,
        until=until,
    )
    if not guards.is_admin():
        allowed = {str(s) for s in guards.teacher_subject_ids()}
        report["subjects"] = [r for r in report["subjects"] if r["subject_id"] in allowed]
        # The overall figure would otherwise include subjects this teacher cannot
        # see, which is both a leak and a number they cannot explain to anyone.
        report["overall"] = _recompute_overall(report["subjects"])
    return jsonify({"report": report})


def _recompute_overall(rows) -> dict:
    """Recalculate the headline percentage over a filtered subject list."""
    present = sum(int(r.get("present", 0)) for r in rows)
    total = sum(int(r.get("total", 0)) for r in rows)
    return {
        "present": present,
        "total": total,
        "percentage": round(present / total * 100, 1) if total else 0.0,
        "scoped_to_your_subjects": True,
    }


@bp.get("/students/<student_id>/export")
@guards.role_required(*Role.STAFF)
def export_student(student_id: str):
    """One student's record as CSV. Admin-only: teachers export by subject.

    A teacher's export would have to be silently truncated to their own subjects,
    and a CSV that looks complete but is not is worse than no CSV at all.
    """
    if not guards.is_admin():
        raise bad_request(
            "Per-student exports are admin-only. Export the subject report instead.",
            hint="GET /api/analytics/subjects/<subject_id>/export",
        )
    student = guards.assert_same_institution(
        db.students().find_one({"_id": oid(student_id)}), what="student"
    )
    user = db.users().find_one({"_id": student.get("user_id")}) or {}
    since, until = date_range()
    report = analytics.student_report(
        student_id=student["_id"],
        institution_id=student["institution_id"],
        since=since,
        until=until,
    )
    text = analytics.student_report_csv(
        report,
        student={
            "name": user.get("name"),
            "email": user.get("email"),
            "roll_number": student.get("roll_number"),
        },
    )
    label = student.get("roll_number") or user.get("name") or "student"
    return csv_response(text, timestamped(f"attendance-{label}"))


# --------------------------------------------------------------------------- #
# Defaulters
# --------------------------------------------------------------------------- #
@bp.get("/defaulters")
@guards.role_required(*Role.STAFF)
def defaulters():
    """Students below the attendance threshold.

    ``min_sessions`` defaults to 3 rather than 1 on purpose: flagging a student as
    a defaulter because they missed the single session held so far is technically
    correct and practically useless.
    """
    subject_ids = _requested_subject_ids()
    if not subject_ids:
        return jsonify({"defaulters": [], "count": 0, "threshold": None})

    threshold = (
        clean_threshold(request.args["threshold"])
        if request.args.get("threshold")
        else None
    )
    min_sessions = clamp_int(request.args.get("min_sessions"), 3, minimum=1, maximum=100)
    rows = analytics.defaulters(
        institution_id=guards.current_institution_id(),
        subject_ids=subject_ids,
        threshold=threshold,
        min_sessions=min_sessions,
    )
    return jsonify(
        {
            "defaulters": rows,
            "count": len(rows),
            "threshold": threshold,
            "min_sessions": min_sessions,
        }
    )


@bp.get("/defaulters/export")
@guards.role_required(*Role.STAFF)
def export_defaulters():
    """The defaulter list as CSV — the file that gets emailed to a department."""
    subject_ids = _requested_subject_ids()
    threshold = (
        clean_threshold(request.args["threshold"])
        if request.args.get("threshold")
        else None
    )
    min_sessions = clamp_int(request.args.get("min_sessions"), 3, minimum=1, maximum=100)
    rows = (
        analytics.defaulters(
            institution_id=guards.current_institution_id(),
            subject_ids=subject_ids,
            threshold=threshold,
            min_sessions=min_sessions,
        )
        if subject_ids
        else []
    )
    return csv_response(analytics.defaulters_csv(rows), timestamped("defaulters"))


# --------------------------------------------------------------------------- #
# Method breakdown
# --------------------------------------------------------------------------- #
@bp.get("/methods")
@guards.role_required(*Role.STAFF)
def method_breakdown():
    """How attendance was actually captured, by method.

    Not decoration. If ``face_photo_review`` dwarfs ``face_photo`` then the
    recognition threshold is mistuned or enrollment quality is poor, and this is
    the only place that shows it.
    """
    subject_ids = _requested_subject_ids()
    if not subject_ids:
        return jsonify({"methods": [], "total": 0})

    since, until = date_range()
    match: dict = {
        "institution_id": guards.current_institution_id(),
        "subject_id": {"$in": subject_ids},
        "status": AttendanceStatus.PRESENT,
    }
    if since or until:
        window = {}
        if since:
            window["$gte"] = since
        if until:
            window["$lte"] = until
        match["timestamp"] = window

    rows = list(
        db.attendance_records().aggregate(
            [
                {"$match": match},
                {"$group": {"_id": "$method_used", "count": {"$sum": 1}}},
                {"$sort": {"count": -1}},
            ]
        )
    )
    total = sum(int(r["count"]) for r in rows)
    return jsonify(
        {
            "methods": [
                {
                    "method": r["_id"] or "unknown",
                    "count": int(r["count"]),
                    "percentage": round(int(r["count"]) / total * 100, 1) if total else 0.0,
                }
                for r in rows
            ],
            "total": total,
        }
    )


# --------------------------------------------------------------------------- #
# Enrollment coverage
# --------------------------------------------------------------------------- #
@bp.get("/enrollment-coverage")
@guards.role_required(*Role.STAFF)
def enrollment_coverage():
    """How many students still owe biometrics, per subject.

    Face-photo attendance is only as good as its enrollment coverage, so this is
    the number a teacher should see before relying on it.
    """
    subject_ids = _requested_subject_ids()
    if not subject_ids:
        return jsonify({"subjects": []})

    subjects = list(db.subjects().find({"_id": {"$in": subject_ids}}, {"name": 1, "code": 1}))
    out = []
    for subject in subjects:
        roster = attendance.roster_student_ids(subject["_id"])
        if not roster:
            out.append(
                {
                    "subject_id": str(subject["_id"]),
                    "subject_name": subject.get("name"),
                    "subject_code": subject.get("code"),
                    "roster_size": 0,
                    "face_enrolled": 0,
                    "voice_enrolled": 0,
                    "face_coverage": 0.0,
                }
            )
            continue
        face = db.students().count_documents({"_id": {"$in": roster}, "face_enrolled": True})
        voice = db.students().count_documents({"_id": {"$in": roster}, "voice_enrolled": True})
        out.append(
            {
                "subject_id": str(subject["_id"]),
                "subject_name": subject.get("name"),
                "subject_code": subject.get("code"),
                "roster_size": len(roster),
                "face_enrolled": face,
                "voice_enrolled": voice,
                "face_coverage": round(face / len(roster) * 100, 1),
            }
        )
    out.sort(key=lambda r: r["face_coverage"])
    return jsonify({"subjects": out})
