"""Attendance analytics: percentages, trends, defaulters, CSV export.

The one subtlety worth reading before changing anything here is the
**denominator**.

A naive percentage is ``present_count / total_sessions_for_subject``. That is
wrong for any student who joined a class late: a student added in week 6 would
show 0% for weeks 1-5 and be flagged as a defaulter on their first day. So the
denominator is *sessions that started on or after the student joined the roster*
(``enrollments.created_at``), which is the number of classes they could actually
have attended.

Everything here is institution-scoped. The aggregations are small (one
institution's sessions), and the joins are done in Python rather than with
``$lookup`` because the shapes are tiny and the code stays legible.
"""
from __future__ import annotations

import csv
import io
import logging
from typing import Iterable, Mapping, Optional, Sequence

from bson import ObjectId

from .. import db
from ..models.constants import AttendanceStatus, SessionStatus
from ..utils.timeutil import ensure_aware, iso, utcnow

log = logging.getLogger(__name__)

# A session with no attendance activity at all and no photo processed is almost
# certainly a mis-click (created, then abandoned). Counting it would drag every
# student's percentage down, so it is excluded from denominators. See
# :func:`_countable_sessions`.
_EXCLUDE_EMPTY_SESSIONS = True


# --------------------------------------------------------------------------- #
# Shared building blocks
# --------------------------------------------------------------------------- #
def effective_threshold(subject: Optional[Mapping], institution: Optional[Mapping]) -> float:
    """Subject override, else institution setting, else the built-in default."""
    if subject and subject.get("attendance_threshold") is not None:
        return float(subject["attendance_threshold"])
    if institution:
        value = (institution.get("settings") or {}).get("attendance_threshold")
        if value is not None:
            return float(value)
    from ..config import Config  # local import: keeps this module Flask-free

    return float(Config.DEFAULT_ATTENDANCE_THRESHOLD)


def _sessions_for_subjects(
    subject_ids: Sequence[ObjectId],
    *,
    institution_id: ObjectId,
    since=None,
    until=None,
) -> list[dict]:
    if not subject_ids:
        return []
    query: dict = {
        "subject_id": {"$in": list(subject_ids)},
        "institution_id": institution_id,
    }
    time_filter: dict = {}
    if since:
        time_filter["$gte"] = since
    if until:
        time_filter["$lte"] = until
    if time_filter:
        query["start_time"] = time_filter
    return list(
        db.sessions()
        .find(query, {"subject_id": 1, "start_time": 1, "status": 1, "title": 1, "photo_processed_at": 1})
        .sort("start_time", 1)
    )


def _countable_sessions(sessions: Sequence[Mapping]) -> list[Mapping]:
    """Sessions that count toward a denominator.

    An ended session always counts (even if nobody showed up — a 0% class is real
    data). A still-active session only counts once something has happened in it,
    so a lesson the teacher opens five minutes early does not instantly show the
    whole class as absent.
    """
    if not _EXCLUDE_EMPTY_SESSIONS:
        return list(sessions)

    active_ids = [
        s["_id"] for s in sessions if s.get("status") == SessionStatus.ACTIVE
    ]
    touched: set[ObjectId] = set()
    if active_ids:
        touched = {
            row["_id"]
            for row in db.attendance_records().aggregate(
                [
                    {"$match": {"session_id": {"$in": active_ids}}},
                    {"$group": {"_id": "$session_id"}},
                ]
            )
        }
        touched |= {s["_id"] for s in sessions if s.get("photo_processed_at")}

    return [
        s
        for s in sessions
        if s.get("status") != SessionStatus.ACTIVE or s["_id"] in touched
    ]


def _present_counts(
    session_ids: Sequence[ObjectId],
) -> dict[tuple[str, str], int]:
    """``{(student_id, subject_id): present_count}`` across the given sessions."""
    if not session_ids:
        return {}
    rows = db.attendance_records().aggregate(
        [
            {
                "$match": {
                    "session_id": {"$in": list(session_ids)},
                    "status": AttendanceStatus.PRESENT,
                }
            },
            {
                "$group": {
                    "_id": {"student_id": "$student_id", "subject_id": "$subject_id"},
                    "count": {"$sum": 1},
                }
            },
        ]
    )
    return {
        (str(r["_id"]["student_id"]), str(r["_id"]["subject_id"])): int(r["count"])
        for r in rows
    }


