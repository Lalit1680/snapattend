"""Shared fixtures.

Every test in this suite runs without MongoDB, without ChromaDB and without the
native face/voice stack. That is possible by design rather than by luck:

* ``create_app`` only creates indexes when ``MONGODB_URI`` is set and
  ``SKIP_INDEXES`` is not — ``app/__init__.py:122``;
* ``db.get_client()`` connects lazily on first use — ``app/db.py:28``;
* and every heavy import (``face_recognition``, ``cv2``, ``resemblyzer``,
  ``librosa``, ``chromadb``) happens inside the function that needs it, so
  importing the app costs nothing but Flask, pymongo and numpy.

The ``forbid_mongo`` fixture keeps it that way: a test that reaches for the
database fails immediately and says so, instead of spending eight seconds timing
out against whatever ``backend/.env`` happens to point at.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# backend/tests/conftest.py -> backend/
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# Written before ``app.config`` is imported, because ``Config`` reads the
# environment at class-definition time. A developer whose .env says
# FLASK_ENV=production would otherwise trip the deliberate RuntimeError in
# ``_check_config`` and every test would fail for the wrong reason.
os.environ["FLASK_ENV"] = "development"

from app import create_app, db  # noqa: E402  (must follow the sys.path/env setup)

#: Overrides shared by every app built in this suite. ``MONGODB_URI=""`` is
#: belt-and-braces next to ``SKIP_INDEXES``: it makes the index gate false no
#: matter what the developer's .env holds. Rate limiting is off because several
#: tests call one endpoint repeatedly, and a 429 from Flask-Limiter would read as
#: a route bug.
TEST_CONFIG = {
    "TESTING": True,
    "DEBUG": False,
    "SKIP_INDEXES": True,
    "MONGODB_URI": "",
    "RATELIMIT_ENABLED": False,
}


def build_app(**overrides):
    """A test app, with room for a per-test override.

    Used directly by the few tests that need a different config (DEBUG on, for
    the error-leak check) rather than the plain ``app`` fixture.
    """
    return create_app(**{**TEST_CONFIG, **overrides})


@pytest.fixture
def app():
    return build_app()


@pytest.fixture
def make_app():
    """The factory itself, for the few tests that need a different config.

    Handed over as a fixture rather than imported from this module, because
    ``tests/`` is deliberately not a package — pytest's rootdir insertion is what
    puts ``backend/`` on ``sys.path``, and a relative import would fight it.
    """
    return build_app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture(autouse=True)
def forbid_mongo(monkeypatch):
    """Turn an accidental database call into an immediate, obvious failure.

    Autouse, and it patches the one funnel every collection accessor goes
    through. A test that genuinely needs a document should patch the accessor it
    cares about (``db.users``, ``db.sessions``, …) — which shadows this and keeps
    the intent visible in the test itself.
    """

    def _refuse(*_args, **_kwargs):
        raise AssertionError(
            "This test tried to open a MongoDB connection. The suite is hermetic: "
            "patch the collection accessor you need, or move the test to an "
            "integration suite that owns a real database."
        )

    monkeypatch.setattr(db, "get_client", _refuse)
