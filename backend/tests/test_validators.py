"""Field validation and normalisation.

Everything a client sends passes through this module. Two behaviours here are
product rules rather than hygiene, and both are asserted below: emails are stored
lowercased (so the unique index on ``users.email`` actually prevents duplicate
accounts), and a manual attendance override cannot be recorded without a reason.
"""
from __future__ import annotations

import pytest

from app.models.constants import VerificationMode
from app.utils.errors import ApiError
from app.utils.validators import (
    MAX_REASON_LENGTH,
    as_str_set,
    body,
    clamp_int,
    clean_email,
    clean_enum,
    clean_name,
    clean_password,
    clean_reason,
    clean_slug,
    clean_threshold,
    clean_verification_mode,
    require,
    slugify,
)


def test_body_returns_the_json_object(app):
    with app.test_request_context(json={"email": "ann@x.edu"}):
        assert body() == {"email": "ann@x.edu"}


@pytest.mark.parametrize("payload", ["[1, 2]", '"just a string"', "42", "null"])
def test_body_rejects_json_that_is_not_an_object(app, payload):
    with app.test_request_context(data=payload, content_type="application/json"):
        with pytest.raises(ApiError) as caught:
            body()
        assert caught.value.status == 400


def test_body_turns_malformed_json_into_our_envelope(app):
    # `silent=True` is what stops Flask returning its own HTML-ish 400 here.
    with app.test_request_context(data="{not json", content_type="application/json"):
        with pytest.raises(ApiError) as caught:
            body()
        assert caught.value.status == 400
        assert caught.value.code == "bad_request"


def test_require_returns_the_values_in_the_order_asked_for():
    data = {"email": "ann@x.edu", "name": "Ann", "extra": 1}
    assert require(data, "name", "email") == ["Ann", "ann@x.edu"]


def test_require_reports_every_missing_field_at_once():
    with pytest.raises(ApiError) as caught:
        require({"name": "Ann"}, "name", "email", "password")
    assert caught.value.status == 422
    assert caught.value.details == {"fields": ["email", "password"]}


@pytest.mark.parametrize("empty", [None, "", [], {}])
def test_require_treats_these_as_absent(empty):
    with pytest.raises(ApiError):
        require({"threshold": empty}, "threshold")


@pytest.mark.parametrize("present", [0, 0.0, False, "0"])
def test_require_accepts_a_falsy_but_real_value(present):
    # A threshold of 0 is a legitimate setting; rejecting it would be a bug that
    # only shows up for the one admin who tries it.
    assert require({"threshold": present}, "threshold") == [present]


def test_clean_email_lowercases_and_strips():
    assert clean_email("  Ann.Lee@Example.EDU  ") == "ann.lee@example.edu"


@pytest.mark.parametrize(
    "value",
    ["ann", "ann@", "@example.edu", "ann@example", "ann @example.edu", "ann@exam ple.edu", ""],
)
def test_clean_email_rejects_a_broken_shape(value):
    with pytest.raises(ApiError) as caught:
        clean_email(value)
    assert caught.value.status == 422


@pytest.mark.parametrize("value", [None, 42, ["ann@x.edu"]])
def test_clean_email_rejects_a_non_string(value):
    with pytest.raises(ApiError):
        clean_email(value)


def test_clean_email_rejects_an_address_that_is_too_long_for_the_index():
    with pytest.raises(ApiError) as caught:
        clean_email("a" * 250 + "@x.co")
    assert "too long" in caught.value.message


def test_clean_name_collapses_whitespace_so_one_person_is_one_row():
    assert clean_name("  John   \t Doe \n") == "John Doe"


@pytest.mark.parametrize("value", ["", "   ", "\n\t"])
def test_clean_name_rejects_an_empty_name(value):
    with pytest.raises(ApiError) as caught:
        clean_name(value)
    assert caught.value.status == 422


def test_clean_name_rejects_a_name_over_120_characters():
    with pytest.raises(ApiError):
        clean_name("a" * 121)


def test_clean_name_keeps_non_ascii_intact():
    # Only slugs are ASCII-folded; a student's own name is stored as written.
    assert clean_name("Zoë  Müller") == "Zoë Müller"


def test_clean_password_enforces_the_minimum_length():
    with pytest.raises(ApiError) as caught:
        clean_password("short")
    assert "at least 8" in caught.value.message


def test_clean_password_returns_the_password_unmodified():
    # No stripping: a leading space is a legitimate character in a passphrase.
    assert clean_password(" a long enough secret ") == " a long enough secret "