def _joined_at_map(subject_ids: Sequence[ObjectId]) -> dict[tuple[str, str], object]:
    """``{(student_id, subject_id): joined_at}`` from the roster."""
    if not subject_ids:
        return {}
    return {
        (str(e["student_id"]), str(e["subject_id"])): ensure_aware(e.get("created_at"))
        for e in db.enrollments().find(
            {"subject_id": {"$in": list(subject_ids)}},
            {"student_id": 1, "subject_id": 1, "created_at": 1},
        )
    }


def _eligible_totals(
    sessions: Sequence[Mapping],
    joined_at: Mapping[tuple[str, str], object],
    pairs: Iterable[tuple[str, str]],
) -> dict[tuple[str, str], int]:
    """Per-(student, subject) count of sessions the student could have attended."""
    by_subject: dict[str, list] = {}
    for session in sessions:
        by_subject.setdefault(str(session["subject_id"]), []).append(
            ensure_aware(session.get("start_time"))
        )

    totals: dict[tuple[str, str], int] = {}
    for student_id, subject_id in pairs:
        starts = by_subject.get(subject_id, [])
        joined = joined_at.get((student_id, subject_id))
        if joined is None:
            totals[(student_id, subject_id)] = len(starts)
            continue
        totals[(student_id, subject_id)] = sum(
            1 for start in starts if start is None or start >= joined
        )
    return totals


def _percentage(present: int, total: int) -> float:
    """Round to one decimal. ``total == 0`` is 0%, not a division error."""
    if total <= 0:
        return 0.0
    return round(present * 100.0 / total, 1)


def student_directory(student_ids: Sequence[ObjectId]) -> dict[str, dict]:
    """``{student_id_str: {name, email, roll_number}}``."""
    if not student_ids:
        return {}
    students = list(
        db.students().find(
            {"_id": {"$in": list(student_ids)}}, {"user_id": 1, "roll_number": 1}
        )
    )
    user_ids = [s["user_id"] for s in students if s.get("user_id")]
    users = {
        u["_id"]: u
        for u in db.users().find({"_id": {"$in": user_ids}}, {"name": 1, "email": 1})
    }
    out: dict[str, dict] = {}
    for student in students:
        user = users.get(student.get("user_id")) or {}
        out[str(student["_id"])] = {
            "name": user.get("name") or user.get("email") or "Unknown",
            "email": user.get("email"),
            "roll_number": student.get("roll_number"),
        }
    return out


# --------------------------------------------------------------------------- #
# Subject-level reporting (teacher dashboard)
# --------------------------------------------------------------------------- #
def subject_report(
    *,
    subject: Mapping,
    institution: Optional[Mapping] = None,
    since=None,
    until=None,
) -> dict:
    """Per-student attendance for one subject, plus subject-level aggregates."""
    subject_id: ObjectId = subject["_id"]
    institution_id: ObjectId = subject["institution_id"]
    threshold = effective_threshold(subject, institution)

    all_sessions = _sessions_for_subjects(
        [subject_id], institution_id=institution_id, since=since, until=until
    )
    sessions = _countable_sessions(all_sessions)
    session_ids = [s["_id"] for s in sessions]

    student_ids = [
        e["student_id"]
        for e in db.enrollments().find({"subject_id": subject_id}, {"student_id": 1})
    ]
    directory = student_directory(student_ids)
    joined_at = _joined_at_map([subject_id])
    pairs = [(str(sid), str(subject_id)) for sid in student_ids]
    totals = _eligible_totals(sessions, joined_at, pairs)
    present = _present_counts(session_ids)

    rows: list[dict] = []
    for student_id in student_ids:
        key = (str(student_id), str(subject_id))
        attended = present.get(key, 0)
        total = totals.get(key, 0)
        info = directory.get(str(student_id), {})
        rows.append(
            {
                "student_id": str(student_id),
                "name": info.get("name", "Unknown"),
                "email": info.get("email"),
                "roll_number": info.get("roll_number"),
                "present": attended,
                "total": total,
                "absent": max(total - attended, 0),
                "percentage": _percentage(attended, total),
                "below_threshold": _percentage(attended, total) < threshold and total > 0,
            }
        )

    rows.sort(key=lambda r: (r["percentage"], r["name"].lower()))
    class_average = (
        round(sum(r["percentage"] for r in rows) / len(rows), 1) if rows else 0.0
    )
    return {
        "subject": {
            "id": str(subject_id),
            "name": subject.get("name"),
            "code": subject.get("code"),
        },
        "threshold": threshold,
        "sessions_total": len(sessions),
        "sessions_excluded": len(all_sessions) - len(sessions),
        "students_total": len(rows),
        "class_average": class_average,
        "defaulter_count": sum(1 for r in rows if r["below_threshold"]),
        "students": rows,
    }


