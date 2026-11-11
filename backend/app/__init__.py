"""Application factory.

The factory pattern rather than a module-level ``app`` object, for one practical
reason: the tests and the cron scripts need to build an app with overridden
config, and a module-level app makes that impossible without import-time side
effects.

Startup deliberately does *not* fail on a missing MongoDB. A developer who has
cloned the repo and not yet filled in ``.env`` should get a running server that
says exactly what is wrong at ``/healthz``, not an import-time stack trace they
have to read backwards. Anything genuinely unsafe to run without — a default
``SECRET_KEY`` in production — is a hard failure instead.
"""
from __future__ import annotations

import logging
import os
import sys

from flask import Flask, jsonify

from . import db, vector_store
from .auth import guards
from .config import Config
from .extensions import cors, jwt, limiter, mail
from .routes import register_blueprints
from .services import face_crop_store, mailer
from .utils.errors import register_error_handlers
from .utils.timeutil import iso, utcnow

log = logging.getLogger(__name__)

__version__ = "1.0.0"


def _configure_logging(app: Flask) -> None:
    """Send logs to stdout at a level that matches the environment.

    Werkzeug's request log is left alone in debug and quietened in production,
    where an access log per dashboard poll is pure noise.
    """
    level = logging.DEBUG if app.config.get("DEBUG") else logging.INFO
    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
        )
        root.addHandler(handler)
    root.setLevel(level)
    if not app.config.get("DEBUG"):
        logging.getLogger("werkzeug").setLevel(logging.WARNING)
    # Chroma and pymongo are chatty at INFO and say nothing useful.
    logging.getLogger("chromadb").setLevel(logging.WARNING)
    logging.getLogger("pymongo").setLevel(logging.WARNING)


def _check_config(app: Flask) -> list[str]:
    """Warn loudly about missing settings; refuse to start if unsafe.

    Returns the list of missing names so ``/healthz`` can report them too.
    """
    missing = Config.missing_required()
    if not missing:
        return []

    is_production = os.getenv("FLASK_ENV", "development") == "production"
    if is_production:
        raise RuntimeError(
            f"Refusing to start in production with missing/insecure settings: "
            f"{', '.join(missing)}. Set them in backend/.env — see .env.example."
        )
    for name in missing:
        log.warning(
            "%s is not set. See backend/.env.example. The app will start, but "
            "features depending on it will fail until it is configured.",
            name,
        )
    return missing


def create_app(config_object: type[Config] | None = None, **overrides) -> Flask:
    """Build and return the Flask app.

    ``overrides`` is for tests (``create_app(TESTING=True)``); production reads
    everything from the environment via :class:`Config`.
    """
    app = Flask(__name__)
    config_object = config_object or Config
    app.config.from_object(config_object)
    app.config.update(overrides)

    _configure_logging(app)
    missing = _check_config(app)
    app.config["_MISSING_SETTINGS"] = missing

    # --- Extensions --------------------------------------------------------
    jwt.init_app(app)
    guards.register_jwt_callbacks(jwt)
    mail.init_app(app)
    mailer.init_app(app)
    limiter.init_app(app)
    # Credentials are not used: the frontend sends the JWT in an Authorization
    # header, so there is no cookie to protect and no need to relax the origin
    # check. Only the configured origins may read responses.
    cors.init_app(
        app,
        resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}},
        supports_credentials=False,
        expose_headers=["Content-Disposition"],  # so the browser can name CSV downloads
    )

    # --- Error envelope, then routes ---------------------------------------
    register_error_handlers(app)
    register_blueprints(app)
    _register_meta_routes(app)

    # --- Indexes -----------------------------------------------------------
    # Creating indexes at startup is idempotent in MongoDB, and doing it here
    # means a fresh Atlas cluster needs no migration step. A failure is logged and
    # tolerated so the server still boots to report the problem at /healthz.
    if app.config.get("MONGODB_URI") and not app.config.get("SKIP_INDEXES"):
        try:
            db.ensure_indexes()
            log.info("MongoDB indexes verified")
        except Exception as exc:  # noqa: BLE001 - startup must not hard-fail here
            log.error("Could not create MongoDB indexes: %s", exc)

    log.info(
        "SnapAttend %s ready (env=%s, mail=%s)",
        __version__,
        app.config.get("ENV"),
        "suppressed" if app.config.get("MAIL_SUPPRESS_SEND") else app.config.get("MAIL_SERVER"),
    )
    return app


def _register_meta_routes(app: Flask) -> None:
    """Root, health, and the 404 for unknown /api paths."""

    @app.get("/")
    def index():
        return jsonify(
            {
                "name": "SnapAttend API",
                "version": __version__,
                "docs": "See README.md for the endpoint reference.",
                "health": "/healthz",
            }
        )

    @app.get("/healthz")
    def healthz():
        """Dependency check for the three things that can independently break.

        Returns 200 when everything is reachable and 503 otherwise, so this is
        usable as a real readiness probe rather than a page that always says OK.
        """
        checks: dict = {}

        try:
            checks["mongodb"] = {
                "ok": db.ping(),
                "database": app.config.get("MONGODB_DB_NAME"),
                "configured": bool(app.config.get("MONGODB_URI")),
            }
        except Exception as exc:  # noqa: BLE001
            checks["mongodb"] = {"ok": False, "error": str(exc)}

        try:
            checks["chroma"] = {"ok": True, **vector_store.stats()}
        except Exception as exc:  # noqa: BLE001
            checks["chroma"] = {"ok": False, "error": str(exc)}

        checks["mail"] = {"ok": True, **mailer.describe()}

        try:
            # Cheap, and it is the one number that proves the retention rules are
            # holding — see services/face_crop_store.
            checks["face_crops"] = face_crop_store.privacy_report()
        except Exception as exc:  # noqa: BLE001
            checks["face_crops"] = {"error": str(exc)}

        healthy = all(c.get("ok", True) for c in checks.values())
        return (
            jsonify(
                {
                    "status": "ok" if healthy else "degraded",
                    "version": __version__,
                    "environment": app.config.get("ENV"),
                    "time": iso(utcnow()),
                    "missing_settings": app.config.get("_MISSING_SETTINGS") or [],
                    "checks": checks,
                }
            ),
            200 if healthy else 503,
        )