def test_clean_password_measures_bytes_not_characters():
    # bcrypt truncates at 72 bytes, so the cap has to be a byte count — 65 accented
    # characters are 130 bytes and must be refused even though they read as short.
    with pytest.raises(ApiError) as caught:
        clean_password("é" * 65)
    assert "too long" in caught.value.message


@pytest.mark.parametrize("value", [None, ""])
def test_clean_reason_is_required_for_an_override(value):
    # The product rule from the brief: a manual override always carries a reason.
    with pytest.raises(ApiError) as caught:
        clean_reason(value)
    assert caught.value.status == 422
    assert caught.value.details == {"field": "reason"}


def test_clean_reason_rejects_a_token_gesture():
    with pytest.raises(ApiError):
        clean_reason("ok")


def test_clean_reason_strips_and_keeps_a_real_one():
    assert clean_reason("  Was in the room, photo missed them  ") == (
        "Was in the room, photo missed them"
    )


def test_clean_reason_is_optional_where_the_route_says_so():
    assert clean_reason(None, required=False) == ""
    # The length floor only applies when a reason is mandatory.
    assert clean_reason("ok", required=False) == "ok"


def test_clean_reason_truncates_rather_than_rejecting_an_essay():
    assert len(clean_reason("x" * 900)) == MAX_REASON_LENGTH


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("Université de Paris", "universite-de-paris"),
        ("St. Xavier's College", "st-xavier-s-college"),
        ("  Trailing --- runs  ", "trailing-runs"),
        ("MIXED Case 42", "mixed-case-42"),
    ],
)
def test_slugify_folds_accents_instead_of_deleting_the_word(value, expected):
    # NFKD first is the point: a naive ASCII filter turns "Université" into
    # "universit" and loses the institution's name.
    assert slugify(value) == expected


def test_slugify_caps_at_fifty_characters_without_a_trailing_hyphen():
    slug = slugify("a" * 40 + " " + "b" * 40)
    assert len(slug) <= 50
    assert not slug.endswith("-")


def test_clean_slug_accepts_a_normal_institution_name():
    assert clean_slug("Springfield Community College") == "springfield-community-college"


@pytest.mark.parametrize("value", ["ab", "!!!", "", None, "   "])
def test_clean_slug_rejects_anything_that_cannot_make_three_characters(value):
    with pytest.raises(ApiError) as caught:
        clean_slug(value)
    assert caught.value.status == 422


@pytest.mark.parametrize("mode", VerificationMode.ALL)
def test_clean_verification_mode_accepts_every_declared_mode(mode):
    assert clean_verification_mode(mode) == mode


@pytest.mark.parametrize("value", ["face", "QR", "", None, "class_photo_voice"])
def test_clean_verification_mode_rejects_anything_else(value):
    with pytest.raises(ApiError) as caught:
        clean_verification_mode(value)
    # `allowed` is in the envelope so the client can say what the options were.
    assert caught.value.details["allowed"] == list(VerificationMode.ALL)


@pytest.mark.parametrize(("value", "expected"), [("75", 75.0), (75.456, 75.46), (0, 0.0), (100, 100.0)])
def test_clean_threshold_parses_and_rounds_to_two_places(value, expected):
    assert clean_threshold(value) == expected


@pytest.mark.parametrize("value", [-1, 101, "abc", None, ""])
def test_clean_threshold_rejects_anything_outside_a_percentage(value):
    with pytest.raises(ApiError) as caught:
        clean_threshold(value)
    assert caught.value.status == 422


def test_clean_enum_accepts_a_listed_value_and_strips_it():
    assert clean_enum(" present ", ["present", "absent"], "status") == "present"


def test_clean_enum_rejects_an_unlisted_value_and_says_what_was_allowed():
    with pytest.raises(ApiError) as caught:
        clean_enum("maybe", ["present", "absent"], "status")
    assert caught.value.details == {"field": "status", "allowed": ["present", "absent"]}


@pytest.mark.parametrize(
    ("value", "expected"),
    [("50", 50), (5000, 500), (0, 1), (-10, 1), ("nonsense", 100), (None, 100), ("", 100)],
)
def test_clamp_int_clamps_instead_of_erroring(value, expected):
    # `?limit=99999` on a report should quietly become the maximum page size; a
    # 422 there would be a worse answer than a large-but-bounded page.
    assert clamp_int(value, 100, minimum=1, maximum=500) == expected


def test_as_str_set_stringifies_and_drops_the_blanks():
    from bson import ObjectId

    ident = ObjectId("64f0a1b2c3d4e5f601234567")
    assert as_str_set([ident, "abc", None, "", ident]) == {str(ident), "abc"}
