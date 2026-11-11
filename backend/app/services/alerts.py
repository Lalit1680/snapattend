"""Low-attendance email alerts.

Deliberately a plain function rather than a task queue. The brief asks for "a
simple scheduled check (a periodic script/cron-style function is fine — don't
over-build a task queue for this)", and the workload matches: one pass over an
institution's rosters, a handful of emails, seconds of work. Celery + Redis for
that would be three moving parts to operate for no benefit.

It is invoked two ways, both calling the same :func:`run` function:

* ``python scripts/send_low_attendance_alerts.py`` — the cron entry point.
* The admin dashboard's "Send alerts now" button, so an admin can trigger and
  preview it without shell access.

Re-sending is prevented by ``alert_log``: a student is not alerted about the same
subject again until ``alert_cooldown_days`` have passed. Without that, a nightly
cron would email the same student every night until they attend, which is the
fastest way to get a feature muted by its users.
"""
from __future__ import annotations

import logging
from typing import Optional

from bson import ObjectId

from .. import db
from ..models.constants import AuditAction, Role, UserStatus
from ..models.schemas import alert_log_doc
from ..utils.timeutil import in_hours, utcnow
from . import analytics, audit, email_templates, mailer

log = logging.getLogger(__name__)

# A student with only a couple of recorded classes is not a defaulter yet, they
# are just early in the term. Alerting on 0/1 would be noise.
MIN_SESSIONS_BEFORE_ALERT = 4


def _cooldown_cutoff(days: int):
    return in_hours(-abs(days) * 24)


def run(
    *,
    institution_id: ObjectId,
    actor_id: Optional[ObjectId] = None,
    dry_run: bool = False,
    threshold_override: Optional[float] = None,
) -> dict:
    """Check one institution and queue alert emails for students below threshold.

    Returns a summary (``sent``/``skipped``/``candidates``) suitable both for the
    cron script's stdout and for the admin UI. ``dry_run`` computes everything and
    sends nothing — useful for confirming the list before the first real run.
    """
    institution = db.institutions().find_one({"_id": institution_id})
    if not institution:
        return {"error": "institution_not_found", "sent": [], "skipped": [], "candidates": 0}

    settings = institution.get("settings") or {}
    if not settings.get("low_attendance_alerts_enabled", True):
        return {
            "disabled": True,
            "sent": [],
            "skipped": [],
            "candidates": 0,
            "message": "Low-attendance alerts are turned off for this institution.",
        }

    cooldown_days = int(settings.get("alert_cooldown_days", 7) or 7)
    cutoff = _cooldown_cutoff(cooldown_days)

    rows = analytics.defaulters(
        institution_id=institution_id,
        threshold=threshold_override,
        min_sessions=MIN_SESSIONS_BEFORE_ALERT,
    )

    sent: list[dict] = []
    skipped: list[dict] = []

    for row in rows:
        student_id = ObjectId(row["student_id"])
        subject_id = ObjectId(row["subject_id"])

        recent = db.alert_log().find_one(
            {
                "student_id": student_id,
                "subject_id": subject_id,
                "sent_at": {"$gte": cutoff},
            }
        )
        if recent:
            skipped.append(
                {
                    "student_id": row["student_id"],
                    "subject": row["subject_name"],
                    "reason": f"alerted within the last {cooldown_days} day(s)",
                }
            )
            continue

        student = db.students().find_one({"_id": student_id}, {"user_id": 1})
        user = (
            db.users().find_one({"_id": student["user_id"]})
            if student and student.get("user_id")
            else None
        )
        if not user or not user.get("email"):
            skipped.append(
                {"student_id": row["student_id"], "subject": row["subject_name"], "reason": "no email on file"}
            )
            continue
        if user.get("status") != UserStatus.ACTIVE or user.get("role") != Role.STUDENT:
            # Don't email someone who never accepted their invite or has been
            # disabled — their percentage is an artefact, not a warning.
            skipped.append(
                {
                    "student_id": row["student_id"],
                    "subject": row["subject_name"],
                    "reason": f"account is {user.get('status')}",
                }
            )
            continue

        if dry_run:
            sent.append(
                {
                    "student_id": row["student_id"],
                    "email": user["email"],
                    "subject": row["subject_name"],
                    "percentage": row["percentage"],
                    "dry_run": True,
                }
            )
            continue

        subject_line, html = email_templates.low_attendance_alert(
            name=user.get("name") or user["email"],
            institution=institution.get("name", "your institution"),
            subject_name=row["subject_name"],
            percentage=row["percentage"],
            threshold=row["threshold"],
            present=row["present"],
            total=row["total"],
        )
        mailer.send(user["email"], subject_line, html)

        db.alert_log().insert_one(
            alert_log_doc(
                institution_id=institution_id,
                student_id=student_id,
                subject_id=subject_id,
                percentage=float(row["percentage"]),
                threshold=float(row["threshold"]),
            )
        )
        sent.append(
            {
                "student_id": row["student_id"],
                "email": user["email"],
                "subject": row["subject_name"],
                "percentage": row["percentage"],
            }
        )

    if sent and not dry_run:
        audit.record(
            institution_id=institution_id,
            actor_id=actor_id,
            action=AuditAction.ALERT_SENT,
            target_type="institution",
            target_id=institution_id,
            metadata={"alerts_sent": len(sent), "skipped": len(skipped)},
        )

    log.info(
        "Low-attendance alerts for %s: %s queued, %s skipped (dry_run=%s)",
        institution.get("name"),
        len(sent),
        len(skipped),
        dry_run,
    )
    return {
        "institution": institution.get("name"),
        "candidates": len(rows),
        "sent": sent,
        "skipped": skipped,
        "dry_run": dry_run,
        "cooldown_days": cooldown_days,
        "min_sessions": MIN_SESSIONS_BEFORE_ALERT,
        "checked_at": utcnow(),
    }


def run_all(*, dry_run: bool = False) -> list[dict]:
    """Run the check for every institution — what the cron script calls."""
    results: list[dict] = []
    for institution in db.institutions().find({}, {"_id": 1, "name": 1}):
        try:
            results.append(run(institution_id=institution["_id"], dry_run=dry_run))
        except Exception as exc:  # pragma: no cover - one tenant must not stop the rest
            log.error(
                "Alert run failed for institution %s: %s", institution.get("name"), exc, exc_info=True
            )
            results.append({"institution": institution.get("name"), "error": str(exc)})
    return results


def recent_alerts(institution_id: ObjectId, limit: int = 50) -> list[dict]:
    """Alert history for the admin panel."""
    rows = list(
        db.alert_log()
        .find({"institution_id": institution_id})
        .sort("sent_at", -1)
        .limit(max(1, min(limit, 200)))
    )
    if not rows:
        return []

    student_ids = list({r["student_id"] for r in rows})
    subject_ids = list({r["subject_id"] for r in rows})
    directory = analytics.student_directory(student_ids)
    subjects = {
        s["_id"]: s
        for s in db.subjects().find({"_id": {"$in": subject_ids}}, {"name": 1, "code": 1})
    }
    return [
        {
            "student_id": str(r["student_id"]),
            "student_name": directory.get(str(r["student_id"]), {}).get("name", "Unknown"),
            "subject_name": subjects.get(r["subject_id"], {}).get("name"),
            "percentage": r.get("percentage"),
            "threshold": r.get("threshold"),
            "sent_at": r.get("sent_at"),
        }
        for r in rows
    ]
