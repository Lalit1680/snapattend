"""Timezone-aware time helpers.

Everything in SnapAttend is stored and compared in UTC. ``datetime.utcnow()`` is
deliberately avoided — it returns a *naive* datetime, and mixing naive and
aware datetimes (pymongo hands back aware ones because the client is
``tz_aware=True``) raises ``TypeError`` at the worst possible moment.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone


def utcnow() -> datetime:
    """Current time as a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


def in_seconds(seconds: float) -> datetime:
    return utcnow() + timedelta(seconds=seconds)


def in_hours(hours: float) -> datetime:
    return utcnow() + timedelta(hours=hours)


def ensure_aware(value: datetime | None) -> datetime | None:
    """Coerce a possibly-naive datetime to UTC-aware.

    Documents written by older code paths (or imported by hand) can carry naive
    datetimes; treating them as UTC is the correct interpretation here.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def parse_iso(value: str | None) -> datetime | None:
    """Parse an ISO-8601 string from the client into UTC-aware time.

    Accepts the trailing ``Z`` that ``Date.toISOString()`` produces, which
    ``datetime.fromisoformat`` only learned to handle in Python 3.11.
    """
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return ensure_aware(datetime.fromisoformat(text))
    except ValueError:
        return None


def iso(value: datetime | None) -> str | None:
    aware = ensure_aware(value)
    return aware.isoformat() if aware else None
