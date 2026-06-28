"""Backtest historical BUY signals stored in SQLite against realized prices.

For every BUY row in ``data/signals.db`` this:
  1. Re-fetches daily OHLC from the entry date forward (max_hold_days + buffer).
  2. Simulates the managed trade: each session check stop (low<=stop) then target
     (high>=target); if neither triggers by max_hold_days, exit at that day's close.
     When both stop and target fall inside the same session we assume the stop
     filled first (conservative).
  3. Records realized return %, outcome, and the entry metrics.

It then aggregates win-rate / average-return overall and bucketed by the
strategy's tunable inputs (confidence, ret_5d, ret_10d, vol_ratio, atr_pct) so we
can see which thresholds actually separate winners from losers.

Outputs are logs only (no DB writes, no trading). Read-only research tool.
"""

from __future__ import annotations

import argparse
import sqlite3
import statistics
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pandas as pd

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from signals_bot.config import load_config
from signals_bot.providers.stooq import StooqProvider
from signals_bot.providers.yahoo import YahooProvider


@dataclass
class TradeResult:
    ticker: str
    asof_date: str
    confidence: int
    entry: float
    stop: float | None
    target: float | None
    max_hold_days: int
    outcome: str  # target | stop | time | no_data
    exit_price: float | None
    ret_pct: float | None
    hold_sessions: int | None
    ret_5d_pct: float | None
    ret_10d_pct: float | None
    vol_ratio: float | None
    atr_pct: float | None
    breakout_dist_pct: float | None


def _fetch_buys(db_path: Path) -> list[dict[str, Any]]:
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """
        SELECT asof_date, ticker, confidence, score, close, suggested_entry,
               suggested_stop, suggested_target, max_hold_days,
               ret_5d_pct, ret_10d_pct, vol_ratio, atr_pct, breakout_dist_pct
        FROM signals
        WHERE action='BUY'
        ORDER BY asof_date ASC
        """
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def _simulate(buy: dict[str, Any], hist: pd.DataFrame) -> TradeResult:
    asof = date.fromisoformat(buy["asof_date"])
    entry = float(buy["suggested_entry"] or buy["close"])
    stop = buy["suggested_stop"]
    target = buy["suggested_target"]
    stop = float(stop) if stop is not None else None
    target = float(target) if target is not None else None
    max_hold = int(buy["max_hold_days"] or 5)

    base = dict(
        ticker=buy["ticker"],
        asof_date=buy["asof_date"],
        confidence=int(buy["confidence"]),
        entry=entry,
        stop=stop,
        target=target,
        max_hold_days=max_hold,
        ret_5d_pct=buy["ret_5d_pct"],
        ret_10d_pct=buy["ret_10d_pct"],
        vol_ratio=buy["vol_ratio"],
        atr_pct=buy["atr_pct"],
        breakout_dist_pct=buy["breakout_dist_pct"],
    )

    # Sessions strictly after the signal date (entry assumed at next open ~= prior close).
    fwd = hist[hist.index.date > asof]
    if fwd.empty:
        return TradeResult(outcome="no_data", exit_price=None, ret_pct=None,
                           hold_sessions=None, **base)

    sessions = fwd.head(max_hold)
    for i, (_, bar) in enumerate(sessions.iterrows(), start=1):
        low = float(bar["low"])
        high = float(bar["high"])
        if stop is not None and low <= stop:
            ret = (stop - entry) / entry * 100.0
            return TradeResult(outcome="stop", exit_price=stop, ret_pct=ret,
                               hold_sessions=i, **base)
        if target is not None and high >= target:
            ret = (target - entry) / entry * 100.0
            return TradeResult(outcome="target", exit_price=target, ret_pct=ret,
                               hold_sessions=i, **base)

    last_close = float(sessions.iloc[-1]["close"])
    ret = (last_close - entry) / entry * 100.0
    return TradeResult(outcome="time", exit_price=last_close, ret_pct=ret,
                       hold_sessions=len(sessions), **base)