def subject_trend(
    *, subject: Mapping, limit: int = 20, since=None, until=None
) -> dict:
    """Attendance rate per session, oldest first — the dashboard's line chart."""
    subject_id: ObjectId = subject["_id"]
    sessions = _countable_sessions(
        _sessions_for_subjects(
            [subject_id],
            institution_id=subject["institution_id"],
            since=since,
            until=until,
        )
    )
    if not sessions:
        return {"subject_id": str(subject_id), "points": []}

    sessions = sessions[-limit:] if limit and limit > 0 else sessions
    session_ids = [s["_id"] for s in sessions]

    counts = {
        str(r["_id"]): int(r["count"])
        for r in db.attendance_records().aggregate(
            [
                {
                    "$match": {
                        "session_id": {"$in": session_ids},
                        "status": AttendanceStatus.PRESENT,
                    }
                },
                {"$group": {"_id": "$session_id", "count": {"$sum": 1}}},
            ]
        )
    }

    # Roster size is taken as of each session, for the same late-joiner reason as
    # the per-student denominator.
    joined = [
        ensure_aware(e.get("created_at"))
        for e in db.enrollments().find({"subject_id": subject_id}, {"created_at": 1})
    ]

    points: list[dict] = []
    for session in sessions:
        start = ensure_aware(session.get("start_time"))
        eligible = sum(1 for j in joined if j is None or start is None or j <= start)
        attended = counts.get(str(session["_id"]), 0)
        points.append(
            {
                "session_id": str(session["_id"]),
                "date": iso(start),
                "label": session.get("title") or iso(start)[:10],
                "present": attended,
                "eligible": eligible,
                "percentage": _percentage(attended, eligible),
                "status": session.get("status"),
            }
        )
    return {"subject_id": str(subject_id), "points": points}


# --------------------------------------------------------------------------- #
# Student-level reporting (student portal + alerts)
# --------------------------------------------------------------------------- #
def student_report(
    *, student_id: ObjectId, institution_id: ObjectId, since=None, until=None
) -> dict:
    """One student's attendance across every subject they are enrolled in."""
    enrollments = list(
        db.enrollments().find(
            {"student_id": student_id}, {"subject_id": 1, "created_at": 1}
        )
    )
    subject_ids = [e["subject_id"] for e in enrollments]
    if not subject_ids:
        return {
            "student_id": str(student_id),
            "overall": {"present": 0, "total": 0, "percentage": 0.0},
            "subjects": [],
        }

    subjects = {
        s["_id"]: s
        for s in db.subjects().find(
            {"_id": {"$in": subject_ids}, "institution_id": institution_id}
        )
    }
    institution = db.institutions().find_one({"_id": institution_id})
    sessions = _countable_sessions(
        _sessions_for_subjects(
            list(subjects.keys()), institution_id=institution_id, since=since, until=until
        )
    )
    session_ids = [s["_id"] for s in sessions]
    joined_at = {
        (str(student_id), str(e["subject_id"])): ensure_aware(e.get("created_at"))
        for e in enrollments
    }
    pairs = [(str(student_id), str(sid)) for sid in subjects]
    totals = _eligible_totals(sessions, joined_at, pairs)
    present = _present_counts(session_ids)

    rows: list[dict] = []
    total_present = total_sessions = 0
    for subject_id, subject in subjects.items():
        key = (str(student_id), str(subject_id))
        attended = present.get(key, 0)
        total = totals.get(key, 0)
        threshold = effective_threshold(subject, institution)
        pct = _percentage(attended, total)
        total_present += attended
        total_sessions += total
        rows.append(
            {
                "subject_id": str(subject_id),
                "subject_name": subject.get("name"),
                "subject_code": subject.get("code"),
                "present": attended,
                "total": total,
                "absent": max(total - attended, 0),
                "percentage": pct,
                "threshold": threshold,
                "below_threshold": pct < threshold and total > 0,
            }
        )

    rows.sort(key=lambda r: r["percentage"])
    return {
        "student_id": str(student_id),
        "overall": {
            "present": total_present,
            "total": total_sessions,
            "percentage": _percentage(total_present, total_sessions),
        },
        "subjects": rows,
    }


