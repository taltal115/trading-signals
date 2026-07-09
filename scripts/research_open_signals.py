"""Finalize BUY signal outcomes (Firestore) once each signal's hold window has ended.

Meant to run every weekday morning **before market open** (see
``.github/workflows/signal-research-daily.yml``). For every signal whose planned exit date
(``asof_date`` + ``hold_days`` NYSE sessions) is **on or before today** — i.e. it has fully
played out — and that hasn't already been finalized, this:

  1. Re-fetches daily OHLC history for the ticker (Yahoo/Stooq — same providers used
     everywhere else in this signal-only repo; no broker/intraday data).
  2. Walks forward from the signal date to the deadline, checking each session for a stop
     touch (low <= stop) or target touch (high >= target); if neither triggers, the outcome
     is the close on the deadline session (time exit). This is the same "managed trade"
     methodology as ``scripts/backtest_recent_signals.py`` / ``backtest_buy_signals.py``.
  3. Writes the **final, permanent** result directly onto the signal entry (sibling of
     ``ticker``/``confidence``/``stop``/``target`` — a new "parent" property, not nested under
     ``metrics``): ``isProfitable``, ``pnlValue``, ``pnlPct``, ``livePrice`` (the realized exit
     price), ``outcome`` (``target``/``stop``/``time``/``no_data``), ``exitDate``, ``reason``,
     and ``researchStatus`` (``"finalized"`` once written — used to skip it on future runs).

Idempotent / incremental by design: signals with ``researchStatus == "finalized"`` are always
skipped, and signals whose deadline hasn't arrived yet are left untouched (re-checked on a
later run once matured). Safe to run repeatedly, including as a one-off historical backfill
over old runs (raise ``--lookback-days`` to cover more history).

Read-only for trading purposes — this only annotates existing signal rows after the fact; it
never places or suggests placing an order. See
``docs/research/signal-strategy-research-2026-07.md`` for the research this formalizes.

Usage:
    PYTHONPATH=./src python scripts/research_open_signals.py --config config.yaml
    PYTHONPATH=./src python scripts/research_open_signals.py --dry-run -v
    # One-off backfill covering ~5 years of history:
    PYTHONPATH=./src python scripts/research_open_signals.py --lookback-days 1825
"""

from __future__ import annotations

import argparse
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from google.cloud.firestore_v1.base_query import FieldFilter

from signals_bot.config import AppConfig, load_config
from signals_bot.providers.stooq import StooqProvider
from signals_bot.providers.yahoo import YahooProvider
from signals_bot.storage.firestore import SIGNALS_COLLECTION, get_firestore_client
from signals_bot.trading_calendar import add_ny_sessions

FINALIZED = "finalized"
NO_DATA = "no_data"


def _close_deadline(asof_date: date, hold_days: int, market_tz) -> date:
    """Last session the signal's hold window covers (asof_date + hold_days sessions)."""
    anchor = datetime.combine(asof_date, time(9, 30), tzinfo=market_tz)
    return add_ny_sessions(anchor, max(hold_days, 0), market_tz)


def _get_history(
    ticker: str,
    *,
    min_days_needed: int,
    providers: list[Any],
    cache: dict[str, pd.DataFrame | None],
    today: date,
) -> pd.DataFrame | None:
    """Fetch (and cache) daily OHLC covering at least ``min_days_needed`` calendar days back."""
    cached = cache.get(ticker)
    if cached is not None and not cached.empty:
        earliest_covered = (today - cached.index.min().date()).days
        if earliest_covered >= min_days_needed:
            return cached

    lookback = max(min_days_needed + 30, 60)
    hist: pd.DataFrame | None = None
    for prov in providers:
        try:
            h = prov.get_history(ticker, lookback_days=lookback)
            if h is not None and not h.empty:
                h = h.copy()
                h.index = pd.to_datetime(h.index)
                hist = h
                break
        except Exception:
            continue
    cache[ticker] = hist
    return hist


