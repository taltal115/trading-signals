"""Cohort-track live BUY signals (Firestore) against realized prices.

Read-only research tool (no trading, no writes to the app's Firestore data). For a given
window of ``asof_date`` values, this:

  1. Pulls stored BUY signals from the Firestore ``signals`` collection (as written by
     ``main.py`` / ``write_buy_signals`` — the same rows a user sees on the dashboard/Slack).
  2. Dedupes by (asof_date, ticker), keeping the earliest run of the day (the price a user
     would actually have seen first).
  3. Re-fetches daily OHLC and reports two performance views per ticker:
       - "raw": close-to-close return at N sessions forward (N from --sessions), ignoring
         stop/target — i.e. "what if I just held it".
       - "managed": simulated trade using the signal's own stop/target/hold_days (stop checked
         before target if both trade within the same session).
  4. Prints a win-rate/return summary and (optionally) appends one row per run to a CSV so
     cohort quality can be tracked over time (see --append-csv).

Usage:
    python scripts/backtest_recent_signals.py --since 2026-06-28
    python scripts/backtest_recent_signals.py --asof 2026-06-28 --sessions 3,5 \
        --append-csv docs/research/cohort_tracking.csv
"""

from __future__ import annotations

import argparse
import statistics
import sys
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from signals_bot.config import load_config
from signals_bot.providers.stooq import StooqProvider
from signals_bot.providers.yahoo import YahooProvider
from signals_bot.storage.firestore import SIGNALS_COLLECTION, get_firestore_client

DEFAULT_CSV = ROOT_DIR / "docs" / "research" / "cohort_tracking.csv"


@dataclass
class CohortRow:
    asof_date: str
    ticker: str
    confidence: int
    entry: float
    stop: float | None
    target: float | None
    hold_days: int
    n_sessions_available: int
    raw_ret_pct: dict[int, float | None]
    managed_outcome: str | None
    managed_ret_pct: float | None
    managed_hold_sessions: int | None


def _fetch_recent_buy_rows(
    *, since: date | None, asof: date | None, limit_runs: int
) -> list[dict[str, Any]]:
    """Flatten Firestore ``signals`` run docs into per-ticker BUY rows, deduped per day."""
    db = get_firestore_client()
    query = db.collection(SIGNALS_COLLECTION).order_by(
        "ts_utc", direction="DESCENDING"
    ).limit(limit_runs)

    seen: dict[tuple[str, str], dict[str, Any]] = {}
    run_ts_by_key: dict[tuple[str, str], str] = {}
    for doc in query.stream():
        data = doc.to_dict() or {}
        run_asof = str(data.get("asof_date", "")).strip()
        if not run_asof:
            continue
        try:
            run_asof_d = date.fromisoformat(run_asof)
        except ValueError:
            continue
        if asof is not None and run_asof_d != asof:
            continue
        if asof is None and since is not None and run_asof_d < since:
            continue

        ts_utc = str(data.get("ts_utc", ""))
        for sig in data.get("signals") or []:
            ticker = str(sig.get("ticker", "")).strip().upper()
            if not ticker:
                continue
            key = (run_asof, ticker)
            # Keep the earliest run of the day (first time the bot actually offered it).
            if key in seen and run_ts_by_key.get(key, "") <= ts_utc:
                continue
            row = dict(sig)
            row["asof_date"] = run_asof
            row["ts_utc"] = ts_utc
            seen[key] = row
            run_ts_by_key[key] = ts_utc

    return sorted(seen.values(), key=lambda r: (r["asof_date"], r["ticker"]))


def _simulate_managed(
    row: dict[str, Any], hist: pd.DataFrame, asof: date
) -> tuple[str | None, float | None, int | None]:
    entry = float(row.get("close") or 0.0)
    stop = row.get("stop")
    target = row.get("target")
    stop = float(stop) if stop is not None else None
    target = float(target) if target is not None else None
    hold_days = int(row.get("hold_days") or 5)

    fwd = hist[hist.index.date > asof].head(hold_days)
    if fwd.empty or entry <= 0:
        return None, None, None

    for i, (_, bar) in enumerate(fwd.iterrows(), start=1):
        low = float(bar["low"])
        high = float(bar["high"])
        if stop is not None and low <= stop:
            return "stop", (stop - entry) / entry * 100.0, i
        if target is not None and high >= target:
            return "target", (target - entry) / entry * 100.0, i

    last_close = float(fwd.iloc[-1]["close"])
    return "time", (last_close - entry) / entry * 100.0, len(fwd)


