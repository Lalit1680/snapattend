"""Rotating session QR codes.

Threat model
------------
A static QR encoding just the session id is trivially defeated: one student
photographs it and messages it to friends who are not in the room. So the QR
encodes a **signature over (session_id, nonce)** where the nonce is rotated
server-side every ``QR_TOKEN_TTL_SECONDS``. A screenshot is therefore worthless
within ~30 seconds.

The grace window
----------------
Rotating strictly would fail any scan that lands in the moment between the
teacher's screen refreshing and the student's phone posting. That reads as a
random bug to users. We keep the *previous* nonce valid for one extra rotation,
which closes the race without meaningfully widening the sharing window.

Atomic rotation
---------------
The teacher dashboard polls for a fresh code, so two overlapping polls could both
decide to rotate. The conditional ``find_one_and_update`` below only succeeds if
the token is still expired, so exactly one poll wins and the other reads the
winner's token instead of clobbering it.
"""
from __future__ import annotations

import base64
import io
import logging
from typing import Mapping, Optional

from bson import ObjectId
from pymongo import ReturnDocument

from .. import db
from ..config import Config
from ..models.constants import SessionStatus, VerificationMode
from ..utils.errors import ApiError, bad_request
from ..utils.timeutil import ensure_aware, in_seconds, utcnow
from ..utils.tokens import make_qr_token, new_nonce, read_qr_token

log = logging.getLogger(__name__)


def _qr_target_url(token: str) -> str:
    """The URL encoded in the QR image.

    A URL (not a bare token) so a phone's built-in camera app can open it
    directly — the brief rules out a native app, and requiring students to open
    the web app first and then find a scanner would be needless friction.
    """
    return f"{Config.FRONTEND_URL}/scan?t={token}"


def render_qr_png_data_url(token: str, *, box_size: int = 10, border: int = 2) -> str:
    """Render the QR as a base64 PNG data URL.

    Returned inline rather than as a separate image endpoint because the token
    changes every 30 seconds: a URL would need cache-busting and could be fetched
    by anyone who guessed it, whereas the data URL travels inside the
    already-authenticated JSON response.
    """
    import qrcode
    from qrcode.constants import ERROR_CORRECT_M

    qr = qrcode.QRCode(
        version=None,          # auto-size to the payload
        error_correction=ERROR_CORRECT_M,  # tolerates ~15% damage/glare
        box_size=box_size,
        border=border,
    )
    qr.add_data(_qr_target_url(token))
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white")

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def ensure_fresh_token(session: Mapping, *, force: bool = False) -> dict:
    """Return a currently-valid QR token for ``session``, rotating if needed.

    Returns ``{token, expires_at, ttl_seconds, png_data_url, target_url}``.
    """
    if not VerificationMode.includes_qr(str(session.get("verification_mode"))):
        raise bad_request("This session's verification mode does not use QR check-in")
    if session.get("status") != SessionStatus.ACTIVE:
        raise bad_request("This session has ended; QR check-in is closed")

    session_id: ObjectId = session["_id"]
    now = utcnow()
    expiry = ensure_aware(session.get("qr_token_expiry"))
    existing_token = session.get("qr_current_token")

    if not force and existing_token and expiry and expiry > now:
        return {
            "token": existing_token,
            "expires_at": expiry,
            "ttl_seconds": max(0, int((expiry - now).total_seconds())),
            "png_data_url": render_qr_png_data_url(existing_token),
            "target_url": _qr_target_url(existing_token),
        }

    nonce = new_nonce()
    token = make_qr_token(session_id=str(session_id), nonce=nonce)
    new_expiry = in_seconds(Config.QR_TOKEN_TTL_SECONDS)

    # Only rotate if nobody else already has. `force` skips the expiry guard so an
    # explicit "regenerate" button always takes effect.
    guard: dict = {"_id": session_id, "status": SessionStatus.ACTIVE}
    if not force:
        guard["$or"] = [{"qr_token_expiry": None}, {"qr_token_expiry": {"$lte": now}}]

    updated = db.sessions().find_one_and_update(
        guard,
        {
            "$set": {
                "qr_current_token": token,
                "qr_current_nonce": nonce,
                # Retain the outgoing nonce for one rotation (the grace window).
                "qr_previous_nonce": session.get("qr_current_nonce"),
                "qr_token_expiry": new_expiry,
                "updated_at": now,
            }
        },
        return_document=ReturnDocument.AFTER,
    )

    if updated is None:
        # Another request rotated first (or the session just ended). Re-read and
        # return whatever is authoritative now rather than issuing a rival token.
        current = db.sessions().find_one({"_id": session_id})
        if not current or current.get("status") != SessionStatus.ACTIVE:
            raise bad_request("This session has ended; QR check-in is closed")
        updated = current

    live_token = updated.get("qr_current_token") or token
    live_expiry = ensure_aware(updated.get("qr_token_expiry")) or new_expiry
    return {
        "token": live_token,
        "expires_at": live_expiry,
        "ttl_seconds": max(0, int((live_expiry - now).total_seconds())),
        "png_data_url": render_qr_png_data_url(live_token),
        "target_url": _qr_target_url(live_token),
    }


