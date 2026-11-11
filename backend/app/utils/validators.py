"""Input validation and normalisation.

Anything that arrives from a client passes through here before it touches the
database. Validation failures raise :class:`ApiError` (400/422) so they surface
as a clean JSON error rather than a stack trace.
"""
from __future__ import annotations

import csv
import io
import re
import unicodedata
from typing import Any, Iterable, Mapping, Sequence

from flask import request

from ..models.constants import VerificationMode
from .errors import bad_request, unprocessable

# Deliberately permissive but structurally strict. Full RFC 5322 validation is a
# famous rabbit hole and offers no practical benefit — the invite email either
# arrives or it does not, which is the real validation step.
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]$")

MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128  # bcrypt truncates at 72 bytes; reject early & loudly
MAX_NAME_LENGTH = 120
MAX_REASON_LENGTH = 500
MAX_CSV_ROWS = 1000


# --------------------------------------------------------------------------- #
# Request body access
# --------------------------------------------------------------------------- #
def body() -> dict:
    """Return the JSON body as a dict, or raise 400.

    ``silent=True`` stops Flask from raising its own HTML-ish 400 for malformed
    JSON so we can return our standard error envelope instead.
    """
    data = request.get_json(silent=True)
    if data is None:
        raise bad_request("Expected a JSON request body")
    if not isinstance(data, dict):
        raise bad_request("Request body must be a JSON object")
    return data


def require(data: Mapping, *fields: str) -> list[Any]:
    """Assert that every named field is present and non-empty.

    Reports *all* missing fields at once — a form that is missing three values
    should not require three round-trips to discover that.
    """
    missing = [f for f in fields if data.get(f) in (None, "", [], {})]
    if missing:
        raise unprocessable("Missing required fields", fields=missing)
    return [data[f] for f in fields]


# --------------------------------------------------------------------------- #
# Field normalisers
# --------------------------------------------------------------------------- #
def clean_email(value: Any, field: str = "email") -> str:
    """Lowercase + strip an email, validating shape.

    Emails are stored lowercased so the unique index on ``users.email`` actually
    prevents ``Ann@x.com`` and ``ann@x.com`` from becoming two accounts.
    """
    if not isinstance(value, str):
        raise unprocessable(f"{field} must be a string")
    email = value.strip().lower()
    if not EMAIL_RE.match(email):
        raise unprocessable(f"{value!r} is not a valid email address", field=field)
    if len(email) > 254:
        raise unprocessable("Email address is too long", field=field)
    return email


def clean_name(value: Any, field: str = "name") -> str:
    if not isinstance(value, str):
        raise unprocessable(f"{field} must be a string")
    # Collapse runs of whitespace so "John   Doe" and "John Doe" are one person.
    name = re.sub(r"\s+", " ", value).strip()
    if not name:
        raise unprocessable(f"{field} cannot be empty", field=field)
    if len(name) > MAX_NAME_LENGTH:
        raise unprocessable(f"{field} must be {MAX_NAME_LENGTH} characters or fewer", field=field)
    return name


def clean_password(value: Any, field: str = "password") -> str:
    if not isinstance(value, str):
        raise unprocessable("Password must be a string")
    if len(value) < MIN_PASSWORD_LENGTH:
        raise unprocessable(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters", field=field
        )
    if len(value.encode("utf-8")) > MAX_PASSWORD_LENGTH:
        raise unprocessable("Password is too long", field=field)
    return value


def clean_reason(value: Any, *, required: bool = True, field: str = "reason") -> str:
    """Validate an override/audit reason.

    Manual attendance overrides *require* a reason — that is a product rule from
    the brief, and enforcing it here means no route can forget to.
    """
    if value in (None, ""):
        if required:
            raise unprocessable("A reason is required for this action", field=field)
        return ""
    if not isinstance(value, str):
        raise unprocessable("Reason must be a string", field=field)
    reason = value.strip()
    if required and len(reason) < 3:
        raise unprocessable("Please give a slightly more descriptive reason", field=field)
    return reason[:MAX_REASON_LENGTH]


def slugify(value: str) -> str:
    """Turn an institution name into a URL-safe slug.

    NFKD-normalises first so "Université" becomes "universite" rather than
    losing the whole word to the ASCII filter.
    """
    normalised = unicodedata.normalize("NFKD", value)
    ascii_only = normalised.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_only).strip("-").lower()
    slug = re.sub(r"-{2,}", "-", slug)
    return slug[:50].strip("-")