def _raw_return_at_n(hist: pd.DataFrame, asof: date, entry: float, n: int) -> float | None:
    fwd = hist[hist.index.date > asof]
    if len(fwd) < n or entry <= 0:
        return None
    close_n = float(fwd.iloc[n - 1]["close"])
    return (close_n - entry) / entry * 100.0


def _summary(label: str, rets: list[float]) -> str:
    if not rets:
        return f"{label:<20} n=0"
    wins = [r for r in rets if r > 0]
    win_rate = len(wins) / len(rets) * 100.0
    avg = statistics.mean(rets)
    med = statistics.median(rets)
    gross_win = sum(r for r in rets if r > 0)
    gross_loss = -sum(r for r in rets if r < 0)
    pf = (gross_win / gross_loss) if gross_loss > 0 else float("inf")
    return (
        f"{label:<20} n={len(rets):<4} win%={win_rate:5.1f}  "
        f"avg={avg:+6.2f}%  median={med:+6.2f}%  profit_factor={pf:4.2f}"
    )


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Cohort-track Firestore BUY signals vs realized prices.")
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--since", default=None, help="Include runs with asof_date >= this (YYYY-MM-DD).")
    p.add_argument("--asof", default=None, help="Include only this asof_date (YYYY-MM-DD).")
    p.add_argument("--sessions", default="3,5", help="Comma-separated session counts for raw returns.")
    p.add_argument("--limit-runs", type=int, default=60, help="Max Firestore run docs to scan.")
    p.add_argument(
        "--append-csv",
        default=None,
        help=f"Append a summary row to this CSV (default when flag has no value: {DEFAULT_CSV}).",
        nargs="?",
        const=str(DEFAULT_CSV),
    )
    p.add_argument("--csv", default=None, help="Optional path to dump per-ticker detail rows.")
    return p