def student_history(
    *, student_id: ObjectId, institution_id: ObjectId, limit: int = 50
) -> list[dict]:
    """Recent attendance rows for the student portal timeline."""
    records = list(
        db.attendance_records()
        .find({"student_id": student_id, "institution_id": institution_id})
        .sort("timestamp", -1)
        .limit(max(1, min(limit, 200)))
    )
    if not records:
        return []

    subject_ids = list({r["subject_id"] for r in records})
    subjects = {
        s["_id"]: s
        for s in db.subjects().find({"_id": {"$in": subject_ids}}, {"name": 1, "code": 1})
    }
    session_ids = list({r["session_id"] for r in records})
    sessions = {
        s["_id"]: s
        for s in db.sessions().find(
            {"_id": {"$in": session_ids}}, {"title": 1, "start_time": 1}
        )
    }

    out: list[dict] = []
    for record in records:
        subject = subjects.get(record["subject_id"], {})
        session = sessions.get(record["session_id"], {})
        out.append(
            {
                "session_id": str(record["session_id"]),
                "subject_id": str(record["subject_id"]),
                "subject_name": subject.get("name"),
                "subject_code": subject.get("code"),
                "session_title": session.get("title"),
                "session_start": iso(ensure_aware(session.get("start_time"))),
                "status": record.get("status"),
                "method_used": record.get("method_used"),
                "confidence_score": record.get("confidence_score"),
                "was_manual_override": bool(record.get("was_manual_override")),
                "marked_at": iso(ensure_aware(record.get("timestamp"))),
            }
        )
    return out


# --------------------------------------------------------------------------- #
# Cross-subject views (admin overview + alerts)
# --------------------------------------------------------------------------- #
def defaulters(
    *,
    institution_id: ObjectId,
    subject_ids: Optional[Sequence[ObjectId]] = None,
    threshold: Optional[float] = None,
    min_sessions: int = 1,
) -> list[dict]:
    """Students below the attendance threshold, worst first.

    ``min_sessions`` guards against flagging someone after a single missed class:
    a 0/1 record is 0% but says nothing useful yet.
    """
    institution = db.institutions().find_one({"_id": institution_id})
    subject_query: dict = {"institution_id": institution_id, "archived": {"$ne": True}}
    if subject_ids:
        subject_query["_id"] = {"$in": list(subject_ids)}
    subjects = {s["_id"]: s for s in db.subjects().find(subject_query)}
    if not subjects:
        return []

    sessions = _countable_sessions(
        _sessions_for_subjects(list(subjects.keys()), institution_id=institution_id)
    )
    session_ids = [s["_id"] for s in sessions]
    joined_at = _joined_at_map(list(subjects.keys()))
    pairs = list(joined_at.keys())
    totals = _eligible_totals(sessions, joined_at, pairs)
    present = _present_counts(session_ids)
    directory = student_directory([ObjectId(sid) for sid, _ in pairs])

    out: list[dict] = []
    for student_id, subject_id in pairs:
        subject = subjects.get(ObjectId(subject_id))
        if subject is None:
            continue
        limit = (
            float(threshold)
            if threshold is not None
            else effective_threshold(subject, institution)
        )
        total = totals.get((student_id, subject_id), 0)
        if total < max(min_sessions, 1):
            continue
        attended = present.get((student_id, subject_id), 0)
        pct = _percentage(attended, total)
        if pct >= limit:
            continue
        info = directory.get(student_id, {})
        out.append(
            {
                "student_id": student_id,
                "name": info.get("name", "Unknown"),
                "email": info.get("email"),
                "roll_number": info.get("roll_number"),
                "subject_id": subject_id,
                "subject_name": subject.get("name"),
                "subject_code": subject.get("code"),
                "present": attended,
                "total": total,
                "percentage": pct,
                "threshold": limit,
                "shortfall": round(limit - pct, 1),
            }
        )

    out.sort(key=lambda r: (r["percentage"], r["name"].lower()))
    return out


