"""BSON to JSON, and the fields that must never make the trip.

``_NEVER_SERIALIZE`` is the backstop for three genuinely dangerous fields:
``password_hash``, the invite ``token_hash``, and ``crop_jpeg_b64`` — the face
pixels the review queue holds. A regression here is a privacy incident, not a
formatting bug, so the recursive cases are tested as carefully as the flat one.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
from bson import ObjectId

from app.utils.errors import ApiError
from app.utils.serialization import (
    oid,
    oid_or_none,
    require_found,
    serialize_doc,
    serialize_list,
)

HEX = "64f0a1b2c3d4e5f601234567"
WHEN = datetime(2026, 3, 1, 9, 30, tzinfo=timezone.utc)


def test_oid_passes_an_objectid_straight_through():
    existing = ObjectId(HEX)
    assert oid(existing) is existing


def test_oid_parses_a_client_string():
    assert oid(HEX) == ObjectId(HEX)


@pytest.mark.parametrize("value", ["", "abc", "not-an-id", None, 42, {"a": 1}])
def test_oid_raises_a_400_not_a_500(value):
    # A malformed id in a URL is a client mistake. It used to be the easiest way
    # to get a stack trace out of the API.
    with pytest.raises(ApiError) as caught:
        oid(value)
    assert caught.value.status == 400
    assert "Malformed id" in caught.value.message


@pytest.mark.parametrize("value", [None, "", "null", "nonsense", 7])
def test_oid_or_none_swallows_everything_unusable(value):
    # Used for optional filters (`?subject_id=`), where absent and unparseable
    # should both mean "do not filter" rather than "reject the request".
    assert oid_or_none(value) is None


def test_oid_or_none_parses_a_real_id():
    assert oid_or_none(HEX) == ObjectId(HEX)


@pytest.mark.parametrize("empty", [None, {}, [], "", 0, False])
def test_require_found_raises_404_for_anything_falsy(empty):
    with pytest.raises(ApiError) as caught:
        require_found(empty, "Session not found")
    assert caught.value.status == 404
    assert caught.value.message == "Session not found"


def test_require_found_returns_the_document_it_was_given():
    doc = {"_id": ObjectId(HEX)}
    assert require_found(doc) is doc


def test_serialize_doc_passes_none_through():
    assert serialize_doc(None) is None


def test_serialize_doc_renames_id_and_flattens_bson_scalars():
    out = serialize_doc(
        {
            "_id": ObjectId(HEX),
            "subject_id": ObjectId(HEX),
            "start_time": WHEN,
            "term_starts": date(2026, 1, 5),
            "title": "Week 4 lab",
            "count": 12,
            "active": True,
            "notes": None,
        }
    )
    assert out["id"] == HEX
    assert "_id" not in out
    assert out["subject_id"] == HEX
    assert out["start_time"] == "2026-03-01T09:30:00+00:00"
    assert out["term_starts"] == "2026-01-05"
    # Everything else is handed over untouched, types included.
    assert out["title"] == "Week 4 lab"
    assert out["count"] == 12
    assert out["active"] is True
    assert out["notes"] is None


@pytest.mark.parametrize("secret", ["password_hash", "token_hash", "crop_jpeg_b64"])
def test_never_serialized_fields_are_dropped_without_being_asked(secret):
    out = serialize_doc({"_id": ObjectId(HEX), "email": "ann@x.edu", secret: "sensitive"})
    assert secret not in out
    assert out["email"] == "ann@x.edu"


@pytest.mark.parametrize("secret", ["password_hash", "token_hash", "crop_jpeg_b64"])
def test_never_serialized_fields_are_dropped_from_nested_documents(secret):
    # The review queue nests its items, so a flat-only check would have missed
    # the one field that carries actual face pixels.
    out = serialize_doc({"student": {"name": "Ann", secret: "sensitive"}})
    assert out["student"] == {"name": "Ann"}


@pytest.mark.parametrize("secret", ["password_hash", "token_hash", "crop_jpeg_b64"])
def test_never_serialized_fields_are_dropped_from_documents_inside_lists(secret):
    out = serialize_doc({"items": [{"id": 1, secret: "sensitive"}, {"id": 2}]})
    assert out["items"] == [{"id": 1}, {"id": 2}]


def test_drop_removes_extra_fields_and_reaches_nested_documents():
    out = serialize_doc(
        {"qr_nonce": "abc", "inner": {"qr_nonce": "abc", "keep": 1}},
        drop=("qr_nonce",),
    )
    assert out == {"inner": {"keep": 1}}


def test_serialize_doc_recurses_into_nested_documents_and_lists():
    out = serialize_doc(
        {
            "_id": ObjectId(HEX),
            "teacher": {"_id": ObjectId(HEX), "joined": WHEN},
            "teacher_ids": [ObjectId(HEX), ObjectId(HEX)],
            "records": [{"_id": ObjectId(HEX), "timestamp": WHEN}],
            "tags": ["lab", "week4"],
        }
    )
    assert out["teacher"] == {"id": HEX, "joined": "2026-03-01T09:30:00+00:00"}
    assert out["teacher_ids"] == [HEX, HEX]
    assert out["records"] == [{"id": HEX, "timestamp": "2026-03-01T09:30:00+00:00"}]
    assert out["tags"] == ["lab", "week4"]


def test_serialize_list_skips_none_entries():
    # `find_one` misses inside a comprehension are the usual source of these.
    assert serialize_list([{"_id": ObjectId(HEX)}, None]) == [{"id": HEX}]


def test_serialize_list_of_nothing_is_a_list_not_none():
    assert serialize_list([]) == []
