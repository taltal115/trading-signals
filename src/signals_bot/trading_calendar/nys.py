"""XNYS calendar: exchange_calendars-backed session checks and counters."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

import exchange_calendars as xcals  # type: ignore[import-untyped]
import pandas as pd


@dataclass(frozen=True)
class CalendarSpec:
    """XNYS identifiers (exchange_calendars naming)."""

    name: str = "XNYS"

    def calendar(self):  # type: ignore[no-untyped-def]
        return xcals.get_calendar(self.name)


@lru_cache(maxsize=1)
def default_calendar_spec() -> CalendarSpec:
    return CalendarSpec()


def xnys_is_session_on(d: date, *, spec: CalendarSpec | None = None) -> bool:
    """True if NYSE has a regular session on this **calendar** date (early close still True)."""
    sp = spec or default_calendar_spec()
    cal = sp.calendar()
    ts = pd.Timestamp(d)
    return bool(cal.is_session(ts))


def xnys_sessions_between(
    start: datetime,
    end: datetime,
    market_tz: ZoneInfo,
    *,
    spec: CalendarSpec | None = None,
) -> int:
    """Match JS `countTradingDaysBetween`: step one day at a time in `market_tz`, count XNYS sessions.

    Only dates where the stepped instant falls on an XNYS session day are counted.
    """
    if end <= start:
        return 0
    cur = start.astimezone(market_tz)
    end_loc = end.astimezone(market_tz)
    sp = spec or default_calendar_spec()
    count = 0
    while cur < end_loc:
        cur = cur + timedelta(days=1)
        if xnys_is_session_on(cur.date(), spec=sp):
            count += 1
    return count


def add_ny_sessions(
    start: datetime,
    trading_days: int,
    market_tz: ZoneInfo,
    *,
    spec: CalendarSpec | None = None,
) -> date:
    """Match JS `addTradingDays`: advance calendar days in `market_tz`; count only XNYS sessions."""
    if trading_days <= 0:
        return start.astimezone(market_tz).date()
    cur = start.astimezone(market_tz)
    sp = spec or default_calendar_spec()
    added = 0
    while added < trading_days:
        cur = cur + timedelta(days=1)
        if xnys_is_session_on(cur.date(), spec=sp):
            added += 1
    return cur.date()


def nyse_session_dates_between_exclusive_start(
    buy_asof: date,
    asof: date,
    *,
    spec: CalendarSpec | None = None,
) -> int:
    """Sessions with buy_asof < session_date <= asof (both **NYSE bar dates**).

    Replaces raw ``(asof - buy).days`` for SQLite open-buy time exit: counts **trading**
    sessions after the buy bar through the asof bar (inclusive of asof when it is a session).
    """
    if asof <= buy_asof:
        return 0
    sp = spec or default_calendar_spec()
    n = 0
    d = buy_asof + timedelta(days=1)
    while d <= asof:
        if xnys_is_session_on(d, spec=sp):
            n += 1
        d = d + timedelta(days=1)
    return n
