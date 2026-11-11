"""Small helpers shared by more than one route module.

Kept deliberately thin. Anything with real logic belongs in ``app/services``;
this file exists only for response-shaping that two blueprints would otherwise
duplicate.
"""
from __future__ import annotations

from flask import Response, request

from ..services import mailer
from ..utils.timeutil import parse_iso, utcnow

# Excel on Windows will not detect UTF-8 in a CSV without a byte-order mark, and
# renders accented names as mojibake. Every CSV export in the app goes out with
# the BOM for that reason — it is invisible to every other consumer.
UTF8_BOM = "﻿"


def csv_response(text: str, filename: str) -> Response:
    """Return CSV text as a downloadable file."""
    return Response(
        UTF8_BOM + text,
        mimetype="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # Reports are point-in-time; a cached copy is worse than a refetch.
            "Cache-Control": "no-store",
        },
    )


def invite_response(result: dict) -> dict:
    """JSON-safe view of an ``invites.create_invite`` result.

    ``invite_url`` is only echoed back when SMTP is not configured. In that mode
    there is no other way to complete the flow locally; with real mail configured
    the link belongs in the recipient's inbox and nowhere else.
    """
    payload = {
        "ok": True,
        "user_id": str(result["user_id"]),
        "invite_id": str(result["invite_id"]),
        "email": result["email"],
        "name": result["name"],
        "created_user": result["created_user"],
        "email_sent": mailer.is_configured(),
    }
    if not mailer.is_configured():
        payload["invite_url"] = result["invite_url"]
    return payload


def date_range() -> tuple:
    """Parse optional ``?since=`` / ``?until=`` ISO query params.

    Returns ``(None, None)`` when absent, which every analytics function reads as
    "all time". Unparseable values are ignored rather than rejected: a malformed
    date in a bookmarked dashboard URL should not blank the page.
    """
    return parse_iso(request.args.get("since")), parse_iso(request.args.get("until"))


def timestamped(prefix: str, extension: str = "csv") -> str:
    """Build a filename like ``attendance-cs101-20260830-1412.csv``."""
    stamp = utcnow().strftime("%Y%m%d-%H%M")
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in prefix).strip("-").lower()
    return f"{safe or 'export'}-{stamp}.{extension}"
