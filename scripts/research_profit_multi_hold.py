"""Research cohort: multi-period holding analysis.

Extended from research_profit_hold_cohort.py to analyze multiple holding periods:
5d, 10d, 15d, 20d (trading sessions).

Usage:
    PYTHONPATH=./src:. python scripts/research_profit_multi_hold.py \
      --since 2026-08-04 --actionable-only \
      --out-dir docs/research/2026-09/multi_hold_analysis
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from signals_bot.config import load_config
from signals_bot.providers import ordered_history_providers
from signals_bot.storage.firestore import SIGNALS_COLLECTION, get_firestore_client
from signals_bot.trading_calendar import nyse_session_dates_between_exclusive_start


@dataclass
class MultiHoldTradeRow:
    asof_date: str
    ticker: str
    confidence: int
    entry: float
    ret_5d_pct: float | None
    ret_10d_pct: float | None
    atr_pct: float | None
    vol_ratio: float | None
    notes: str
    # Multi-period returns
    ret_5_sessions_pct: float | None
    ret_10_sessions_pct: float | None
    ret_15_sessions_pct: float | None
    ret_20_sessions_pct: float | None
    n_sessions_available: int
    # AI layer
    ai_gate: str
    ai_decision: str
    ai_total: float | None
    ai_conviction: float | None
    ai_model: str
    has_ai: bool
    # Firestore research finalization (if present)
    research_status: str
    finalized_pnl_pct: float | None
    finalized_outcome: str


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        n = float(v)
        return n if n == n else None  # NaN check
    except (TypeError, ValueError):
        return None


def _ai_fields(sig: dict[str, Any]) -> tuple[str, str, float | None, float | None, str, bool]:
    gate = str(sig.get("ai_gate") or "").strip() or "none"
    decision = ""
    total = None
    conviction = None
    model = ""
    has_ai = False

    rec = sig.get("recommendation")
    if isinstance(rec, dict):
        decision = str(rec.get("decision") or "").strip().upper()
        has_ai = True

    ai = sig.get("ai")
    if isinstance(ai, dict):
        has_ai = True or bool(ai.get("has_eval"))
        model = str(ai.get("model") or "").strip()
        if not decision:
            decision = str(ai.get("last_decision") or "").strip().upper()

    # Blended scores may live under scores / ai_evaluation
    scores = sig.get("scores")
    if isinstance(scores, dict):
        total = _num(scores.get("total"))
        conviction = _num(scores.get("conviction"))
        has_ai = True

    ae = sig.get("ai_evaluation")
    if isinstance(ae, dict):
        has_ai = True
        llm = ae.get("llm") if isinstance(ae.get("llm"), dict) else {}
        verdict = llm.get("verdict") if isinstance(llm, dict) and isinstance(llm.get("verdict"), dict) else {}
        if not decision and isinstance(verdict, dict):
            decision = str(verdict.get("action") or verdict.get("decision") or "").strip().upper()
        sc = ae.get("scores") if isinstance(ae.get("scores"), dict) else {}
        if total is None:
            total = _num(sc.get("total") or sc.get("blended_total"))
        if conviction is None and isinstance(verdict, dict):
            conviction = _num(verdict.get("conviction"))
        if not model:
            model = str(ae.get("model") or (ae.get("llm") or {}).get("model") or "").strip()

    if not gate or gate == "none":
        if has_ai and decision:
            gate = "evaluated"
        elif has_ai:
            gate = "present"

    return gate, decision or "—", total, conviction, model, has_ai


def _fetch_buys(*, since: date, until: date | None, limit_runs: int) -> list[dict[str, Any]]:
    db = get_firestore_client()
    query = (
        db.collection(SIGNALS_COLLECTION)
        .order_by("ts_utc", direction="DESCENDING")
        .limit(limit_runs)
    )
    seen: dict[tuple[str, str], dict[str, Any]] = {}
    run_ts: dict[tuple[str, str], str] = {}

    for doc in query.stream():
        data = doc.to_dict() or {}
        run_asof = str(data.get("asof_date", "")).strip()
        if not run_asof:
            continue
        try:
            run_d = date.fromisoformat(run_asof)
        except ValueError:
            continue
        if run_d < since:
            continue
        if until is not None and run_d > until:
            continue

        ts_utc = str(data.get("ts_utc", ""))
        doc_id = doc.id
        for sig in data.get("signals") or []:
            ticker = str(sig.get("ticker", "")).strip().upper()
            if not ticker:
                continue
            key = (run_asof, ticker)
            # Keep the LATEST run per (asof_date, ticker)
            if key in seen and run_ts.get(key, "") >= ts_utc:
                continue
            row = dict(sig)
            row["asof_date"] = run_asof
            row["ts_utc"] = ts_utc
            row["signal_doc_id"] = doc_id
            seen[key] = row
            run_ts[key] = ts_utc

    return sorted(seen.values(), key=lambda r: (r["asof_date"], r["ticker"]))


def _raw_at_n(hist: pd.DataFrame, asof: date, entry: float, n: int) -> float | None:
    fwd = hist[hist.index.date > asof]
    if len(fwd) < n or entry <= 0:
        return None
    close_n = float(fwd.iloc[n - 1]["close"])
    return (close_n - entry) / entry * 100.0


def _bucket_conf(c: int) -> str:
    if c >= 100:
        return "100"
    if c >= 95:
        return "95-99"
    if c >= 90:
        return "90-94"
    if c >= 80:
        return "80-89"
    if c >= 70:
        return "70-79"
    return "<70"


def _bucket_ret5(v: float | None) -> str:
    if v is None:
        return "unknown"
    if v < 10:
        return "<10%"
    if v < 20:
        return "10-20%"
    if v < 30:
        return "20-30%"
    if v < 50:
        return "30-50%"
    return ">=50%"


def _bucket_atr(v: float | None) -> str:
    if v is None:
        return "unknown"
    if v < 3:
        return "<3%"
    if v < 5:
        return "3-5%"
    if v < 7:
        return "5-7%"
    if v < 10:
        return "7-10%"
    return ">=10%"


def _bucket_vol(v: float | None) -> str:
    if v is None:
        return "unknown"
    if v < 2:
        return "<2x"
    if v < 3:
        return "2-3x"
    if v < 5:
        return "3-5x"
    return ">=5x"


def _stats(rets: list[float]) -> dict[str, Any]:
    if not rets:
        return {"n": 0}
    wins = [r for r in rets if r > 0]
    losses = [r for r in rets if r < 0]
    flats = [r for r in rets if r == 0]
    gw = sum(wins)
    gl = -sum(losses)
    return {
        "n": len(rets),
        "wins": len(wins),
        "losses": len(losses),
        "flats": len(flats),
        "win_rate_pct": round(len(wins) / len(rets) * 100.0, 1),
        "avg_ret_pct": round(statistics.mean(rets), 2),
        "median_ret_pct": round(statistics.median(rets), 2),
        "avg_win_pct": round(statistics.mean(wins), 2) if wins else None,
        "avg_loss_pct": round(statistics.mean(losses), 2) if losses else None,
        "profit_factor": round(gw / gl, 2) if gl > 0 else (float("inf") if gw > 0 else None),
        "total_pnl_pct_sum": round(sum(rets), 2),
    }


def _group_stats(rows: list[MultiHoldTradeRow], key_fn, hold_field: str) -> list[dict[str, Any]]:
    groups: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        ret_val = getattr(r, hold_field)
        if ret_val is None:
            continue
        groups[str(key_fn(r))].append(ret_val)
    out = []
    for k in sorted(groups.keys()):
        s = _stats(groups[k])
        s["bucket"] = k
        out.append(s)
    return out


def run_multi_hold_cohort(
    *,
    config_path: Path,
    since: date,
    until: date | None = None,
    limit_runs: int = 120,
    max_hold_sessions: int = 20,
    actionable_only: bool = False,
    quiet: bool = False,
) -> tuple[dict[str, Any], list[MultiHoldTradeRow]]:
    """Compute multi-period cohort summary + detail rows."""
    cfg = load_config(Path(config_path).expanduser().resolve())
    providers = ordered_history_providers(cfg)

    buys = _fetch_buys(since=since, until=until, limit_runs=limit_runs)
    if not quiet:
        print(f"Loaded {len(buys)} unique BUY rows since {since.isoformat()}")
    if actionable_only:
        before = len(buys)
        buys = [
            b
            for b in buys
            if str(b.get("ai_gate") or "").strip().lower() == "passed"
        ]
        if not quiet:
            print(f"Actionable-only (ai_gate=passed): {len(buys)} / {before}")

    if not buys:
        empty_summary = {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "since": since.isoformat(),
            "until": until.isoformat() if until else None,
            "actionable_only": bool(actionable_only),
            "max_hold_sessions": max_hold_sessions,
            "n_unique_buys_loaded": 0,
            "n_rows_evaluated": 0,
            "note": "empty_cohort",
        }
        return empty_summary, []

    # Market date
    today = datetime.now(ZoneInfo(cfg.run.timezone)).date()
    rows: list[MultiHoldTradeRow] = []
    n_data_error = 0

    for i, sig in enumerate(buys, start=1):
        asof = date.fromisoformat(sig["asof_date"])
        metrics = sig.get("metrics") if isinstance(sig.get("metrics"), dict) else {}
        entry = float(sig.get("close") or 0.0)

        # Skip immature trades (need at least max_hold_sessions + 1 for all periods)
        if nyse_session_dates_between_exclusive_start(asof, today) < max_hold_sessions + 1:
            continue

        hist = None
        for prov in providers:
            try:
                h = prov.get_history(str(sig["ticker"]), lookback_days=400)
                if h is not None and not h.empty:
                    hist = h
                    break
            except Exception:
                continue

        if hist is None:
            n_data_error += 1
            print(f"  DATA_ERROR {sig['asof_date']} {sig['ticker']}: no price history from any provider")
            continue

        hist = hist.copy()
        hist.index = pd.to_datetime(hist.index)
        fwd = hist[hist.index.date > asof]
        n_avail = len(fwd)

        # Compute returns at 5, 10, 15, 20 sessions
        ret_5 = _raw_at_n(hist, asof, entry, 5)
        ret_10 = _raw_at_n(hist, asof, entry, 10)
        ret_15 = _raw_at_n(hist, asof, entry, 15)
        ret_20 = _raw_at_n(hist, asof, entry, 20)

        gate, decision, total, conviction, model, has_ai = _ai_fields(sig)
        rows.append(
            MultiHoldTradeRow(
                asof_date=sig["asof_date"],
                ticker=str(sig["ticker"]).upper(),
                confidence=int(sig.get("confidence") or 0),
                entry=entry,
                ret_5d_pct=_num(metrics.get("ret_5d_pct")),
                ret_10d_pct=_num(metrics.get("ret_10d_pct")),
                atr_pct=_num(metrics.get("atr_pct")),
                vol_ratio=_num(metrics.get("vol_ratio")),
                notes=str(sig.get("notes") or metrics.get("notes") or ""),
                ret_5_sessions_pct=ret_5,
                ret_10_sessions_pct=ret_10,
                ret_15_sessions_pct=ret_15,
                ret_20_sessions_pct=ret_20,
                n_sessions_available=n_avail,
                ai_gate=gate,
                ai_decision=decision,
                ai_total=total,
                ai_conviction=conviction,
                ai_model=model,
                has_ai=has_ai,
                research_status=str(sig.get("researchStatus") or ""),
                finalized_pnl_pct=_num(sig.get("pnlPct")),
                finalized_outcome=str(sig.get("outcome") or ""),
            )
        )
        if not quiet and i % 25 == 0:
            print(f"  ...{i}/{len(buys)}")

    # Compute stats for each holding period
    mature_5 = [r for r in rows if r.ret_5_sessions_pct is not None]
    mature_10 = [r for r in rows if r.ret_10_sessions_pct is not None]
    mature_15 = [r for r in rows if r.ret_15_sessions_pct is not None]
    mature_20 = [r for r in rows if r.ret_20_sessions_pct is not None]

    print(f"\nMature trades by holding period:")
    print(f"  5 sessions:  {len(mature_5)} / {len(rows)}")
    print(f"  10 sessions: {len(mature_10)} / {len(rows)}")
    print(f"  15 sessions: {len(mature_15)} / {len(rows)}")
    print(f"  20 sessions: {len(mature_20)} / {len(rows)}")
    if n_data_error:
        print(
            f"WARNING: {n_data_error} row(s) had no price history (excluded from stats) — "
            "possible survivorship bias."
        )

    overall_5 = _stats([r.ret_5_sessions_pct for r in mature_5 if r.ret_5_sessions_pct is not None])
    overall_10 = _stats([r.ret_10_sessions_pct for r in mature_10 if r.ret_10_sessions_pct is not None])
    overall_15 = _stats([r.ret_15_sessions_pct for r in mature_15 if r.ret_15_sessions_pct is not None])
    overall_20 = _stats([r.ret_20_sessions_pct for r in mature_20 if r.ret_20_sessions_pct is not None])

    # Winners/losers for each period
    winners_5 = sorted(
        [r for r in mature_5 if r.ret_5_sessions_pct is not None and r.ret_5_sessions_pct > 0],
        key=lambda r: r.ret_5_sessions_pct or 0,
        reverse=True,
    )
    losers_5 = sorted(
        [r for r in mature_5 if r.ret_5_sessions_pct is not None and r.ret_5_sessions_pct < 0],
        key=lambda r: r.ret_5_sessions_pct or 0,
    )

    winners_20 = sorted(
        [r for r in mature_20 if r.ret_20_sessions_pct is not None and r.ret_20_sessions_pct > 0],
        key=lambda r: r.ret_20_sessions_pct or 0,
        reverse=True,
    )
    losers_20 = sorted(
        [r for r in mature_20 if r.ret_20_sessions_pct is not None and r.ret_20_sessions_pct < 0],
        key=lambda r: r.ret_20_sessions_pct or 0,
    )

    def ai_total_bucket(r: MultiHoldTradeRow) -> str:
        if r.ai_total is None:
            return "no_score"
        if r.ai_total >= 80:
            return "ai_total>=80"
        if r.ai_total >= 70:
            return "ai_total_70-79"
        if r.ai_total >= 60:
            return "ai_total_60-69"
        return "ai_total<60"

    summary = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "since": since.isoformat(),
        "until": until.isoformat() if until else None,
        "actionable_only": bool(actionable_only),
        "max_hold_sessions": max_hold_sessions,
        "n_unique_buys_loaded": len(buys),
        "n_rows_evaluated": len(rows),
        "n_data_error": n_data_error,
        "overall_at_5_sessions": overall_5,
        "overall_at_10_sessions": overall_10,
        "overall_at_15_sessions": overall_15,
        "overall_at_20_sessions": overall_20,
        "by_confidence_5d": _group_stats(mature_5, lambda r: _bucket_conf(r.confidence), "ret_5_sessions_pct"),
        "by_confidence_10d": _group_stats(mature_10, lambda r: _bucket_conf(r.confidence), "ret_10_sessions_pct"),
        "by_confidence_15d": _group_stats(mature_15, lambda r: _bucket_conf(r.confidence), "ret_15_sessions_pct"),
        "by_confidence_20d": _group_stats(mature_20, lambda r: _bucket_conf(r.confidence), "ret_20_sessions_pct"),
        "by_ret_5d_at_entry_5sess": _group_stats(mature_5, lambda r: _bucket_ret5(r.ret_5d_pct), "ret_5_sessions_pct"),
        "by_ret_5d_at_entry_20sess": _group_stats(mature_20, lambda r: _bucket_ret5(r.ret_5d_pct), "ret_20_sessions_pct"),
        "by_atr_pct_5sess": _group_stats(mature_5, lambda r: _bucket_atr(r.atr_pct), "ret_5_sessions_pct"),
        "by_atr_pct_20sess": _group_stats(mature_20, lambda r: _bucket_atr(r.atr_pct), "ret_20_sessions_pct"),
        "by_vol_ratio_5sess": _group_stats(mature_5, lambda r: _bucket_vol(r.vol_ratio), "ret_5_sessions_pct"),
        "by_vol_ratio_20sess": _group_stats(mature_20, lambda r: _bucket_vol(r.vol_ratio), "ret_20_sessions_pct"),
        "by_ai_gate_5sess": _group_stats(mature_5, lambda r: r.ai_gate, "ret_5_sessions_pct"),
        "by_ai_gate_20sess": _group_stats(mature_20, lambda r: r.ai_gate, "ret_20_sessions_pct"),
        "by_ai_total_5sess": _group_stats(mature_5, ai_total_bucket, "ret_5_sessions_pct"),
        "by_ai_total_20sess": _group_stats(mature_20, ai_total_bucket, "ret_20_sessions_pct"),
        "top_winners_5sess": [asdict(r) for r in winners_5[:15]],
        "top_losers_5sess": [asdict(r) for r in losers_5[:15]],
        "top_winners_20sess": [asdict(r) for r in winners_20[:15]],
        "top_losers_20sess": [asdict(r) for r in losers_20[:15]],
    }
    return summary, rows


def main() -> int:
    p = argparse.ArgumentParser(description="Multi-period profit-at-hold cohort research.")
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--since", default="2026-08-04", help="asof_date >= this")
    p.add_argument("--until", default=None, help="asof_date <= this (optional)")
    p.add_argument("--limit-runs", type=int, default=120)
    p.add_argument("--max-hold-sessions", type=int, default=20, help="Maximum holding period (sessions)")
    p.add_argument(
        "--out-dir",
        default=str(ROOT_DIR / "docs" / "research" / "2026-09" / "multi_hold_analysis"),
    )
    p.add_argument(
        "--actionable-only",
        action="store_true",
        help="Only score rows with ai_gate=passed (matches Slack actionable ledger).",
    )
    args = p.parse_args()

    since = date.fromisoformat(args.since)
    until = date.fromisoformat(args.until) if args.until else None
    summary, rows = run_multi_hold_cohort(
        config_path=Path(args.config),
        since=since,
        until=until,
        limit_runs=args.limit_runs,
        max_hold_sessions=args.max_hold_sessions,
        actionable_only=bool(args.actionable_only),
    )

    print("\n=== MULTI-PERIOD HOLDING ANALYSIS ===")
    print("\n5 Sessions (1 week):")
    print(json.dumps(summary.get("overall_at_5_sessions") or {}, indent=2))
    print("\n10 Sessions (2 weeks):")
    print(json.dumps(summary.get("overall_at_10_sessions") or {}, indent=2))
    print("\n15 Sessions (3 weeks):")
    print(json.dumps(summary.get("overall_at_15_sessions") or {}, indent=2))
    print("\n20 Sessions (1 month):")
    print(json.dumps(summary.get("overall_at_20_sessions") or {}, indent=2))

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Write detail CSV
    out_csv = out_dir / f"multi_hold_detail_since_{since.isoformat()}.csv"
    pd.DataFrame([asdict(r) for r in rows]).to_csv(out_csv, index=False)
    print(f"\nDetail CSV -> {out_csv}")

    # Write summary JSON
    out_json = out_dir / f"multi_hold_summary_since_{since.isoformat()}.json"
    out_json.write_text(json.dumps(summary, indent=2, default=str))
    print(f"Summary JSON -> {out_json}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
