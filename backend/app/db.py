"""MongoDB access layer.

A single module-level :class:`~pymongo.MongoClient` is shared process-wide
(pymongo's client is thread-safe and pools connections internally — creating one
per request is a classic performance bug).

Collection accessors are thin helpers so route code reads as
``db.users().find_one(...)`` instead of stringly-typed collection names
scattered through the codebase.
"""
from __future__ import annotations

import logging
from typing import Optional

from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.collection import Collection
from pymongo.database import Database
from pymongo.errors import PyMongoError

from .config import Config

log = logging.getLogger(__name__)

_client: Optional[MongoClient] = None


def get_client() -> MongoClient:
    """Return the shared MongoClient, connecting lazily on first use."""
    global _client
    if _client is None:
        if not Config.MONGODB_URI:
            raise RuntimeError(
                "MONGODB_URI is not set. Copy backend/.env.example to backend/.env "
                "and paste your MongoDB Atlas connection string."
            )
        _client = MongoClient(
            Config.MONGODB_URI,
            serverSelectionTimeoutMS=8000,
            connectTimeoutMS=8000,
            tz_aware=True,          # always hand back timezone-aware datetimes
            appname="SnapAttend",
        )
    return _client


def get_db() -> Database:
    return get_client()[Config.MONGODB_DB_NAME]


# --- Collection accessors --------------------------------------------------
def institutions() -> Collection:
    return get_db()["institutions"]


def users() -> Collection:
    return get_db()["users"]


def students() -> Collection:
    return get_db()["students"]


def subjects() -> Collection:
    return get_db()["subjects"]


def enrollments() -> Collection:
    """Student <-> subject membership (a student takes many subjects)."""
    return get_db()["enrollments"]


def sessions() -> Collection:
    return get_db()["sessions"]


def attendance_records() -> Collection:
    return get_db()["attendance_records"]


def pending_face_matches() -> Collection:
    return get_db()["pending_face_matches"]


def audit_logs() -> Collection:
    return get_db()["audit_logs"]


def invites() -> Collection:
    """Outstanding email invites (teacher + student self-enrollment)."""
    return get_db()["invites"]


def alert_log() -> Collection:
    """Record of low-attendance alerts sent, to avoid re-spamming students."""
    return get_db()["alert_log"]


# --- Index setup -----------------------------------------------------------
def ensure_indexes() -> None:
    """Create the indexes the app relies on. Idempotent — safe on every boot.

    Two categories matter here:
      1. Uniqueness constraints that enforce data integrity at the DB level
         (email, institution slug, one attendance record per student/session).
      2. Compound indexes leading with ``institution_id``, because *every*
         tenant-scoped query filters on it — putting it first means those
         queries stay index-covered as the collections grow.
    """
    try:
        institutions().create_index([("slug", ASCENDING)], unique=True, name="uq_slug")

        users().create_index([("email", ASCENDING)], unique=True, name="uq_email")
        users().create_index(
            [("institution_id", ASCENDING), ("role", ASCENDING)], name="ix_inst_role"
        )

        students().create_index([("user_id", ASCENDING)], unique=True, name="uq_user")
        students().create_index(
            [("institution_id", ASCENDING), ("enrollment_status", ASCENDING)],
            name="ix_inst_status",
        )

        subjects().create_index(
            [("institution_id", ASCENDING), ("code", ASCENDING)],
            unique=True,
            name="uq_inst_code",
        )
        subjects().create_index([("teacher_ids", ASCENDING)], name="ix_teachers")

        enrollments().create_index(
            [("subject_id", ASCENDING), ("student_id", ASCENDING)],
            unique=True,
            name="uq_subject_student",
        )
        enrollments().create_index([("student_id", ASCENDING)], name="ix_student")

        sessions().create_index(
            [("institution_id", ASCENDING), ("status", ASCENDING), ("start_time", DESCENDING)],
            name="ix_inst_status_start",
        )
        sessions().create_index([("subject_id", ASCENDING), ("start_time", DESCENDING)], name="ix_subject_start")

        # One record per (session, student) — this unique index is what makes
        # attendance marking idempotent under double-submits and retries.
        attendance_records().create_index(
            [("session_id", ASCENDING), ("student_id", ASCENDING)],
            unique=True,
            name="uq_session_student",
        )
        attendance_records().create_index(
            [("institution_id", ASCENDING), ("student_id", ASCENDING), ("timestamp", DESCENDING)],
            name="ix_inst_student_ts",
        )
        attendance_records().create_index([("subject_id", ASCENDING)], name="ix_subject")

        pending_face_matches().create_index(
            [("session_id", ASCENDING), ("resolved", ASCENDING)], name="ix_session_resolved"
        )
        # TTL safety net: review-queue crops self-destruct after FACE_CROP_TTL_HOURS
        # even if the teacher never resolves the queue. Privacy requirement from
        # the brief — see services/face_crop_store.py, which owns the full
        # retention policy and documents every place face pixels can exist.
        pending_face_matches().create_index(
            [("expires_at", ASCENDING)], expireAfterSeconds=0, name="ttl_expires"
        )

        audit_logs().create_index(
            [("institution_id", ASCENDING), ("timestamp", DESCENDING)], name="ix_inst_ts"
        )

        invites().create_index([("token_hash", ASCENDING)], unique=True, name="uq_token_hash")
        invites().create_index([("email", ASCENDING), ("status", ASCENDING)], name="ix_email_status")

        alert_log().create_index(
            [("student_id", ASCENDING), ("subject_id", ASCENDING), ("sent_at", DESCENDING)],
            name="ix_student_subject_sent",
        )
        log.info("MongoDB indexes ensured on database '%s'", Config.MONGODB_DB_NAME)
    except PyMongoError as exc:
        # Don't take the app down over index creation — log loudly and continue,
        # so a transient Atlas hiccup at boot doesn't block local dev.
        log.warning("Could not ensure MongoDB indexes: %s", exc)


def ping() -> bool:
    """Return True when Atlas is reachable (used by the /healthz endpoint)."""
    try:
        get_client().admin.command("ping")
        return True
    except PyMongoError as exc:
        log.warning("MongoDB ping failed: %s", exc)
        return False
