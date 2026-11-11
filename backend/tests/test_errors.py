"""The one error envelope.

``frontend/src/lib/api.js`` unwraps ``error.code``, ``error.message`` and
``error.details`` from every failure, and several pages branch on the code
(``ScanPage`` alone reads seven of them). These tests hold the shape still.
"""
from __future__ import annotations

import pytest

from app.utils.errors import (
    ApiError,
    bad_request,
    conflict,
    forbidden,
    not_found,
    unauthorized,
    unprocessable,
)

#: The whole of ``ApiError._default_code``. Mirrored in
#: ``frontend/src/lib/constants.js`` as the first half of ``ErrorCode``.
DEFAULT_CODES = {
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
}


@pytest.mark.parametrize(("status", "code"), sorted(DEFAULT_CODES.items()))
def test_status_maps_to_its_documented_code(status, code):
    assert ApiError("x", status).code == code


def test_an_unmapped_status_falls_through_to_error():
    assert ApiError("x", 418).code == "error"


def test_an_explicit_code_beats_the_status_default():
    # This is how `qr_rotated` and `mode_mismatch` reach the frontend on a 400.
    assert ApiError("x", 400, code="qr_rotated").code == "qr_rotated"


def test_defaults_are_a_400_with_empty_details():
    error = ApiError("Something went wrong")
    assert (error.status, error.code, error.details) == (400, "bad_request", {})
    assert error.message == "Something went wrong"
    # Still an Exception, so `raise` and `str()` behave as callers expect.
    assert str(error) == "Something went wrong"


@pytest.mark.parametrize(
    ("factory", "status"),
    [
        (bad_request, 400),
        (unauthorized, 401),
        (forbidden, 403),
        (not_found, 404),
        (conflict, 409),
        (unprocessable, 422),
    ],
)
def test_convenience_constructors_carry_their_status(factory, status):
    error = factory("Nope")
    assert error.status == status
    assert error.code == DEFAULT_CODES[status]


def test_keyword_details_become_the_details_object():
    error = unprocessable("Missing required fields", fields=["name", "email"])
    assert error.details == {"fields": ["name", "email"]}
    # `require()` reports every missing field at once so a form needs one round
    # trip, not three; the frontend renders them from this list.
    assert error.status == 422


def test_no_keywords_means_an_empty_details_object_not_null():
    # `details or None` inside the constructor could have made this None, which
    # would break `Object.entries(details)` on the client.
    assert bad_request("Nope").details == {}


def test_to_response_is_the_envelope_the_frontend_parses(app):
    with app.app_context():
        response, status = conflict("Already ended", session_id="abc").to_response()
    assert status == 409
    assert response.get_json() == {
        "error": {
            "code": "conflict",
            "message": "Already ended",
            "details": {"session_id": "abc"},
        }
    }


def _app_with_faults(make_app, **overrides):
    """An app with two routes that fail on purpose.

    ``PROPAGATE_EXCEPTIONS`` is pinned False because TESTING would otherwise let
    Flask re-raise past our handler in some versions, and the whole point here is
    to exercise the handler.
    """
    application = make_app(PROPAGATE_EXCEPTIONS=False, **overrides)

    @application.get("/api/_raises_api_error")
    def _api_error():
        raise ApiError("Your session has expired", 401, code="token_expired")

    @application.get("/api/_raises_bug")
    def _bug():
        raise RuntimeError("mongodb+srv://user:hunter2@cluster0")

    return application


def test_a_raised_api_error_becomes_its_envelope(make_app):
    response = _app_with_faults(make_app).test_client().get("/api/_raises_api_error")
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "token_expired"


def test_an_unexpected_exception_never_leaks_internals(make_app):
    response = _app_with_faults(make_app, DEBUG=False).test_client().get("/api/_raises_bug")
    assert response.status_code == 500
    error = response.get_json()["error"]
    assert error["code"] == "server_error"
    assert error["message"] == "An unexpected error occurred"
    # The trace goes to the server log; a connection string must not reach a client.
    assert "hunter2" not in response.get_data(as_text=True)


def test_debug_shows_the_real_message_for_local_work(make_app):
    response = _app_with_faults(make_app, DEBUG=True).test_client().get("/api/_raises_bug")
    assert response.status_code == 500
    assert "hunter2" in response.get_json()["error"]["message"]