def institution_overview(institution_id: ObjectId) -> dict:
    """Headline numbers for the admin dashboard."""
    from ..models.constants import Role, UserStatus

    subjects = list(
        db.subjects().find(
            {"institution_id": institution_id, "archived": {"$ne": True}},
            {"name": 1, "code": 1, "attendance_threshold": 1},
        )
    )
    institution = db.institutions().find_one({"_id": institution_id})
    sessions = _countable_sessions(
        _sessions_for_subjects([s["_id"] for s in subjects], institution_id=institution_id)
    )
    session_ids = [s["_id"] for s in sessions]

    present_total = db.attendance_records().count_documents(
        {"institution_id": institution_id, "status": AttendanceStatus.PRESENT}
    )
    joined_at = _joined_at_map([s["_id"] for s in subjects])
    totals = _eligible_totals(sessions, joined_at, list(joined_at.keys()))
    present = _present_counts(session_ids)
    opportunities = sum(totals.values())
    attended = sum(present.get(key, 0) for key in totals)

    students_total = db.students().count_documents({"institution_id": institution_id})
    face_enrolled = db.students().count_documents(
        {"institution_id": institution_id, "face_enrolled": True}
    )
    voice_enrolled = db.students().count_documents(
        {"institution_id": institution_id, "voice_enrolled": True}
    )

    return {
        "students_total": students_total,
        "teachers_total": db.users().count_documents(
            {"institution_id": institution_id, "role": Role.TEACHER}
        ),
        "pending_invites": db.users().count_documents(
            {"institution_id": institution_id, "status": UserStatus.INVITED}
        ),
        "subjects_total": len(subjects),
        "sessions_total": len(sessions),
        "active_sessions": sum(
            1 for s in sessions if s.get("status") == SessionStatus.ACTIVE
        ),
        "attendance_records": present_total,
        "overall_attendance": _percentage(attended, opportunities),
        "face_enrolled": face_enrolled,
        "voice_enrolled": voice_enrolled,
        "enrollment_completion": _percentage(face_enrolled, students_total),
        "threshold": effective_threshold(None, institution),
        "generated_at": iso(utcnow()),
    }


def teacher_overview(*, institution_id: ObjectId, subject_ids: Sequence[ObjectId]) -> dict:
    """Per-subject summary cards for a teacher's landing page."""
    if not subject_ids:
        return {"subjects": [], "sessions_total": 0, "average_attendance": 0.0}

    institution = db.institutions().find_one({"_id": institution_id})
    subjects = list(db.subjects().find({"_id": {"$in": list(subject_ids)}}))
    sessions = _countable_sessions(
        _sessions_for_subjects(list(subject_ids), institution_id=institution_id)
    )
    session_ids = [s["_id"] for s in sessions]
    joined_at = _joined_at_map(list(subject_ids))
    totals = _eligible_totals(sessions, joined_at, list(joined_at.keys()))
    present = _present_counts(session_ids)

    roster_sizes: dict[str, int] = {}
    for _student_id, subject_id in joined_at:
        roster_sizes[subject_id] = roster_sizes.get(subject_id, 0) + 1

    cards: list[dict] = []
    for subject in subjects:
        sid = str(subject["_id"])
        subject_totals = {k: v for k, v in totals.items() if k[1] == sid}
        opportunities = sum(subject_totals.values())
        attended = sum(present.get(key, 0) for key in subject_totals)
        threshold = effective_threshold(subject, institution)
        below = 0
        for key, total in subject_totals.items():
            if total and _percentage(present.get(key, 0), total) < threshold:
                below += 1
        cards.append(
            {
                "subject_id": sid,
                "name": subject.get("name"),
                "code": subject.get("code"),
                "roster_size": roster_sizes.get(sid, 0),
                "sessions_total": sum(1 for s in sessions if str(s["subject_id"]) == sid),
                "average_attendance": _percentage(attended, opportunities),
                "defaulter_count": below,
                "threshold": threshold,
            }
        )

    cards.sort(key=lambda c: (c["name"] or "").lower())
    overall = round(
        sum(c["average_attendance"] for c in cards) / len(cards), 1
    ) if cards else 0.0
    return {
        "subjects": cards,
        "sessions_total": len(sessions),
        "average_attendance": overall,
    }


