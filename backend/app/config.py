"""Central configuration.

Values are read from environment variables (loaded from ``backend/.env`` via
python-dotenv). This module is intentionally free of Flask imports so that the
enrollment / matching pipelines and the standalone cron scripts can import it
without spinning up an app context.
"""
from __future__ import annotations

import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

# backend/app/config.py  ->  backend/
BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")


def _bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


class Config:
    """App configuration. Uppercase attributes are copied into ``app.config``."""

    # --- Flask / signing ---------------------------------------------------
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-only-insecure-secret-change-me")
    ENV = os.getenv("FLASK_ENV", "development")
    DEBUG = ENV == "development"
    # Hard cap on request bodies; Flask rejects larger uploads with a 413 before
    # they are buffered into memory. Set generously enough for a class photo.
    MAX_CONTENT_LENGTH = _int("MAX_UPLOAD_MB", 16) * 1024 * 1024
    JSON_SORT_KEYS = False

    # --- MongoDB -----------------------------------------------------------
    MONGODB_URI = os.getenv("MONGODB_URI", "")
    MONGODB_DB_NAME = os.getenv("MONGODB_DB_NAME", "Attendance_System")

    # --- JWT ---------------------------------------------------------------
    JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", SECRET_KEY)
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(minutes=_int("JWT_ACCESS_TOKEN_MINUTES", 30))
    JWT_REFRESH_TOKEN_EXPIRES = timedelta(days=_int("JWT_REFRESH_TOKEN_DAYS", 14))
    JWT_TOKEN_LOCATION = ["headers"]

    # --- Chroma ------------------------------------------------------------
    CHROMA_PERSIST_DIR = os.getenv("CHROMA_PERSIST_DIR", str(BACKEND_DIR / "chroma_data"))

    # --- Mail --------------------------------------------------------------
    MAIL_SERVER = os.getenv("MAIL_SERVER", "smtp.gmail.com")
    MAIL_PORT = _int("MAIL_PORT", 587)
    MAIL_USE_TLS = _bool("MAIL_USE_TLS", True)
    MAIL_USE_SSL = _bool("MAIL_USE_SSL", False)
    MAIL_USERNAME = os.getenv("MAIL_USERNAME", "")
    MAIL_PASSWORD = os.getenv("MAIL_PASSWORD", "")
    MAIL_DEFAULT_SENDER = os.getenv("MAIL_DEFAULT_SENDER", "SnapAttend <no-reply@snapattend.app>")
    # If SMTP creds are absent we suppress real sending and log to console so
    # local dev never crashes on a missing mail server.
    MAIL_SUPPRESS_SEND = _bool("MAIL_SUPPRESS_SEND", False) or not os.getenv("MAIL_USERNAME")

    # --- URLs / CORS -------------------------------------------------------
    FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173").rstrip("/")
    CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()]

    # --- Matching thresholds (cosine distance over unit-normalised vectors) -
    # Chroma cosine distance = 1 - cos(a, b). Because vector_store normalises
    # every vector, euclidean^2 == 2 * cosine_distance, so dlib's documented
    # Euclidean face tolerance of 0.6 corresponds to cosine 0.18. We default
    # tighter than that for auto-marking (0.12 ~= Euclidean 0.49) and treat the
    # band up to FACE_REVIEW_CEILING (0.28 ~= Euclidean 0.75) as "plausible,
    # ask the teacher".
    FACE_MATCH_THRESHOLD = _float("FACE_MATCH_THRESHOLD", 0.12)
    FACE_REVIEW_CEILING = _float("FACE_REVIEW_CEILING", 0.28)
    # A match is rejected as ambiguous when the runner-up is within this cosine
    # margin of the best hit — two students that look similarly close is a
    # review-queue item, not a coin flip.
    FACE_AMBIGUITY_MARGIN = _float("FACE_AMBIGUITY_MARGIN", 0.04)
    VOICE_MATCH_THRESHOLD = _float("VOICE_MATCH_THRESHOLD", 0.25)

    # --- Vision pipeline tuning -------------------------------------------
    # "hog" is CPU-fast and fine for well-lit frontal shots; "cnn" is markedly
    # better on angled/small faces in a dense class photo but needs a GPU to be
    # practical. Default to hog with one upsample pass as the sane CPU tradeoff.
    FACE_DETECTION_MODEL = os.getenv("FACE_DETECTION_MODEL", "hog")
    FACE_DETECTION_UPSAMPLE = _int("FACE_DETECTION_UPSAMPLE", 1)
    # Phone cameras produce 12MP+ images; detection cost scales with pixels, so
    # downscale first. Class photos keep more resolution than enrollment selfies
    # because their faces are much smaller in frame.
    CLASS_PHOTO_MAX_DIM = _int("CLASS_PHOTO_MAX_DIM", 2400)
    ENROLLMENT_PHOTO_MAX_DIM = _int("ENROLLMENT_PHOTO_MAX_DIM", 1200)
    # Faces smaller than this (in pixels, longest edge of the detected box) do
    # not carry enough detail for a trustworthy embedding — they are routed to
    # the review queue flagged low_resolution instead of being force-matched.
    MIN_FACE_PIXELS = _int("MIN_FACE_PIXELS", 48)
    # Upload guardrails.
    MAX_UPLOAD_MB = _int("MAX_UPLOAD_MB", 16)
    # How long review-queue face crops survive before the TTL sweep removes
    # them, even if the teacher never resolves the queue (privacy backstop).
    FACE_CROP_TTL_HOURS = _int("FACE_CROP_TTL_HOURS", 24)

    # --- QR ----------------------------------------------------------------
    QR_TOKEN_TTL_SECONDS = _int("QR_TOKEN_TTL_SECONDS", 30)

    # --- Token lifetimes ---------------------------------------------------
    INVITE_TOKEN_MAX_AGE_SECONDS = _int("INVITE_TOKEN_MAX_AGE_HOURS", 168) * 3600
    RESET_TOKEN_MAX_AGE_SECONDS = _int("RESET_TOKEN_MAX_AGE_MINUTES", 60) * 60

    # --- Attendance policy -------------------------------------------------
    DEFAULT_ATTENDANCE_THRESHOLD = _float("DEFAULT_ATTENDANCE_THRESHOLD", 75.0)

    # --- Rate limiting -----------------------------------------------------
    RATELIMIT_STORAGE_URI = os.getenv("RATELIMIT_STORAGE_URI", "memory://")
    RATELIMIT_HEADERS_ENABLED = True

    @classmethod
    def missing_required(cls) -> list[str]:
        """Return the names of required settings that are unset (for warnings)."""
        missing = []
        if not cls.MONGODB_URI:
            missing.append("MONGODB_URI")
        if cls.SECRET_KEY.startswith("dev-only"):
            missing.append("SECRET_KEY")
        return missing
