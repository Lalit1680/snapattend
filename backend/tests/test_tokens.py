"""Signed, expiring tokens (invites, password resets, rotating QR codes).

Every other module in ``app/utils`` has a matching test file
(``test_validators.py``, ``test_timeutil.py``, ``test_serialization.py``,
``test_errors.py``) except ``tokens.py`` — this fills that gap.

Nothing here touches Mongo or the network: ``itsdangerous`` signs and verifies
purely in-process, so these tests are as hermetic as the rest of the suite (see
``conftest.forbid_mongo``).
"""
from __future__ import annotations

import pytest
from itsdangerous import URLSafeTimedSerializer

from app.config import Config
from app.utils import tokens
from app.utils.errors import ApiError
from app.utils.tokens import (
    SALT_INVITE,
    constant_time_equals,
    generic_token,
    make_invite_token,
    make_qr_token,
    make_reset_token,
    new_nonce,
    read_invite_token,
    read_qr_token,
    read_reset_token,
    reset_token_matches_password,
    token_fingerprint,
)


# --------------------------------------------------------------------------- #
# Invite tokens
# --------------------------------------------------------------------------- #
def test_invite_token_round_trips_its_payload(app):
    with app.app_context():
        token = make_invite_token(email="ann@x.edu", institution_id="inst1", invite_type="teacher")
        data = read_invite_token(token)

    assert data["email"] == "ann@x.edu"
    assert data["institution_id"] == "inst1"
    assert data["type"] == "teacher"


def test_invite_token_coerces_institution_id_to_str(app):
    with app.app_context():
        token = make_invite_token(email="ann@x.edu", institution_id=123, invite_type="teacher")
        data = read_invite_token(token)

    assert data["institution_id"] == "123"


def test_invite_token_includes_a_random_nonce_so_reinvites_differ(app):
    with app.app_context():
        first = make_invite_token(email="ann@x.edu", institution_id="inst1", invite_type="teacher")
        second = make_invite_token(email="ann@x.edu", institution_id="inst1", invite_type="teacher")

    # Same inputs, different tokens -- and therefore different fingerprints,
    # which is what lets re-inviting someone not collide in `invites.token_hash`.
    assert first != second
    assert token_fingerprint(first) != token_fingerprint(second)


def test_invite_token_rejects_garbage(app):
    with app.app_context():
        with pytest.raises(ApiError) as caught:
            read_invite_token("not-a-real-token")

    assert caught.value.status == 400
    assert caught.value.code == "token_invalid"


def test_invite_token_rejects_a_token_signed_with_the_wrong_salt(app):
    with app.app_context():
        qr_token = make_qr_token(session_id="s1", nonce="n1")
        with pytest.raises(ApiError) as caught:
            read_invite_token(qr_token)

    # Cross-purpose replay must fail as an invalid token, not silently succeed.
    assert caught.value.code == "token_invalid"


def test_invite_token_expires(app):
    """A negative ``max_age`` is what makes this deterministic.

    ``TimestampSigner`` embeds whole seconds and raises on ``age > max_age``, where
    ``age = int(time.time()) - embedded``. Sleeping 1.1s and asking for
    ``max_age=1`` therefore computes an age of *either* 1 or 2 depending only on
    where in the second the token happened to be signed — so it expires about one
    run in ten. ``max_age=-1`` makes any age at all overdue, needs no sleep, and
    tests the same branch.
    """
    with app.app_context():
        token = make_invite_token(email="ann@x.edu", institution_id="inst1", invite_type="teacher")
        serializer = URLSafeTimedSerializer(secret_key=app.config["SECRET_KEY"], salt=SALT_INVITE)
        payload = serializer.loads(token)  # no max_age -- sanity check it's readable at all
        assert payload["email"] == "ann@x.edu"

        with pytest.raises(ApiError) as caught:
            from app.utils.tokens import _loads  # internal, but this is the expiry contract

            _loads(SALT_INVITE, token, max_age=-1, what="invitation")

    assert caught.value.status == 400
    assert caught.value.code == "token_expired"
    assert "expired" in caught.value.message.lower()


# --------------------------------------------------------------------------- #
# Password reset tokens
# --------------------------------------------------------------------------- #
def test_reset_token_round_trips_and_matches_the_bound_password_hash(app):
    with app.app_context():
        token = make_reset_token(user_id="u1", password_hash="hash-v1")
        data = read_reset_token(token)

    assert data["user_id"] == "u1"
    assert reset_token_matches_password(data, "hash-v1") is True


