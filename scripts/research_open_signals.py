"""Daily research pass over live BUY signals (Firestore) — tags each signal with its P&L status.

Meant to run every weekday morning **before market open** (see
``.github/workflows/signal-research-daily.yml``). For every ticker still inside its planned
hold window (a "close signal": ``asof_date + hold_days`` sessions is **on or after today** — it
hasn't fully played out yet), this:

  1. Fetches the current price (last daily close from Yahoo/Stooq — same providers used
     everywhere else in this signal-only repo; no broker/intraday data).
  2. Computes P&L vs the signal's entry (``close``) and a short, human-readable reason.
  3. Writes ``isProfitable`` / ``pnlValue`` / ``pnlPct`` / ``livePrice`` / ``reason`` directly
     onto each signal entry (sibling of ``ticker``/``confidence``/``stop``/``target`` — a new
     "parent" property, not nested under ``metrics``), then patches the run doc in Firestore.

Read-only for trading purposes — this only annotates existing signal rows; it never places or
suggests placing an order. See ``docs/research/signal-strategy-research-2026-07.md`` for the
research this formalizes (per-signal running P&L instead of only backtesting mature cohorts).

Usage:
    PYTHONPATH=./src python scripts/research_open_signals.py --config config.yaml
    PYTHONPATH=./src python scripts/research_open_signals.py --dry-run -v
"""

from __future__ import annotations

import argparse
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from google.cloud.firestore_v1.base_query import FieldFilter

from signals_bot.config import AppConfig, load_config
from signals_bot.providers.stooq import StooqProvider
from signals_bot.providers.yahoo import YahooProvider
from signals_bot.storage.firestore import SIGNALS_COLLECTION, get_firestore_client
from signals_bot.trading_calendar import add_ny_sessions


def _close_deadline(asof_date: date, hold_days: int, market_tz) -> date:
    """Last session the signal is still "current" for (asof_date + hold_days sessions)."""
    anchor = datetime.combine(asof_date, time(9, 30), tzinfo=market_tz)
    return add_ny_sessions(anchor, max(hold_days, 0), market_tz)


def _fetch_live_price(
    ticker: str, providers: list[Any], cache: dict[str, float | None]
) -> float | None:
    if ticker in cache:
        return cache[ticker]
    price: float | None = None
    for prov in providers:
        try:
            hist = prov.get_history(ticker, lookback_days=15)
            if hist is not None and not hist.empty and "close" in hist.columns:
                val = hist["close"].iloc[-1]
                if val == val:  # not NaN
                    price = float(val)
                    break
        except Exception:
            continue
    cache[ticker] = price
    return price


def _build_reason(
    *,
    entry: float,
    live_price: float | None,
    stop: float | None,
    target: float | None,
    pnl_pct: float | None,
    hold_days: int,
    age_sessions: int | None,
) -> str:
    if live_price is None:
        return "Live price unavailable (data provider error)."
    if target is not None and live_price >= target:
        return f"At/above target (${target:.2f}); up {pnl_pct:+.1f}% from entry ${entry:.2f}."
    if stop is not None and live_price <= stop:
        return f"At/below stop (${stop:.2f}); down {pnl_pct:+.1f}% from entry ${entry:.2f}."
    direction = "up" if (pnl_pct or 0) >= 0 else "down"
    base = (
        f"Trading {direction} {abs(pnl_pct):.1f}% from entry "
        f"(${entry:.2f} -> ${live_price:.2f})"
    )
    if age_sessions is not None:
        base += f", day {age_sessions}/{hold_days}"
    return base + "."


def _research_entry(
    entry: dict[str, Any],
    *,
    asof: date,
    today: date,
    providers: list[Any],
    price_cache: dict[str, float | None],
    default_hold_days: int,
) -> dict[str, Any]:
    ticker = str(entry.get("ticker", "")).strip().upper()
    entry_price = entry.get("close")
    entry_f = float(entry_price) if isinstance(entry_price, (int, float)) else None
    stop = entry.get("stop")
    target = entry.get("target")
    stop_f = float(stop) if isinstance(stop, (int, float)) else None
    target_f = float(target) if isinstance(target, (int, float)) else None
    hold_days = int(entry.get("hold_days") or default_hold_days)

    live_price = _fetch_live_price(ticker, providers, price_cache) if ticker else None
    age_sessions = None
    try:
        age_sessions = (today - asof).days  # calendar approximation for display only
    except Exception:
        pass

    pnl_value: float | None = None
    pnl_pct: float | None = None
    is_profitable: bool | None = None
    if live_price is not None and entry_f is not None and entry_f > 0:
        pnl_value = live_price - entry_f
        pnl_pct = (pnl_value / entry_f) * 100.0
        is_profitable = pnl_value > 0

    reason = _build_reason(
        entry=entry_f or 0.0,
        live_price=live_price,
        stop=stop_f,
        target=target_f,
        pnl_pct=pnl_pct,
        hold_days=hold_days,
        age_sessions=age_sessions,
    )

    patched = dict(entry)
    patched["livePrice"] = live_price
    patched["isProfitable"] = is_profitable
    patched["pnlValue"] = round(pnl_value, 4) if pnl_value is not None else None
    patched["pnlPct"] = round(pnl_pct, 2) if pnl_pct is not None else None
    patched["reason"] = reason
    patched["researchUpdatedAtUtc"] = datetime.now(timezone.utc).isoformat()
    return patched


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Tag live Firestore BUY signals with running P&L / profitability."
    )
    p.add_argument("--config", default="config.yaml")
    p.add_argument(
        "--lookback-days",
        type=int,
        default=21,
        help="Only scan run docs with asof_date >= today - N calendar days.",
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

    price_cache: dict[str, float | None] = {}
    docs_updated = 0
    signals_researched = 0
    signals_skipped_closed = 0

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
            hold_days = int(entry.get("hold_days") or cfg.strategy.max_hold_days)
            deadline = _close_deadline(asof, hold_days, market_tz)
            # "Close signal": still current — its planned exit date hasn't passed yet.
            if deadline < today:
                signals_skipped_closed += 1
                new_arr.append(entry)
                continue

            patched = _research_entry(
                entry,
                asof=asof,
                today=today,
                providers=providers,
                price_cache=price_cache,
                default_hold_days=cfg.strategy.max_hold_days,
            )
            new_arr.append(patched)
            doc_touched = True
            signals_researched += 1
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
                    f"live={patched['livePrice']} pnl%={patched['pnlPct']} :: {patched['reason']}"
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
        f"research_open_signals: docs_updated={docs_updated} signals_researched={signals_researched} "
        f"signals_already_closed={signals_skipped_closed} dry_run={args.dry_run}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
