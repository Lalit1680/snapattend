"""Bulk student import.

``parse_student_csv`` is the one place in the app that returns *partial* success:
a 200-row file with two typos imports 198 students and reports the two bad rows,
because rejecting the whole upload over one malformed address is a worse answer
for the admin holding the spreadsheet. These tests pin both halves of that.
"""
from __future__ import annotations

import pytest

from app.utils.errors import ApiError
from app.utils.validators import MAX_CSV_ROWS, parse_student_csv


def test_the_documented_header_form():
    valid, errors = parse_student_csv("name,email\nAnn Lee,ann@x.edu\nBen Ray,ben@x.edu\n")
    assert errors == []
    assert valid == [
        {"name": "Ann Lee", "email": "ann@x.edu"},
        {"name": "Ben Ray", "email": "ben@x.edu"},
    ]


def test_a_headerless_file_is_read_as_name_then_email():
    # By far the most common upload mistake, and cheap to tolerate.
    valid, errors = parse_student_csv("Ann Lee,ann@x.edu\n")
    assert errors == []
    assert valid == [{"name": "Ann Lee", "email": "ann@x.edu"}]


def test_header_columns_are_found_by_name_not_position():
    valid, _ = parse_student_csv("email,name\nann@x.edu,Ann Lee\n")
    assert valid == [{"name": "Ann Lee", "email": "ann@x.edu"}]


def test_header_matching_ignores_case_and_padding():
    valid, _ = parse_student_csv("  NAME , Email \nAnn Lee,ann@x.edu\n")
    assert valid == [{"name": "Ann Lee", "email": "ann@x.edu"}]


def test_extra_columns_are_ignored():
    valid, errors = parse_student_csv("name,email,department\nAnn,ann@x.edu,Physics\n")
    assert errors == []
    assert valid == [{"name": "Ann", "email": "ann@x.edu"}]


def test_a_header_without_a_name_column_falls_back_to_the_email_local_part():
    # An import still has to produce a display name, and "ann" beats a failed row.
    valid, errors = parse_student_csv("email\nann@x.edu\n")
    assert errors == []
    assert valid == [{"name": "ann", "email": "ann@x.edu"}]


def test_a_blank_name_cell_falls_back_the_same_way():
    valid, errors = parse_student_csv("name,email\n   ,ann@x.edu\n")
    assert errors == []
    assert valid == [{"name": "ann", "email": "ann@x.edu"}]


def test_emails_are_lowercased_so_the_unique_index_can_do_its_job():
    valid, _ = parse_student_csv("name,email\nAnn,  ANN@X.EDU \n")
    assert valid == [{"name": "Ann", "email": "ann@x.edu"}]


def test_a_header_only_file_imports_nothing_and_complains_about_nothing():
    # The route reports "0 students imported"; this is not an error condition.
    assert parse_student_csv("name,email\n") == ([], [])


# --------------------------------------------------------------------------- #
# Encodings and line endings — i.e. "it came out of Excel"
# --------------------------------------------------------------------------- #
def test_the_excel_byte_order_mark_is_stripped():
    # Written as explicit bytes rather than a literal BOM character: a BOM in
    # source is invisible, and an editor that helpfully strips it would leave a
    # test that passes while checking nothing. Without utf-8-sig the first header
    # reads "﻿name" and column lookup falls through to the positional branch.
    raw = b"\xef\xbb\xbfname,email\nAnn Lee,ann@x.edu\n"
    valid, errors = parse_student_csv(raw)
    assert errors == []
    assert valid == [{"name": "Ann Lee", "email": "ann@x.edu"}]


@pytest.mark.parametrize("newline", ["\r\n", "\r", "\n"])
def test_every_line_ending_is_normalised(newline):
    raw = f"name,email{newline}Ann Lee,ann@x.edu{newline}"
    valid, errors = parse_student_csv(raw)
    assert errors == []
    assert valid == [{"name": "Ann Lee", "email": "ann@x.edu"}]


def test_a_file_that_is_not_utf8_still_imports():
    # Latin-1 is what a Windows export gives you often enough to matter. Refusing
    # the upload would leave the admin with no way to proceed.
    raw = b"name,email\nJos\xe9 Ruiz,jose@x.edu\n"
    valid, errors = parse_student_csv(raw)
    assert errors == []
    assert valid == [{"name": "José Ruiz", "email": "jose@x.edu"}]


