"""Signed, expiring tokens for invites, password resets and rotating QR codes.

All three use ``itsdangerous.URLSafeTimedSerializer`` with a **distinct salt per
purpose**. The salt is what prevents cross-use: a password-reset token cannot be
replayed as a teacher invite even though both are signed with the same
``SECRET_KEY``.

Expiry is enforced at *verification* time via ``max_age``, so a token's lifetime
cannot be extended by a client holding on to it.
"""
from __future__ import annotations

import hashlib
import secrets
from typing import Any

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from ..config import Config
from .errors import ApiError

SALT_INVITE = "snapattend.invite.v1"
SALT_RESET = "snapattend.password-reset.v1"
SALT_QR = "snapattend.qr-session.v1"


def _serializer(salt: str) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(secret_key=Config.SECRET_KEY, salt=salt)


def _dumps(salt: str, payload: dict) -> str:
    return _serializer(salt).dumps(payload)


def _loads(salt: str, token: str, max_age: int, what: str) -> dict:
    try:
        data = _serializer(salt).loads(token, max_age=max_age)
    except SignatureExpired:
        raise ApiError(f"This {what} link has expired. Please request a new one.", 400, code="token_expired")
    except BadSignature:
        raise ApiError(f"This {what} link is invalid.", 400, code="token_invalid")
    if not isinstance(data, dict):
        raise ApiError(f"This {what} link is invalid.", 400, code="token_invalid")
    return data


def token_fingerprint(token: str) -> str:
    """SHA-256 of a token, for storage in Mongo.

    We keep only the hash so that a database leak cannot be replayed into live
    invite links — same reasoning as never storing raw passwords. Lookups hash
    the incoming token and compare, which is why ``invites.token_hash`` carries a
    unique index.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# Invites (teacher + student self-enrollment)
# --------------------------------------------------------------------------- #
def make_invite_token(*, email: str, institution_id: str, invite_type: str) -> str:
    return _dumps(
        SALT_INVITE,
        {
            "email": email,
            "institution_id": str(institution_id),
            "type": invite_type,
            # A random nonce makes every issued token unique even for the same
            # (email, institution) pair, so re-inviting invalidates nothing by
            # collision and each token hashes to its own row.
            "n": secrets.token_urlsafe(8),
        },
    )


def read_invite_token(token: str) -> dict:
    return _loads(SALT_INVITE, token, Config.INVITE_TOKEN_MAX_AGE_SECONDS, "invitation")


# --------------------------------------------------------------------------- #
# Password reset
# --------------------------------------------------------------------------- #
def make_reset_token(*, user_id: str, password_hash: str) -> str:
    """Issue a reset token bound to the current password hash.

    Embedding a fingerprint of the existing hash makes the token **single-use
    for free**: once the password changes the hash changes, so the fingerprint no
    longer matches and any outstanding reset link is dead. No extra table, no
    cleanup job.
    """
    return _dumps(
        SALT_RESET,
        {"user_id": str(user_id), "pw": hashlib.sha256(password_hash.encode()).hexdigest()[:16]},
    )


def read_reset_token(token: str) -> dict:
    return _loads(SALT_RESET, token, Config.RESET_TOKEN_MAX_AGE_SECONDS, "password reset")


def reset_token_matches_password(payload: dict, password_hash: str | None) -> bool:
    expected = hashlib.sha256((password_hash or "").encode()).hexdigest()[:16]
    return secrets.compare_digest(str(payload.get("pw", "")), expected)


# --------------------------------------------------------------------------- #
# Rotating session QR tokens
# --------------------------------------------------------------------------- #
def make_qr_token(*, session_id: str, nonce: str) -> str:
    """Sign a short-lived QR payload.

    The QR encodes a *signature over (session_id, nonce)*, never a bare session
    id — so a screenshot cannot be turned into a permanent check-in link. The
    nonce is rotated server-side every ``QR_TOKEN_TTL_SECONDS``; see
    ``services/qr.py`` for the rotation and grace-window logic.
    """
    return _dumps(SALT_QR, {"session_id": str(session_id), "nonce": nonce})


def read_qr_token(token: str, *, max_age: int | None = None) -> dict:
    # Twice the TTL: the signature stays valid slightly longer than the nonce so
    # a scan that lands right on a rotation boundary fails the *nonce* check with
    # a clear "code refreshed, try again" rather than an opaque signature error.
    age = max_age if max_age is not None else Config.QR_TOKEN_TTL_SECONDS * 2
    return _loads(SALT_QR, token, age, "QR code")


def new_nonce() -> str:
    return secrets.token_urlsafe(12)


def generic_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def constant_time_equals(a: Any, b: Any) -> bool:
    return secrets.compare_digest(str(a), str(b))