def _simulate_outcome(
    *, entry_price: float, stop: float | None, target: float | None,
    hist: pd.DataFrame, asof: date, deadline: date,
) -> dict[str, Any] | None:
    """Managed trade walk from asof (exclusive) through deadline (inclusive). None if no bars yet."""
    fwd = hist[(hist.index.date > asof) & (hist.index.date <= deadline)]
    if fwd.empty:
        return None

    for ts, bar in fwd.iterrows():
        low = float(bar["low"])
        high = float(bar["high"])
        if stop is not None and low <= stop:
            return {"outcome": "stop", "exit_price": stop, "exit_date": ts.date()}
        if target is not None and high >= target:
            return {"outcome": "target", "exit_price": target, "exit_date": ts.date()}

    last_ts = fwd.index[-1]
    last_close = float(fwd.iloc[-1]["close"])
    return {"outcome": "time", "exit_price": last_close, "exit_date": last_ts.date()}


def _build_reason(
    *, outcome: str | None, entry: float, exit_price: float | None, exit_date: date | None,
    stop: float | None, target: float | None, pnl_pct: float | None,
) -> str:
    if outcome is None or exit_price is None:
        return "No price data available through the hold deadline yet; will retry."
    exit_s = exit_date.isoformat() if exit_date else "?"
    if outcome == "target":
        return f"Target hit (${target:.2f}) on {exit_s}; {pnl_pct:+.1f}% from entry ${entry:.2f}."
    if outcome == "stop":
        return f"Stopped out (${stop:.2f}) on {exit_s}; {pnl_pct:+.1f}% from entry ${entry:.2f}."
    return (
        f"Hold period ended {exit_s} at ${exit_price:.2f}; "
        f"{pnl_pct:+.1f}% from entry ${entry:.2f}."
    )


def _finalize_entry(
    entry: dict[str, Any],
    *,
    asof: date,
    deadline: date,
    providers: list[Any],
    history_cache: dict[str, pd.DataFrame | None],
    today: date,
) -> dict[str, Any]:
    ticker = str(entry.get("ticker", "")).strip().upper()
    entry_price = entry.get("close")
    entry_f = float(entry_price) if isinstance(entry_price, (int, float)) else None
    stop = entry.get("stop")
    target = entry.get("target")
    stop_f = float(stop) if isinstance(stop, (int, float)) else None
    target_f = float(target) if isinstance(target, (int, float)) else None

    min_days_needed = max((today - asof).days, 1)
    hist = (
        _get_history(ticker, min_days_needed=min_days_needed, providers=providers, cache=history_cache, today=today)
        if ticker
        else None
    )

    sim: dict[str, Any] | None = None
    if hist is not None and entry_f is not None:
        sim = _simulate_outcome(entry_price=entry_f, stop=stop_f, target=target_f, hist=hist, asof=asof, deadline=deadline)

    outcome = sim["outcome"] if sim else None
    exit_price = sim["exit_price"] if sim else None
    exit_date = sim["exit_date"] if sim else None

    pnl_value: float | None = None
    pnl_pct: float | None = None
    is_profitable: bool | None = None
    if exit_price is not None and entry_f is not None and entry_f > 0:
        pnl_value = exit_price - entry_f
        pnl_pct = (pnl_value / entry_f) * 100.0
        is_profitable = pnl_value > 0

    reason = _build_reason(
        outcome=outcome, entry=entry_f or 0.0, exit_price=exit_price, exit_date=exit_date,
        stop=stop_f, target=target_f, pnl_pct=pnl_pct,
    )

    patched = dict(entry)
    patched["livePrice"] = exit_price
    patched["isProfitable"] = is_profitable
    patched["pnlValue"] = round(pnl_value, 4) if pnl_value is not None else None
    patched["pnlPct"] = round(pnl_pct, 2) if pnl_pct is not None else None
    patched["outcome"] = outcome
    patched["exitDate"] = exit_date.isoformat() if exit_date else None
    patched["reason"] = reason
    patched["researchStatus"] = FINALIZED if outcome is not None else NO_DATA
    patched["researchUpdatedAtUtc"] = datetime.now(timezone.utc).isoformat()
    return patched


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Finalize matured Firestore BUY signals with a permanent P&L outcome."
    )
    p.add_argument("--config", default="config.yaml")
    p.add_argument(
        "--lookback-days",
        type=int,
        default=365,
        help="Only scan run docs with asof_date >= today - N calendar days (raise for a historical backfill).",
    )
    p.add_argument("--dry-run", action="store_true", help="Compute and log only; no Firestore writes.")
    p.add_argument("-v", "--verbose", action="store_true", help="Print every ticker's research result.")
    return p


