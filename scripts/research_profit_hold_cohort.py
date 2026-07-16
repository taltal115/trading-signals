"""Research cohort: winners/losers by raw profit at each signal's default hold.

Focus (vs managed stop/target backtests):
  - Metric = close-to-close return after ``hold_days`` NYSE sessions (profit, not target hits).
  - Also reports +3 / +5 session raw returns for comparison.
  - Captures AI gate / recommendation / blended scores when present.
  - Intended for post-2026-06-28 research follow-ups.

Usage:
  PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \\
    --since 2026-06-29 --out-csv docs/research/2026-07/profit_hold_cohort_2026-07.csv
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

import pandas as pd

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from signals_bot.config import load_config
from signals_bot.providers.stooq import StooqProvider
from signals_bot.providers.yahoo import YahooProvider
from signals_bot.storage.firestore import SIGNALS_COLLECTION, get_firestore_client


@dataclass
class TradeRow:
    asof_date: str
    ticker: str
    confidence: int
    entry: float
    hold_days: int
    ret_5d_pct: float | None
    ret_10d_pct: float | None
    atr_pct: float | None
    vol_ratio: float | None
    notes: str
    # Raw profit at hold (primary)
    hold_ret_pct: float | None
    ret_3d_pct: float | None
    ret_5d_fwd_pct: float | None
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
            if key in seen and run_ts.get(key, "") <= ts_utc:
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


def _group_stats(rows: list[TradeRow], key_fn) -> list[dict[str, Any]]:
    groups: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        if r.hold_ret_pct is None:
            continue
        groups[str(key_fn(r))].append(r.hold_ret_pct)
    out = []
    for k in sorted(groups.keys()):
        s = _stats(groups[k])
        s["bucket"] = k
        out.append(s)
    return out


def main() -> int:
    p = argparse.ArgumentParser(description="Profit-at-default-hold cohort research.")
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--since", default="2026-06-29", help="asof_date >= this")
    p.add_argument("--until", default=None, help="asof_date <= this (optional)")
    p.add_argument("--limit-runs", type=int, default=120)
    p.add_argument(
        "--out-csv",
        default=str(ROOT_DIR / "docs" / "research" / "2026-07" / "profit_hold_cohort_2026-07.csv"),
    )
    p.add_argument(
        "--out-json",
        default=str(
            ROOT_DIR / "docs" / "research" / "2026-07" / "profit_hold_cohort_2026-07_summary.json"
        ),
    )
    p.add_argument(
        "--include-immature",
        action="store_true",
        help="Include signals that have not completed hold_days yet (hold_ret may be null).",
    )
    args = p.parse_args()

    since = date.fromisoformat(args.since)
    until = date.fromisoformat(args.until) if args.until else None
    cfg = load_config(Path(args.config).expanduser().resolve())
    default_hold = int(cfg.strategy.max_hold_days)

    providers = [
        YahooProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=None,
        ),
        StooqProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=None,
            api_key=cfg.data.stooq_api_key,
        ),
    ]

    buys = _fetch_buys(since=since, until=until, limit_runs=args.limit_runs)
    print(f"Loaded {len(buys)} unique BUY rows since {since.isoformat()}")
    if not buys:
        return 0

    today = date.today()
    rows: list[TradeRow] = []
    for i, sig in enumerate(buys, start=1):
        asof = date.fromisoformat(sig["asof_date"])
        hold_days = int(sig.get("hold_days") or default_hold)
        metrics = sig.get("metrics") if isinstance(sig.get("metrics"), dict) else {}
        entry = float(sig.get("close") or 0.0)

        if not args.include_immature and (today - asof).days < hold_days + 1:
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

        hold_ret = ret3 = ret5 = None
        n_avail = 0
        if hist is not None and entry > 0:
            hist = hist.copy()
            hist.index = pd.to_datetime(hist.index)
            fwd = hist[hist.index.date > asof]
            n_avail = len(fwd)
            hold_ret = _raw_at_n(hist, asof, entry, hold_days)
            ret3 = _raw_at_n(hist, asof, entry, 3)
            ret5 = _raw_at_n(hist, asof, entry, 5)

        gate, decision, total, conviction, model, has_ai = _ai_fields(sig)
        rows.append(
            TradeRow(
                asof_date=sig["asof_date"],
                ticker=str(sig["ticker"]).upper(),
                confidence=int(sig.get("confidence") or 0),
                entry=entry,
                hold_days=hold_days,
                ret_5d_pct=_num(metrics.get("ret_5d_pct")),
                ret_10d_pct=_num(metrics.get("ret_10d_pct")),
                atr_pct=_num(metrics.get("atr_pct")),
                vol_ratio=_num(metrics.get("vol_ratio")),
                notes=str(sig.get("notes") or metrics.get("notes") or ""),
                hold_ret_pct=hold_ret,
                ret_3d_pct=ret3,
                ret_5d_fwd_pct=ret5,
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
        if i % 25 == 0:
            print(f"  ...{i}/{len(buys)}")

    mature = [r for r in rows if r.hold_ret_pct is not None]
    print(f"\nMature trades (hold completed): {len(mature)} / {len(rows)}")

    # Summaries
    overall = _stats([r.hold_ret_pct for r in mature if r.hold_ret_pct is not None])
    at3 = _stats([r.ret_3d_pct for r in rows if r.ret_3d_pct is not None])
    at5 = _stats([r.ret_5d_fwd_pct for r in rows if r.ret_5d_fwd_pct is not None])

    winners = sorted(
        [r for r in mature if r.hold_ret_pct is not None and r.hold_ret_pct > 0],
        key=lambda r: r.hold_ret_pct or 0,
        reverse=True,
    )
    losers = sorted(
        [r for r in mature if r.hold_ret_pct is not None and r.hold_ret_pct < 0],
        key=lambda r: r.hold_ret_pct or 0,
    )

    by_day = _group_stats(mature, lambda r: r.asof_date)
    by_conf = _group_stats(mature, lambda r: _bucket_conf(r.confidence))
    by_ret5 = _group_stats(mature, lambda r: _bucket_ret5(r.ret_5d_pct))
    by_atr = _group_stats(mature, lambda r: _bucket_atr(r.atr_pct))
    by_vol = _group_stats(mature, lambda r: _bucket_vol(r.vol_ratio))
    by_hold = _group_stats(mature, lambda r: f"{r.hold_days}d")
    by_ai_gate = _group_stats(mature, lambda r: r.ai_gate)
    by_ai_decision = _group_stats(mature, lambda r: r.ai_decision)
    by_has_ai = _group_stats(mature, lambda r: "has_ai" if r.has_ai else "no_ai")

    # AI total buckets among those with scores
    def ai_total_bucket(r: TradeRow) -> str:
        if r.ai_total is None:
            return "no_score"
        if r.ai_total >= 80:
            return "ai_total>=80"
        if r.ai_total >= 70:
            return "ai_total_70-79"
        if r.ai_total >= 60:
            return "ai_total_60-69"
        return "ai_total<60"

    by_ai_total = _group_stats(mature, ai_total_bucket)

    print("\n=== PRIMARY: raw profit at signal hold_days (ignores stop/target) ===")
    print(json.dumps(overall, indent=2))
    print("\n=== +3 sessions raw ===")
    print(json.dumps(at3, indent=2))
    print("\n=== +5 sessions raw ===")
    print(json.dumps(at5, indent=2))

    print("\n=== Top 15 winners (hold) ===")
    for r in winners[:15]:
        print(
            f"  {r.asof_date} {r.ticker:<6} hold={r.hold_days}d "
            f"ret={r.hold_ret_pct:+6.2f}% conf={r.confidence} "
            f"ai_gate={r.ai_gate} ai_dec={r.ai_decision} ai_tot={r.ai_total}"
        )
    print("\n=== Top 15 losers (hold) ===")
    for r in losers[:15]:
        print(
            f"  {r.asof_date} {r.ticker:<6} hold={r.hold_days}d "
            f"ret={r.hold_ret_pct:+6.2f}% conf={r.confidence} "
            f"ai_gate={r.ai_gate} ai_dec={r.ai_decision} ai_tot={r.ai_total}"
        )

    summary = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "since": since.isoformat(),
        "until": until.isoformat() if until else None,
        "default_max_hold_days": default_hold,
        "n_unique_buys_loaded": len(buys),
        "n_rows_evaluated": len(rows),
        "n_mature_hold": len(mature),
        "primary_metric": "raw_close_return_at_signal_hold_days",
        "overall_at_hold": overall,
        "raw_at_3_sessions": at3,
        "raw_at_5_sessions": at5,
        "by_asof_date": by_day,
        "by_confidence": by_conf,
        "by_ret_5d_at_entry": by_ret5,
        "by_atr_pct": by_atr,
        "by_vol_ratio": by_vol,
        "by_hold_days": by_hold,
        "by_ai_gate": by_ai_gate,
        "by_ai_decision": by_ai_decision,
        "by_has_ai": by_has_ai,
        "by_ai_total": by_ai_total,
        "top_winners": [asdict(r) for r in winners[:25]],
        "top_losers": [asdict(r) for r in losers[:25]],
        "all_winners": [asdict(r) for r in winners],
        "all_losers": [asdict(r) for r in losers],
    }

    out_csv = Path(args.out_csv)
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame([asdict(r) for r in rows]).to_csv(out_csv, index=False)
    print(f"\nDetail CSV -> {out_csv}")

    out_json = Path(args.out_json)
    out_json.write_text(json.dumps(summary, indent=2, default=str))
    print(f"Summary JSON -> {out_json}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
