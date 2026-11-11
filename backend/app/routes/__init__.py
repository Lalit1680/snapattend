"""Blueprint registry.

One list, one loop. Adding a route module means adding one import and one entry —
there is no decorator magic or filesystem scanning to trace through, which is
worth more than the three lines it saves.
"""
from __future__ import annotations

from flask import Flask

from . import (
    admin,
    analytics,
    attendance,
    auth,
    enroll,
    public,
    sessions,
    students,
    subjects,
)

# Order is irrelevant to Flask but reads as the shape of the product: who you are,
# what you administer, what you teach, who attends, and the one public page.
BLUEPRINTS = (
    auth.bp,        # /api/auth        — register, login, invites, password reset
    admin.bp,       # /api/admin       — institution settings, staff, audit, privacy
    subjects.bp,    # /api/subjects    — subjects and their rosters
    students.bp,    # /api/students    — student invites, CSV import, profiles
    sessions.bp,    # /api/sessions    — class sessions, QR, class photo, review queue
    attendance.bp,  # /api/attendance  — check-in, overrides, my attendance
    analytics.bp,   # /api/analytics   — reports, trends, defaulters, CSV
    enroll.bp,      # /api/enroll      — a student's own face/voice enrollment
    public.bp,      # /api/public      — unauthenticated QR scan landing
)


def register_blueprints(app: Flask) -> None:
    for blueprint in BLUEPRINTS:
        app.register_blueprint(blueprint)