def resolve_token(token: str) -> dict:
    """Validate a scanned token and return its session document.

    Failure modes are distinguished deliberately, because "the code on screen has
    refreshed, scan again" and "this link is not valid" require completely
    different reactions from the student.
    """
    if not token or not isinstance(token, str):
        raise bad_request("No QR token was supplied")

    payload = read_qr_token(token)  # raises token_expired / token_invalid
    session_id = payload.get("session_id")
    nonce = payload.get("nonce")
    if not session_id or not nonce:
        raise ApiError("This QR code is invalid.", 400, code="token_invalid")

    try:
        session = db.sessions().find_one({"_id": ObjectId(str(session_id))})
    except Exception:
        raise ApiError("This QR code is invalid.", 400, code="token_invalid")

    if not session:
        raise ApiError("This QR code refers to a session that no longer exists.", 404)
    if session.get("status") != SessionStatus.ACTIVE:
        raise ApiError(
            "This session has ended, so attendance can no longer be marked.",
            400,
            code="session_ended",
        )
    if not VerificationMode.includes_qr(str(session.get("verification_mode"))):
        raise ApiError("This session does not accept QR check-in.", 400, code="mode_mismatch")

    accepted_nonces = {
        n for n in (session.get("qr_current_nonce"), session.get("qr_previous_nonce")) if n
    }
    if nonce not in accepted_nonces:
        # Signature was fine, so this is a genuine (or shared) old code.
        raise ApiError(
            "This QR code has refreshed. Scan the code currently on screen.",
            400,
            code="qr_rotated",
        )

    expiry = ensure_aware(session.get("end_time"))
    if expiry and utcnow() > expiry:
        raise ApiError(
            "The check-in window for this session has closed.", 400, code="window_closed"
        )

    return session


def clear_token(session_id: ObjectId) -> None:
    """Invalidate a session's QR state. Called when a session ends."""
    db.sessions().update_one(
        {"_id": session_id},
        {
            "$set": {
                "qr_current_token": None,
                "qr_current_nonce": None,
                "qr_previous_nonce": None,
                "qr_token_expiry": None,
            }
        },
    )


def public_session_summary(session: Mapping, subject: Optional[Mapping]) -> dict:
    """Minimal session info for the mobile scan page.

    Intentionally sparse: this is rendered before we know whether the scanner is
    even a member of the institution, so it must not reveal a roster, attendance
    counts, or anything beyond what is already on the teacher's projected screen.
    """
    return {
        "session_id": str(session.get("_id")),
        "title": session.get("title"),
        "subject_name": (subject or {}).get("name"),
        "subject_code": (subject or {}).get("code"),
        "verification_mode": session.get("verification_mode"),
        "status": session.get("status"),
    }
