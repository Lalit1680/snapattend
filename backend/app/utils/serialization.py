"""BSON <-> JSON serialisation.

Mongo documents contain ``ObjectId`` and ``datetime`` values that Flask's JSON
encoder cannot serialise. Rather than registering a custom global encoder (which
hides the conversion and makes it easy to leak internal fields), every route
passes documents through an explicit ``serialize_*`` function. That also gives
one obvious place to strip sensitive fields like ``password_hash``.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Iterable, Mapping

from bson import ObjectId
from bson.errors import InvalidId

from .errors import bad_request, not_found
from .timeutil import iso

# Fields that must never reach a client, regardless of which document they are
# on. Checked in serialize_doc as a defence-in-depth backstop.
_NEVER_SERIALIZE = {"password_hash", "token_hash", "crop_jpeg_b64"}


def oid(value: Any) -> ObjectId:
    """Coerce a client-supplied string into an ObjectId or raise a 400.

    Malformed IDs are a client bug, not a server error, and must not surface as
    a 500 — hence the explicit conversion at every boundary.
    """
    if isinstance(value, ObjectId):
        return value
    try:
        return ObjectId(str(value))
    except (InvalidId, TypeError, ValueError):
        raise bad_request(f"Malformed id: {value!r}")


def oid_or_none(value: Any) -> ObjectId | None:
    if value in (None, "", "null"):
        return None
    try:
        return ObjectId(str(value))
    except (InvalidId, TypeError, ValueError):
        return None


def require_found(doc: Any, message: str = "Resource not found"):
    if not doc:
        raise not_found(message)
    return doc


def _scalar(value: Any) -> Any:
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return iso(value)
    if isinstance(value, date):
        return value.isoformat()
    return value


def serialize_doc(doc: Mapping | None, *, drop: Iterable[str] = ()) -> dict | None:
    """Recursively convert a Mongo document to JSON-safe primitives.

    ``_id`` is renamed to ``id`` because the leading underscore is awkward in
    JavaScript and the frontend consistently expects ``id``.
    """
    if doc is None:
        return None

    drop_set = set(drop) | _NEVER_SERIALIZE
    out: dict[str, Any] = {}
    for key, value in doc.items():
        if key in drop_set:
            continue
        out_key = "id" if key == "_id" else key
        if isinstance(value, Mapping):
            out[out_key] = serialize_doc(value, drop=drop)
        elif isinstance(value, (list, tuple)):
            out[out_key] = [
                serialize_doc(v, drop=drop) if isinstance(v, Mapping) else _scalar(v) for v in value
            ]
        else:
            out[out_key] = _scalar(value)
    return out


def serialize_list(docs: Iterable[Mapping], *, drop: Iterable[str] = ()) -> list[dict]:
    return [serialize_doc(d, drop=drop) for d in docs if d is not None]