# --------------------------------------------------------------------------- #
# CSV export
# --------------------------------------------------------------------------- #
def subject_report_csv(report: Mapping) -> str:
    """Flatten a :func:`subject_report` into CSV text.

    ``\\r\\n`` line endings and a UTF-8 BOM are added by the route when it builds
    the response, because Excel needs both to open the file cleanly.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    subject = report.get("subject", {})
    writer.writerow(["Subject", subject.get("name", ""), subject.get("code", "")])
    writer.writerow(["Sessions counted", report.get("sessions_total", 0)])
    writer.writerow(["Threshold (%)", report.get("threshold", "")])
    writer.writerow(["Class average (%)", report.get("class_average", "")])
    writer.writerow(["Generated (UTC)", iso(utcnow())])
    writer.writerow([])
    writer.writerow(
        ["Roll number", "Name", "Email", "Present", "Absent", "Total", "Percentage", "Below threshold"]
    )
    for row in report.get("students", []):
        writer.writerow(
            [
                row.get("roll_number") or "",
                row.get("name", ""),
                row.get("email") or "",
                row.get("present", 0),
                row.get("absent", 0),
                row.get("total", 0),
                row.get("percentage", 0.0),
                "yes" if row.get("below_threshold") else "no",
            ]
        )
    return buffer.getvalue()


def session_csv(*, session: Mapping, rows: Sequence[Mapping], subject: Optional[Mapping]) -> str:
    """One session's roster with how each student was verified."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(["Session", session.get("title") or ""])
    writer.writerow(["Subject", (subject or {}).get("name", ""), (subject or {}).get("code", "")])
    writer.writerow(["Start (UTC)", iso(ensure_aware(session.get("start_time")))])
    writer.writerow(["Verification mode", session.get("verification_mode", "")])
    writer.writerow(["Generated (UTC)", iso(utcnow())])
    writer.writerow([])
    writer.writerow(
        ["Roll number", "Name", "Email", "Status", "Method", "Confidence", "Manual override", "Reason", "Marked at (UTC)"]
    )
    for row in rows:
        writer.writerow(
            [
                row.get("roll_number") or "",
                row.get("name", ""),
                row.get("email") or "",
                row.get("status", ""),
                row.get("method_used") or "",
                (
                    f"{round(float(row['confidence_score']) * 100)}%"
                    if row.get("confidence_score") is not None
                    else ""
                ),
                "yes" if row.get("was_manual_override") else "no",
                row.get("override_reason") or "",
                iso(ensure_aware(row.get("marked_at"))) if row.get("marked_at") else "",
            ]
        )
    return buffer.getvalue()


def student_report_csv(report: Mapping, *, student: Optional[Mapping] = None) -> str:
    """Flatten a :func:`student_report` into CSV text — one row per subject.

    Offered to students for their own record as well as to staff from the
    drill-down view. A student who believes a defaulter list is wrong is in a much
    better position holding the same numbers the report was built from.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    if student:
        writer.writerow(["Student", student.get("name", "")])
        writer.writerow(["Roll number", student.get("roll_number") or ""])
        writer.writerow(["Email", student.get("email") or ""])
    overall = report.get("overall", {})
    writer.writerow(["Overall present", overall.get("present", 0)])
    writer.writerow(["Overall sessions", overall.get("total", 0)])
    writer.writerow(["Overall percentage", overall.get("percentage", 0.0)])
    writer.writerow(["Generated (UTC)", iso(utcnow())])
    writer.writerow([])
    writer.writerow(
        ["Subject", "Code", "Present", "Absent", "Total", "Percentage", "Threshold", "Below threshold"]
    )
    for row in report.get("subjects", []):
        writer.writerow(
            [
                row.get("subject_name", ""),
                row.get("subject_code", ""),
                row.get("present", 0),
                row.get("absent", 0),
                row.get("total", 0),
                row.get("percentage", 0.0),
                row.get("threshold", ""),
                "yes" if row.get("below_threshold") else "no",
            ]
        )
    return buffer.getvalue()


def defaulters_csv(rows: Sequence[Mapping]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(["Generated (UTC)", iso(utcnow())])
    writer.writerow([])
    writer.writerow(
        ["Roll number", "Name", "Email", "Subject", "Code", "Present", "Total", "Percentage", "Threshold", "Shortfall"]
    )
    for row in rows:
        writer.writerow(
            [
                row.get("roll_number") or "",
                row.get("name", ""),
                row.get("email") or "",
                row.get("subject_name", ""),
                row.get("subject_code", ""),
                row.get("present", 0),
                row.get("total", 0),
                row.get("percentage", 0.0),
                row.get("threshold", ""),
                row.get("shortfall", ""),
            ]
        )
    return buffer.getvalue()