def _summary(label: str, rets: list[float]) -> str:
    if not rets:
        return f"{label:<22} n=0"
    wins = [r for r in rets if r > 0]
    win_rate = len(wins) / len(rets) * 100.0
    avg = statistics.mean(rets)
    med = statistics.median(rets)
    gross_win = sum(r for r in rets if r > 0)
    gross_loss = -sum(r for r in rets if r < 0)
    pf = (gross_win / gross_loss) if gross_loss > 0 else float("inf")
    return (
        f"{label:<22} n={len(rets):<4} win%={win_rate:5.1f}  "
        f"avg={avg:+6.2f}%  median={med:+6.2f}%  profit_factor={pf:4.2f}"
    )


def _bucketize(results: list[TradeResult], attr: str, edges: list[float]) -> None:
    valid = [r for r in results if r.ret_pct is not None and getattr(r, attr) is not None]
    print(f"\n--- by {attr} ---")
    lo = float("-inf")
    for edge in edges + [float("inf")]:
        sel = [r.ret_pct for r in valid if lo <= float(getattr(r, attr)) < edge]
        lbl = f"[{lo:g},{edge:g})" if edge != float("inf") else f"[{lo:g},+inf)"
        print("  " + _summary(lbl, sel))
        lo = edge


def main() -> int:
    p = argparse.ArgumentParser(description="Backtest stored BUY signals vs realized prices.")
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--db", default="data/signals.db")
    p.add_argument("--limit", type=int, default=0, help="Max BUYs to test (0=all).")
    p.add_argument("--csv", default=None, help="Optional path to dump per-trade results.")
    args = p.parse_args()

    cfg = load_config(Path(args.config).expanduser().resolve())
    providers = [
        YahooProvider(timeout_sec=cfg.data.request_timeout_sec, ssl_verify=cfg.data.ssl_verify,
                      ca_bundle_path=None),
        StooqProvider(timeout_sec=cfg.data.request_timeout_sec, ssl_verify=cfg.data.ssl_verify,
                      ca_bundle_path=None, api_key=cfg.data.stooq_api_key),
    ]

    buys = _fetch_buys(Path(args.db).expanduser())
    if args.limit > 0:
        buys = buys[-args.limit:]
    print(f"Loaded {len(buys)} BUY signals from {args.db}")

    today = date.today()
    results: list[TradeResult] = []
    for n, buy in enumerate(buys, start=1):
        asof = date.fromisoformat(buy["asof_date"])
        # Skip trades too recent to have completed their hold window.
        if (today - asof).days < int(buy["max_hold_days"] or 5) + 1:
            continue
        hist = None
        for prov in providers:
            try:
                h = prov.get_history(buy["ticker"], lookback_days=400)
                if h is not None and not h.empty:
                    hist = h
                    break
            except Exception:
                continue
        if hist is None:
            results.append(_simulate(buy, pd.DataFrame()))
            continue
        hist = hist.copy()
        hist.index = pd.to_datetime(hist.index)
        results.append(_simulate(buy, hist))
        if n % 20 == 0:
            print(f"  ...processed {n}/{len(buys)}")

    tested = [r for r in results if r.outcome != "no_data"]
    no_data = [r for r in results if r.outcome == "no_data"]
    rets = [r.ret_pct for r in tested if r.ret_pct is not None]

    print("\n" + "=" * 70)
    print("OVERALL")
    print("=" * 70)
    print(f"signals_evaluated={len(results)}  tested={len(tested)}  no_data={len(no_data)}")
    print("  " + _summary("ALL TRADES", rets))

    oc: dict[str, int] = {}
    for r in tested:
        oc[r.outcome] = oc.get(r.outcome, 0) + 1
    print(f"  outcomes: {oc}")

    _bucketize(tested, "confidence", [85, 90, 95, 100])
    _bucketize(tested, "ret_5d_pct", [10, 20, 30, 50])
    _bucketize(tested, "ret_10d_pct", [15, 25, 40, 60])
    _bucketize(tested, "vol_ratio", [1.5, 2.0, 3.0, 5.0])
    _bucketize(tested, "atr_pct", [3, 5, 7, 10])

    if args.csv:
        out = Path(args.csv).expanduser()
        df = pd.DataFrame([r.__dict__ for r in results])
        df.to_csv(out, index=False)
        print(f"\nPer-trade results -> {out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