def clean_slug(value: Any, field: str = "slug") -> str:
    slug = slugify(str(value or ""))
    if not SLUG_RE.match(slug):
        raise unprocessable(
            "Slug must be 3-50 characters of lowercase letters, numbers or hyphens",
            field=field,
        )
    return slug


def clean_verification_mode(value: Any) -> str:
    mode = str(value or "").strip()
    if mode not in VerificationMode.ALL:
        raise unprocessable(
            "Unknown verification mode",
            field="verification_mode",
            allowed=list(VerificationMode.ALL),
        )
    return mode


def clean_threshold(value: Any, field: str = "threshold") -> float:
    try:
        pct = float(value)
    except (TypeError, ValueError):
        raise unprocessable(f"{field} must be a number", field=field)
    if not 0 <= pct <= 100:
        raise unprocessable(f"{field} must be between 0 and 100", field=field)
    return round(pct, 2)


def clean_enum(value: Any, allowed: Sequence[str], field: str) -> str:
    text = str(value or "").strip()
    if text not in allowed:
        raise unprocessable(f"Invalid {field}", field=field, allowed=list(allowed))
    return text


def clamp_int(value: Any, default: int, *, minimum: int, maximum: int) -> int:
    """Parse a query-string integer, clamping instead of erroring.

    Used for pagination: a nonsensical ``?limit=99999`` should quietly become the
    max page size rather than fail the request.
    """
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


# --------------------------------------------------------------------------- #
# CSV bulk import
# --------------------------------------------------------------------------- #
def parse_student_csv(raw: bytes | str) -> tuple[list[dict], list[dict]]:
    """Parse a bulk student-import CSV into ``(valid_rows, errors)``.

    Expected header: ``name,email`` (case-insensitive, extra columns ignored).
    Header-less files are tolerated when the first cell does not look like a
    header, because that is by far the most common upload mistake.

    Returns partial success rather than rejecting the whole file: a 200-row CSV
    with two typos should import 198 students and report the two bad rows.
    """
    if isinstance(raw, bytes):
        # utf-8-sig strips the BOM Excel writes, which would otherwise turn the
        # first header into "﻿name" and break column lookup.
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.decode("latin-1", errors="replace")
    else:
        text = raw

    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise bad_request("The CSV file is empty")

    reader = csv.reader(io.StringIO(text))
    rows = [r for r in reader if any((cell or "").strip() for cell in r)]
    if not rows:
        raise bad_request("The CSV file has no data rows")

    header = [(c or "").strip().lower() for c in rows[0]]
    if "email" in header:
        name_idx = header.index("name") if "name" in header else None
        email_idx = header.index("email")
        data_rows = rows[1:]
        first_line_no = 2  # line 1 is the header
    else:
        # No recognisable header — assume "name,email" positional order.
        name_idx, email_idx = 0, 1
        data_rows = rows
        first_line_no = 1

    if len(data_rows) > MAX_CSV_ROWS:
        raise bad_request(
            f"CSV contains {len(data_rows)} rows; the limit is {MAX_CSV_ROWS} per import"
        )

    valid: list[dict] = []
    errors: list[dict] = []
    seen: set[str] = set()

    for offset, row in enumerate(data_rows):
        line_no = first_line_no + offset
        try:
            if email_idx >= len(row):
                raise unprocessable("Row is missing an email column")
            email = clean_email(row[email_idx])
            raw_name = row[name_idx] if name_idx is not None and name_idx < len(row) else ""
            # Fall back to the local-part of the email so a name-less row still
            # produces a usable display name instead of failing the import.
            name = clean_name(raw_name) if (raw_name or "").strip() else email.split("@")[0]
            if email in seen:
                errors.append({"line": line_no, "value": email, "error": "Duplicate row in file"})
                continue
            seen.add(email)
            valid.append({"name": name, "email": email})
        except Exception as exc:  # ApiError or anything unexpected in one row
            message = getattr(exc, "message", None) or str(exc)
            errors.append({"line": line_no, "value": ",".join(row)[:120], "error": message})

    return valid, errors


def as_str_set(values: Iterable[Any]) -> set[str]:
    return {str(v) for v in values if v not in (None, "")}
