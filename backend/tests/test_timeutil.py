"""UTC helpers.

The whole product compares times, and a naive datetime mixed with an aware one
raises ``TypeError`` at the moment a teacher presses "end session". These tests
exist to keep that from ever being reachable.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.utils.timeutil import ensure_aware, in_hours, in_seconds, iso, parse_iso, utcnow

IST = timezone(timedelta(hours=5, minutes=30))


def test_utcnow_is_always_aware_and_utc():
    now = utcnow()
    assert now.tzinfo is not None
    assert now.utcoffset() == timedelta(0)


def test_offsets_are_relative_to_now():
    before = utcnow()
    assert timedelta(seconds=29) < in_seconds(30) - before < timedelta(seconds=31)
    assert timedelta(minutes=59) < in_hours(1) - before < timedelta(minutes=61)


def test_ensure_aware_passes_none_through():
    assert ensure_aware(None) is None


def test_ensure_aware_reads_a_naive_value_as_utc():
    # Documents written by hand, or imported, can be naive. Treating them as UTC
    # is the only interpretation consistent with everything the app writes.
    assert ensure_aware(datetime(2026, 3, 1, 9, 0)) == datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc)


def test_ensure_aware_converts_another_zone_without_moving_the_instant():
    local = datetime(2026, 3, 1, 14, 30, tzinfo=IST)
    converted = ensure_aware(local)
    assert converted.utcoffset() == timedelta(0)
    assert converted == local
    assert converted.hour == 9


def test_parse_iso_accepts_the_z_suffix_javascript_produces():
    # `Date.toISOString()` is what every datetime-local field in the frontend
    # sends, via `fromLocalInputValue`.
    assert parse_iso("2026-03-01T09:00:00.000Z") == datetime(
        2026, 3, 1, 9, 0, tzinfo=timezone.utc
    )


def test_parse_iso_accepts_an_explicit_offset():
    assert parse_iso("2026-03-01T14:30:00+05:30").hour == 9


def test_parse_iso_treats_an_offsetless_string_as_utc():
    assert parse_iso("2026-03-01T09:00:00") == datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize("value", [None, "", "   ", "not a date", "2026-13-45", "Z"])
def test_parse_iso_returns_none_rather_than_raising(value):
    # Query strings are user input; a bad `?from=` must not 500 a report.
    assert parse_iso(value) is None


def test_iso_of_none_is_none():
    assert iso(None) is None


def test_iso_round_trips_through_parse_iso():
    start = utcnow().replace(microsecond=0)
    assert parse_iso(iso(start)) == start


def test_iso_normalises_a_naive_value_before_formatting():
    assert iso(datetime(2026, 3, 1, 9, 0)) == "2026-03-01T09:00:00+00:00"
