"""Password hashing (bcrypt).

bcrypt is used rather than a raw SHA family hash because it is deliberately slow
and salted per-password. Two details that are easy to get wrong and are handled
explicitly here:

* **The 72-byte limit.** bcrypt silently truncates input beyond 72 bytes, which
  turns a long passphrase into a weaker one and makes two different long
  passwords interchangeable. We reject over-long input instead of truncating.
* **Timing.** ``verify_password`` runs the full hash comparison even when the
  user has no password set, so "no such account" and "wrong password" take
  comparable time and cannot be distinguished by an attacker enumerating emails.
"""
from __future__ import annotations

import logging

import bcrypt

log = logging.getLogger(__name__)

# Cost factor. 12 is ~250ms on typical 2024 hardware — high enough to be
# expensive to brute-force, low enough not to stall a login.
BCRYPT_ROUNDS = 12
_BCRYPT_MAX_BYTES = 72

# A valid hash of a value nobody can supply, used to burn the same CPU time when
# the account does not exist. Generated once at import.
_DUMMY_HASH = bcrypt.hashpw(b"snapattend-timing-equaliser", bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode()


class PasswordTooLong(ValueError):
    """Raised when a password exceeds bcrypt's usable input length."""


def hash_password(password: str) -> str:
    encoded = password.encode("utf-8")
    if len(encoded) > _BCRYPT_MAX_BYTES:
        raise PasswordTooLong(
            f"Password must be {_BCRYPT_MAX_BYTES} bytes or fewer once UTF-8 encoded"
        )
    return bcrypt.hashpw(encoded, bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode("utf-8")


def verify_password(password: str, password_hash: str | None) -> bool:
    """Check a password against a stored hash.

    Returns False for missing/invalid hashes but still performs a bcrypt
    comparison first, to keep the response time flat across all failure modes.
    """
    candidate = password.encode("utf-8")[:_BCRYPT_MAX_BYTES]
    stored = (password_hash or _DUMMY_HASH).encode("utf-8")
    try:
        matched = bcrypt.checkpw(candidate, stored)
    except (ValueError, TypeError) as exc:
        # Corrupt/legacy hash in the database — treat as a failed login, loudly.
        log.warning("Malformed password hash encountered: %s", exc)
        return False
    # An account with no password (invited but not yet activated) can never
    # authenticate, even if the dummy comparison somehow succeeded.
    return bool(matched and password_hash)