# --------------------------------------------------------------------------- #
# Whole-file rejections
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("raw", ["", "   ", "\n\n", b"", b"\r\n"])
def test_an_empty_upload_is_rejected_outright(raw):
    with pytest.raises(ApiError) as caught:
        parse_student_csv(raw)
    assert caught.value.status == 400
    assert caught.value.code == "bad_request"
    assert "empty" in caught.value.message


def test_a_file_of_nothing_but_separators_is_rejected():
    # Excel writes these when a user deletes the contents of a few rows.
    with pytest.raises(ApiError) as caught:
        parse_student_csv(",,\n,,\n")
    assert "no data rows" in caught.value.message


def test_too_many_rows_is_rejected_before_any_are_parsed():
    over = MAX_CSV_ROWS + 1
    raw = "name,email\n" + "".join(f"Student {i},s{i}@x.edu\n" for i in range(over))
    with pytest.raises(ApiError) as caught:
        parse_student_csv(raw)
    assert caught.value.status == 400
    # The count and the limit are both in the message so the admin knows how far
    # over they are and can split the file.
    assert str(over) in caught.value.message
    assert str(MAX_CSV_ROWS) in caught.value.message


def test_exactly_the_limit_is_allowed():
    raw = "name,email\n" + "".join(f"Student {i},s{i}@x.edu\n" for i in range(MAX_CSV_ROWS))
    valid, errors = parse_student_csv(raw)
    assert len(valid) == MAX_CSV_ROWS
    assert errors == []


# --------------------------------------------------------------------------- #
# Partial success: the reason this returns two lists
# --------------------------------------------------------------------------- #
def test_one_bad_address_does_not_cost_the_admin_the_other_rows():
    valid, errors = parse_student_csv(
        "name,email\nAnn,ann@x.edu\nBen,not-an-email\nCal,cal@x.edu\n"
    )
    assert [row["email"] for row in valid] == ["ann@x.edu", "cal@x.edu"]
    assert len(errors) == 1
    assert errors[0]["line"] == 3
    assert errors[0]["value"] == "Ben,not-an-email"
    assert "not a valid email address" in errors[0]["error"]


def test_a_row_with_no_email_column_is_reported_not_guessed():
    valid, errors = parse_student_csv("name,email\nAnn,ann@x.edu\nJust A Name\n")
    assert len(valid) == 1
    assert errors == [{"line": 3, "value": "Just A Name", "error": "Row is missing an email column"}]


def test_a_duplicate_is_reported_once_and_the_first_wins():
    valid, errors = parse_student_csv("name,email\nAnn Lee,ann@x.edu\nAnn L,ann@x.edu\n")
    assert valid == [{"name": "Ann Lee", "email": "ann@x.edu"}]
    # `value` is the email here rather than the raw row -- it is the thing that
    # collided, and it is what the admin needs to find in their spreadsheet.
    assert errors == [{"line": 3, "value": "ann@x.edu", "error": "Duplicate row in file"}]


def test_duplicate_detection_uses_the_normalised_email():
    # Same normalisation as the unique index, or the import would pass rows that
    # the database then rejects.
    valid, errors = parse_student_csv("name,email\nAnn,ann@x.edu\nAnn,ANN@X.EDU\n")
    assert len(valid) == 1
    assert errors[0]["error"] == "Duplicate row in file"


def test_a_long_row_is_truncated_in_the_error_report():
    raw = "name,email\n" + "x" * 400 + ",not-an-email\n"
    _, errors = parse_student_csv(raw)
    assert len(errors[0]["value"]) == 120


def test_reported_line_numbers_count_rows_rather_than_file_lines():
    """A blank line shifts every line number after it by one.

    Blank rows are filtered out before numbering, so the report can be off by the
    number of blank lines above the bad row. Pinned rather than fixed: the numbers
    are a navigation aid for the admin, and renumbering would mean carrying the
    original index through the filter for no real gain.
    """
    valid, errors = parse_student_csv("name,email\nAnn,ann@x.edu\n\nJust A Name\n")
    assert len(valid) == 1
    # "Just A Name" is on file line 4; it is reported as 3.
    assert errors[0]["line"] == 3


def test_a_headerless_file_numbers_from_line_one():
    _, errors = parse_student_csv("Ann Lee,ann@x.edu\nBen,not-an-email\n")
    assert errors[0]["line"] == 2

