"""Tests for XNYS helpers (exchange_calendars)."""

from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from signals_bot.trading_calendar.nys import (
    add_ny_sessions,
    nyse_session_dates_between_exclusive_start,
    xnys_is_session_on,
    xnys_sessions_between,
)

NY = ZoneInfo("America/New_York")


def test_good_friday_closed_2025() -> None:
    assert xnys_is_session_on(date(2025, 4, 16)) is True
    assert xnys_is_session_on(date(2025, 4, 18)) is False  # Good Friday


def test_mlk_closed_2025() -> None:
    assert xnys_is_session_on(date(2025, 1, 17)) is True  # Fri before MLK Monday
    assert xnys_is_session_on(date(2025, 1, 20)) is False  # MLK


def test_early_close_still_counts_as_session_nov28_2025() -> None:
    assert xnys_is_session_on(date(2025, 11, 28)) is True


@pytest.mark.parametrize(
    ("buy", "asof", "expected_min"),
    [
        # Mon–Wed same week: one session day after Monday through Wednesday
        (date(2025, 11, 3), date(2025, 11, 5), 2),
        (date(2025, 11, 3), date(2025, 11, 3), 0),
    ],
)
def test_session_span_exclusive_start(buy: date, asof: date, expected_min: int) -> None:
    n = nyse_session_dates_between_exclusive_start(buy, asof)
    assert n >= expected_min


def test_sessions_between_datetimes_known_week() -> None:
    """Wed anchor (Apr 22 2026) -> Fri / Mon monitors."""
    created = datetime(2026, 4, 22, 20, 0, 0, tzinfo=timezone.utc)
    fri = datetime(2026, 4, 24, 21, 0, 0, tzinfo=timezone.utc)
    mon = datetime(2026, 4, 27, 21, 0, 0, tzinfo=timezone.utc)
    assert xnys_sessions_between(created, fri, NY) == 2
    assert xnys_sessions_between(created, mon, NY) == 4


def test_add_four_sessions_anchor() -> None:
    created = datetime(2026, 4, 22, 20, 0, 0, tzinfo=timezone.utc)
    due = add_ny_sessions(created, 4, NY)
    assert due == date(2026, 4, 28)