def main() -> int:
    args = _build_arg_parser().parse_args()
    cfg: AppConfig = load_config(Path(args.config).expanduser().resolve())
    market_tz = cfg.tz()
    today = datetime.now(market_tz).date()

    providers: list[Any] = [
        YahooProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=cfg.resolve_path(cfg.data.ca_bundle_path).as_posix() if cfg.data.ca_bundle_path else None,
        ),
        StooqProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=cfg.resolve_path(cfg.data.ca_bundle_path).as_posix() if cfg.data.ca_bundle_path else None,
            api_key=cfg.data.stooq_api_key,
        ),
    ]

    db = get_firestore_client()
    cutoff = (today - timedelta(days=args.lookback_days)).isoformat()
    query = db.collection(SIGNALS_COLLECTION).where(filter=FieldFilter("asof_date", ">=", cutoff))

    docs = list(query.stream())
    print(f"research_open_signals: scanning {len(docs)} run doc(s) with asof_date >= {cutoff}")

    history_cache: dict[str, pd.DataFrame | None] = {}
    docs_updated = 0
    signals_finalized = 0
    signals_not_matured = 0
    signals_already_finalized = 0
    signals_no_data = 0

    for snap in docs:
        data = snap.to_dict() or {}
        raw_asof = str(data.get("asof_date", "")).strip()
        try:
            asof = date.fromisoformat(raw_asof)
        except ValueError:
            continue
        arr = data.get("signals")
        if not isinstance(arr, list) or not arr:
            continue

        new_arr: list[dict[str, Any]] = []
        doc_touched = False
        for entry in arr:
            if not isinstance(entry, dict):
                new_arr.append(entry)
                continue

            if entry.get("researchStatus") == FINALIZED:
                signals_already_finalized += 1
                new_arr.append(entry)
                continue

            hold_days = int(entry.get("hold_days") or cfg.strategy.max_hold_days)
            deadline = _close_deadline(asof, hold_days, market_tz)
            if deadline > today:
                # Hold window hasn't ended yet — re-check once it matures.
                signals_not_matured += 1
                new_arr.append(entry)
                continue

            patched = _finalize_entry(
                entry, asof=asof, deadline=deadline, providers=providers,
                history_cache=history_cache, today=today,
            )
            new_arr.append(patched)
            doc_touched = True
            if patched["researchStatus"] == FINALIZED:
                signals_finalized += 1
            else:
                signals_no_data += 1
            if args.verbose:
                if patched["isProfitable"] is None:
                    tag = "N/A"
                elif patched["isProfitable"]:
                    tag = "PROFIT"
                elif patched["pnlPct"] == 0:
                    tag = "FLAT"
                else:
                    tag = "LOSS"
                print(
                    f"  [{tag}] {raw_asof} {patched.get('ticker')} entry={entry.get('close')} "
                    f"exit={patched['livePrice']} outcome={patched['outcome']} pnl%={patched['pnlPct']} "
                    f":: {patched['reason']}"
                )

        if doc_touched:
            docs_updated += 1
            if not args.dry_run:
                db.collection(SIGNALS_COLLECTION).document(snap.id).set(
                    {
                        "signals": new_arr,
                        "research_updated_at_utc": datetime.now(timezone.utc).isoformat(),
                    },
                    merge=True,
                )

    print(
        f"research_open_signals: docs_updated={docs_updated} signals_finalized={signals_finalized} "
        f"signals_no_data={signals_no_data} signals_not_matured={signals_not_matured} "
        f"signals_already_finalized={signals_already_finalized} dry_run={args.dry_run}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