def test_reset_token_is_single_use_once_the_password_changes(app):
    """Changing the password changes its hash, which invalidates any
    outstanding reset link -- by design, with no extra table or cleanup job.
    """
    with app.app_context():
        token = make_reset_token(user_id="u1", password_hash="hash-v1")
        data = read_reset_token(token)

    assert reset_token_matches_password(data, "hash-v2-after-reset") is False


def test_reset_token_matches_password_handles_a_missing_hash(app):
    with app.app_context():
        token = make_reset_token(user_id="u1", password_hash="hash-v1")
        data = read_reset_token(token)

    assert reset_token_matches_password(data, None) is False


def test_reset_token_rejects_garbage(app):
    with app.app_context():
        with pytest.raises(ApiError) as caught:
            read_reset_token("garbage")

    assert caught.value.code == "token_invalid"


# --------------------------------------------------------------------------- #
# Rotating QR tokens
# --------------------------------------------------------------------------- #
def test_qr_token_round_trips_session_and_nonce(app):
    with app.app_context():
        token = make_qr_token(session_id="sess1", nonce="abc123")
        data = read_qr_token(token)

    assert data["session_id"] == "sess1"
    assert data["nonce"] == "abc123"


def test_qr_token_coerces_session_id_to_str(app):
    with app.app_context():
        token = make_qr_token(session_id=999, nonce="abc123")
        data = read_qr_token(token)

    assert data["session_id"] == "999"


def test_qr_token_default_max_age_is_twice_the_configured_ttl(app, monkeypatch):
    """A scan landing right on a rotation boundary should fail the *nonce*
    check with a clear message, not an opaque expired-signature error -- so the
    signature is deliberately valid for longer than one rotation window.

    Asserted by watching what ``read_qr_token`` hands to ``_loads``. Reaching for
    an internal is the only way to observe the derivation without controlling the
    clock, and the derivation is the whole contract here.
    """
    seen = {}

    def _spy(salt, token, max_age, what):
        seen.update(salt=salt, max_age=max_age, what=what)
        return {"session_id": "sess1", "nonce": "abc123"}

    monkeypatch.setattr(tokens, "_loads", _spy)
    with app.app_context():
        token = make_qr_token(session_id="sess1", nonce="abc123")
        assert tokens.read_qr_token(token)["nonce"] == "abc123"

    assert seen["max_age"] == Config.QR_TOKEN_TTL_SECONDS * 2
    assert seen["what"] == "QR code"


def test_qr_token_honours_an_explicit_max_age(app):
    with app.app_context():
        token = make_qr_token(session_id="sess1", nonce="abc123")
        # Comfortably inside the window: still readable.
        assert read_qr_token(token, max_age=60)["session_id"] == "sess1"


def test_qr_token_rejects_a_token_signed_with_the_wrong_salt(app):
    with app.app_context():
        reset_token = make_reset_token(user_id="u1", password_hash="hash-v1")
        with pytest.raises(ApiError) as caught:
            read_qr_token(reset_token)

    assert caught.value.code == "token_invalid"


def test_qr_token_expires(app):
    # Same whole-second alignment problem as the invite case above; -1 is overdue
    # for any signing time.
    with app.app_context():
        token = make_qr_token(session_id="sess1", nonce="abc123")
        with pytest.raises(ApiError) as caught:
            read_qr_token(token, max_age=-1)

    assert caught.value.code == "token_expired"


# --------------------------------------------------------------------------- #
# Fingerprints, nonces and generic helpers
# --------------------------------------------------------------------------- #
def test_token_fingerprint_is_deterministic_sha256_hex():
    fp1 = token_fingerprint("same-token")
    fp2 = token_fingerprint("same-token")

    assert fp1 == fp2
    assert len(fp1) == 64
    assert all(c in "0123456789abcdef" for c in fp1)


def test_token_fingerprint_differs_for_different_tokens():
    assert token_fingerprint("token-a") != token_fingerprint("token-b")


def test_new_nonce_and_generic_token_are_url_safe_and_unique():
    nonces = {new_nonce() for _ in range(20)}
    assert len(nonces) == 20  # no collisions in 20 draws

    tok = generic_token()
    assert isinstance(tok, str) and len(tok) > 0
    # url-safe base64 alphabet only
    assert all(c.isalnum() or c in "-_" for c in tok)


def test_generic_token_respects_nbytes():
    short = generic_token(nbytes=4)
    long = generic_token(nbytes=64)
    assert len(long) > len(short)


def test_constant_time_equals_compares_string_forms():
    assert constant_time_equals("abc", "abc") is True
    assert constant_time_equals("abc", "abd") is False
    # Non-string inputs are coerced via str(), same as production callers that
    # compare e.g. an int session id embedded in a payload.
    assert constant_time_equals(123, "123") is True