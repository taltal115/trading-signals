#!/usr/bin/env python3
"""Research backfill: entry-eval ``ai_gate=pending`` continuation-band BUYs.

Writes AI gate/recommendation for cohort measurement. Does **not** open/close
paper or post Slack (``--skip-paper``).

Usage:
  PYTHONPATH=./src:. python scripts/research_backfill_pending_entry_ai.py \\
    --since 2026-08-04 --max-evals 10
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import date
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from signals_bot.config import load_config
from signals_bot.storage.firestore import SIGNALS_COLLECTION, get_firestore_client

from scripts.ai_stock_eval.main import EXIT_RATE_LIMITED, evaluate_one, _setup_logging


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        n = float(v)
        return n if n == n else None
    except (TypeError, ValueError):
        return None


def _in_continuation_band(
    row: dict[str, Any],
    *,
    ret_min: float,
    ret_max: float,
    vol_min: float,
    vol_max: float,
) -> bool:
    ret5 = _num(row.get("ret_5d_pct"))
    vol = _num(row.get("vol_ratio"))
    if ret5 is None or vol is None:
        return False
    return ret_min <= ret5 <= ret_max and vol_min <= vol < vol_max


def _list_pending_continuation(
    *,
    since: date,
    until: date | None,
    limit_runs: int,
    ret_min: float,
    ret_max: float,
    vol_min: float,
    vol_max: float,
) -> list[dict[str, Any]]:
    db = get_firestore_client()
    query = (
        db.collection(SIGNALS_COLLECTION)
        .order_by("ts_utc", direction="DESCENDING")
        .limit(limit_runs)
    )
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
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
        for sig in data.get("signals") or []:
            if not isinstance(sig, dict):
                continue
            ticker = str(sig.get("ticker", "")).strip().upper()
            if not ticker:
                continue
            gate = str(sig.get("ai_gate") or "").strip().lower()
            if gate != "pending":
                continue
            if not _in_continuation_band(
                sig, ret_min=ret_min, ret_max=ret_max, vol_min=vol_min, vol_max=vol_max
            ):
                continue
            key = (run_asof, ticker)
            if key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "asof_date": run_asof,
                    "ticker": ticker,
                    "signal_doc_id": doc.id,
                    "score": sig.get("score"),
                    "ret_5d_pct": sig.get("ret_5d_pct"),
                    "vol_ratio": sig.get("vol_ratio"),
                    "lottery_flag": bool(sig.get("lottery_flag")),
                }
            )
    out.sort(key=lambda r: (r["asof_date"], r["ticker"]))
    return out


def _candidate_score(raw: Any) -> float:
    try:
        s = float(raw)
        return s * 100.0 if s <= 1.0 + 1e-9 else s
    except (TypeError, ValueError):
        return 0.0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--since", required=True, help="YYYY-MM-DD inclusive")
    p.add_argument("--until", default="", help="YYYY-MM-DD inclusive (optional)")
    p.add_argument("--limit-runs", type=int, default=200)
    p.add_argument("--max-evals", type=int, default=10, help="Cap LLM calls this run")
    p.add_argument("--dry-run", action="store_true", help="List targets only; no LLM/write")
    p.add_argument(
        "--pace-seconds",
        type=float,
        default=20.0,
        help="Sleep between LLM calls (default 20)",
    )
    args = p.parse_args(argv)

    load_dotenv(ROOT / ".env", override=False)
    log = _setup_logging()
    cfg = load_config(ROOT / args.config if not Path(args.config).is_absolute() else Path(args.config))
    strat = getattr(cfg, "strategy", None)
    ret_min = float(getattr(strat, "continuation_ret_5d_min_pct", 10.0) if strat else 10.0)
    ret_max = float(getattr(strat, "continuation_ret_5d_max_pct", 25.0) if strat else 25.0)
    vol_min = float(getattr(strat, "continuation_vol_ratio_min", 2.0) if strat else 2.0)
    vol_max = float(getattr(strat, "continuation_vol_ratio_max", 3.5) if strat else 3.5)

    since = date.fromisoformat(args.since)
    until = date.fromisoformat(args.until) if str(args.until).strip() else None
    targets = _list_pending_continuation(
        since=since,
        until=until,
        limit_runs=max(1, int(args.limit_runs)),
        ret_min=ret_min,
        ret_max=ret_max,
        vol_min=vol_min,
        vol_max=vol_max,
    )
    cap = max(0, int(args.max_evals))
    selected = targets[:cap]
    log.info(
        "Pending continuation-band since %s: found=%d will_eval=%d "
        "(band ret_5d[%.0f,%.0f] vol[%.1f,%.1f))",
        since.isoformat(),
        len(targets),
        len(selected),
        ret_min,
        ret_max,
        vol_min,
        vol_max,
    )
    for t in targets:
        mark = "*" if t in selected else " "
        log.info(
            "%s %s %s doc=%s ret5=%s vol=%s",
            mark,
            t["asof_date"],
            t["ticker"],
            t["signal_doc_id"],
            t.get("ret_5d_pct"),
            t.get("vol_ratio"),
        )
    if args.dry_run or not selected:
        return 0

    failures = 0
    pace = max(0.0, float(args.pace_seconds))
    for i, t in enumerate(selected):
        if i > 0 and pace > 0:
            log.info("Pacing %.1fs before next backfill LLM call", pace)
            time.sleep(pace)
        rc = evaluate_one(
            cfg=cfg,
            log=log,
            ticker=str(t["ticker"]),
            signal_doc_id=str(t["signal_doc_id"]),
            candidate_score=_candidate_score(t.get("score")),
            candidate_from_firestore=True,
            theme="research_backfill",
            source_process="research_backfill_pending_entry_ai",
            position_id=None,
            owner_uid=None,
            dry_run=False,
            debug_prompt=False,
            stdout_json=False,
            verify_only=False,
            github_verify_annotations=False,
            lottery_flag=bool(t.get("lottery_flag")),
            skip_paper=True,
        )
        if rc == EXIT_RATE_LIMITED:
            log.warning("Rate-limited; stopping backfill early (exit 0 soft)")
            return 0
        if rc != 0:
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