def main() -> int:
    args = _build_arg_parser().parse_args()
    since = date.fromisoformat(args.since) if args.since else None
    asof_only = date.fromisoformat(args.asof) if args.asof else None
    session_counts = sorted({int(x) for x in args.sessions.split(",") if x.strip()})

    cfg = load_config(Path(args.config).expanduser().resolve())
    providers = [
        YahooProvider(timeout_sec=cfg.data.request_timeout_sec, ssl_verify=cfg.data.ssl_verify,
                      ca_bundle_path=None),
        StooqProvider(timeout_sec=cfg.data.request_timeout_sec, ssl_verify=cfg.data.ssl_verify,
                      ca_bundle_path=None, api_key=cfg.data.stooq_api_key),
    ]

    rows = _fetch_recent_buy_rows(since=since, asof=asof_only, limit_runs=args.limit_runs)
    print(f"Loaded {len(rows)} unique (asof_date, ticker) BUY rows from Firestore")
    if not rows:
        print("Nothing to evaluate — check --since/--asof and that runs have been written.")
        return 0

    today = date.today()
    max_session = max(session_counts) if session_counts else 5
    results: list[CohortRow] = []
    for n, row in enumerate(rows, start=1):
        asof = date.fromisoformat(row["asof_date"])
        hold_days = int(row.get("hold_days") or cfg.strategy.max_hold_days)
        needed_sessions = max(max_session, hold_days)
        # Skip cohorts too recent to have completed the requested session window.
        if (today - asof).days < needed_sessions + 1:
            continue

        ticker = row["ticker"]
        hist = None
        for prov in providers:
            try:
                h = prov.get_history(ticker, lookback_days=400)
                if h is not None and not h.empty:
                    hist = h
                    break
            except Exception:
                continue

        entry = float(row.get("close") or 0.0)
        raw_rets: dict[int, float | None] = {sc: None for sc in session_counts}
        managed_outcome, managed_ret, managed_hold = None, None, None
        n_sessions_available = 0
        if hist is not None:
            hist = hist.copy()
            hist.index = pd.to_datetime(hist.index)
            fwd = hist[hist.index.date > asof]
            n_sessions_available = len(fwd)
            for sc in session_counts:
                raw_rets[sc] = _raw_return_at_n(hist, asof, entry, sc)
            managed_outcome, managed_ret, managed_hold = _simulate_managed(row, hist, asof)

        results.append(
            CohortRow(
                asof_date=row["asof_date"],
                ticker=ticker,
                confidence=int(row.get("confidence") or 0),
                entry=entry,
                stop=row.get("stop"),
                target=row.get("target"),
                hold_days=hold_days,
                n_sessions_available=n_sessions_available,
                raw_ret_pct=raw_rets,
                managed_outcome=managed_outcome,
                managed_ret_pct=managed_ret,
                managed_hold_sessions=managed_hold,
            )
        )
        if n % 20 == 0:
            print(f"  ...processed {n}/{len(rows)}")

    if not results:
        print("No cohorts old enough to have completed their session window yet.")
        return 0

    print("\n" + "=" * 78)
    print(f"COHORT REPORT — {len(results)} tickers (window: "
          f"{results[0].asof_date} .. {results[-1].asof_date})")
    print("=" * 78)
    print(f"{'ASOF':<11}{'TICKER':<8}{'CONF':<6}"
          + "".join(f"RET_{sc}D".ljust(10) for sc in session_counts)
          + f"{'MANAGED':<10}{'MNG_RET':<10}")
    for r in results:
        raw_str = "".join(
            (f"{r.raw_ret_pct[sc]:+.1f}%".ljust(10) if r.raw_ret_pct[sc] is not None else "-".ljust(10))
            for sc in session_counts
        )
        mng_ret_s = f"{r.managed_ret_pct:+.1f}%" if r.managed_ret_pct is not None else "-"
        print(f"{r.asof_date:<11}{r.ticker:<8}{r.confidence:<6}{raw_str}"
              f"{(r.managed_outcome or '-'):<10}{mng_ret_s:<10}")

    print("\n--- Raw hold (close-to-close, ignores stop/target) ---")
    for sc in session_counts:
        rets = [r.raw_ret_pct[sc] for r in results if r.raw_ret_pct[sc] is not None]
        print("  " + _summary(f"+{sc} sessions", rets))

    print("\n--- Managed (stop/target/hold_days as offered) ---")
    managed_rets = [r.managed_ret_pct for r in results if r.managed_ret_pct is not None]
    print("  " + _summary("managed", managed_rets))
    oc: dict[str, int] = {}
    for r in results:
        if r.managed_outcome:
            oc[r.managed_outcome] = oc.get(r.managed_outcome, 0) + 1
    print(f"  outcomes: {oc}")

    if args.csv:
        out = Path(args.csv).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        flat = []
        for r in results:
            d = {
                "asof_date": r.asof_date, "ticker": r.ticker, "confidence": r.confidence,
                "entry": r.entry, "stop": r.stop, "target": r.target, "hold_days": r.hold_days,
                "managed_outcome": r.managed_outcome, "managed_ret_pct": r.managed_ret_pct,
                "managed_hold_sessions": r.managed_hold_sessions,
            }
            for sc in session_counts:
                d[f"raw_ret_{sc}d_pct"] = r.raw_ret_pct[sc]
            flat.append(d)
        pd.DataFrame(flat).to_csv(out, index=False)
        print(f"\nPer-ticker detail -> {out}")

    if args.append_csv:
        csv_path = Path(args.append_csv).expanduser()
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        summary: dict[str, Any] = {
            "run_ts_utc": datetime.now(timezone.utc).isoformat(),
            "cohort_from": results[0].asof_date,
            "cohort_to": results[-1].asof_date,
            "n_tickers": len(results),
        }
        for sc in session_counts:
            rets = [r.raw_ret_pct[sc] for r in results if r.raw_ret_pct[sc] is not None]
            win_rate = (sum(1 for x in rets if x > 0) / len(rets) * 100.0) if rets else None
            summary[f"win_rate_{sc}d_pct"] = round(win_rate, 1) if win_rate is not None else None
            summary[f"avg_ret_{sc}d_pct"] = round(statistics.mean(rets), 2) if rets else None
        win_rate_m = (
            sum(1 for x in managed_rets if x > 0) / len(managed_rets) * 100.0
            if managed_rets else None
        )
        gross_win = sum(r for r in managed_rets if r > 0)
        gross_loss = -sum(r for r in managed_rets if r < 0)
        pf = (gross_win / gross_loss) if gross_loss > 0 else None
        summary["win_rate_managed_pct"] = round(win_rate_m, 1) if win_rate_m is not None else None
        summary["avg_ret_managed_pct"] = round(statistics.mean(managed_rets), 2) if managed_rets else None
        summary["profit_factor_managed"] = round(pf, 2) if pf is not None else None

        header_needed = not csv_path.exists()
        df_row = pd.DataFrame([summary])
        df_row.to_csv(csv_path, mode="a", header=header_needed, index=False)
        print(f"\nCohort summary appended -> {csv_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
