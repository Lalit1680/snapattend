"""A single error envelope for the whole API.

Every failure — raised, unhandled, or framework-generated — leaves the app as::

    {"error": {"code": "not_found", "message": "Session not found", "details": {}}}

The frontend's axios interceptor relies on that shape, so route code should
raise :class:`ApiError` rather than returning ad-hoc error dicts.
"""
from __future__ import annotations

import logging
import traceback

from flask import Flask, jsonify
from werkzeug.exceptions import HTTPException

log = logging.getLogger(__name__)


class ApiError(Exception):
    """An error we intend to show the client."""

    def __init__(
        self,
        message: str,
        status: int = 400,
        code: str | None = None,
        details: dict | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code or self._default_code(status)
        self.details = details or {}

    @staticmethod
    def _default_code(status: int) -> str:
        return {
            400: "bad_request",
            401: "unauthorized",
            403: "forbidden",
            404: "not_found",
            409: "conflict",
            413: "payload_too_large",
            422: "unprocessable",
            429: "rate_limited",
            500: "server_error",
            503: "service_unavailable",
        }.get(status, "error")

    def to_response(self):
        return (
            jsonify({"error": {"code": self.code, "message": self.message, "details": self.details}}),
            self.status,
        )


# --- Convenience constructors ---------------------------------------------
def bad_request(message: str, **details) -> ApiError:
    return ApiError(message, 400, details=details or None)


def unauthorized(message: str = "Authentication required") -> ApiError:
    return ApiError(message, 401)


def forbidden(message: str = "You do not have access to this resource") -> ApiError:
    return ApiError(message, 403)


def not_found(message: str = "Resource not found") -> ApiError:
    return ApiError(message, 404)


def conflict(message: str, **details) -> ApiError:
    return ApiError(message, 409, details=details or None)


def unprocessable(message: str, **details) -> ApiError:
    return ApiError(message, 422, details=details or None)


def register_error_handlers(app: Flask) -> None:
    @app.errorhandler(ApiError)
    def _handle_api_error(exc: ApiError):
        # 4xx are expected client mistakes: log quietly. 5xx get a stack trace.
        if exc.status >= 500:
            log.error("ApiError %s: %s", exc.status, exc.message, exc_info=True)
        else:
            log.info("ApiError %s (%s): %s", exc.status, exc.code, exc.message)
        return exc.to_response()

    @app.errorhandler(HTTPException)
    def _handle_http_error(exc: HTTPException):
        # Covers 404 on unknown routes, 405, and the 413 Flask raises when a
        # body exceeds MAX_CONTENT_LENGTH.
        return ApiError(
            exc.description or exc.name,
            exc.code or 500,
            code=ApiError._default_code(exc.code or 500),
        ).to_response()

    @app.errorhandler(Exception)
    def _handle_unexpected(exc: Exception):
        log.error("Unhandled exception: %s\n%s", exc, traceback.format_exc())
        # Never leak internals in production; the trace is in the server log.
        message = str(exc) if app.config.get("DEBUG") else "An unexpected error occurred"
        return ApiError(message, 500).to_response()
