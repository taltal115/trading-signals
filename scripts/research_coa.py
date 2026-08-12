"""Deterministic course-of-action from profit-hold cohort summaries."""

from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any

import requests

from signals_bot.storage.firestore import SIGNALS_COLLECTION, get_firestore_client


def _overall(summary: dict[str, Any]) -> dict[str, Any]:
    o = summary.get("overall_at_hold")
    return o if isinstance(o, dict) else {}


def _gate_n(summary: dict[str, Any], gate: str) -> int:
    for row in summary.get("by_ai_gate") or []:
        if isinstance(row, dict) and str(row.get("bucket") or "").lower() == gate:
            try:
                return int(row.get("n") or 0)
            except (TypeError, ValueError):
                return 0
    return 0


def _bucket_stats(summary: dict[str, Any], key: str, bucket: str) -> dict[str, Any] | None:
    for row in summary.get(key) or []:
        if isinstance(row, dict) and str(row.get("bucket") or "") == bucket:
            return row
    return None


def build_course_of_action(
    summary: dict[str, Any],
    *,
    since: str,
    actionable_only: bool,
) -> dict[str, Any]:
    """Return verdict + prioritized items with concrete config/code suggestions."""
    overall = _overall(summary)
    n_mature = int(summary.get("n_mature_hold") or overall.get("n") or 0)
    n_loaded = int(summary.get("n_unique_buys_loaded") or 0)
    win = overall.get("win_rate_pct")
    avg = overall.get("avg_ret_pct")
    pf = overall.get("profit_factor")
    items: list[dict[str, Any]] = []

    remasure = (
        "PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py "
        f"--since {since} --actionable-only "
        f"--out-csv docs/research/{since[:7]}/profit_hold_cohort_actionable_since_{since}.csv "
        f"--out-json docs/research/{since[:7]}/profit_hold_cohort_actionable_since_{since}_summary.json"
    )

    if n_mature == 0:
        items.append(
            {
                "priority": "high",
                "title": "Empty mature sample — wait before changing strategy",
                "rationale": (
                    f"Loaded {n_loaded} BUYs but n_mature_hold=0 "
                    f"(actionable_only={actionable_only}). Do not loosen filters yet."
                ),
                "suggested_changes": [
                    {
                        "path": "config.yaml",
                        "knob": "strategy.require_continuation_band",
                        "from": None,
                        "to": None,
                        "note": "Keep current hard_reject_* and continuation band unchanged.",
                    }
                ],
            }
        )

    vol_ge5 = _bucket_stats(summary, "by_vol_ratio", ">=5x")
    if vol_ge5 and int(vol_ge5.get("n") or 0) > 0:
        pf_v = vol_ge5.get("profit_factor")
        avg_v = vol_ge5.get("avg_ret_pct")
        toxic = (isinstance(pf_v, (int, float)) and pf_v < 1.0) or (
            isinstance(avg_v, (int, float)) and avg_v < 0
        )
        if toxic or int(vol_ge5.get("losses") or 0) > 0:
            items.append(
                {
                    "priority": "high",
                    "title": "Keep hard-reject on lottery / ≥5× volume",
                    "rationale": (
                        f"vol≥5× bucket n={vol_ge5.get('n')} win%={vol_ge5.get('win_rate_pct')} "
                        f"avg={avg_v} PF={pf_v}. Matches July/Aug lottery failure mode."
                    ),
                    "suggested_changes": [
                        {
                            "path": "config.yaml",
                            "knob": "strategy.hard_reject_vol_ratio_min",
                            "from": None,
                            "to": 5.0,
                            "note": "Keep ≥5; do not raise threshold / disable.",
                        },
                        {
                            "path": "config.yaml",
                            "knob": "strategy.hard_reject_ret_5d_min_pct",
                            "from": None,
                            "to": 50.0,
                            "note": "Keep lottery ret_5d hard reject.",
                        },
                        {
                            "path": "src/signals_bot/strategy/signal_quality.py",
                            "knob": "hard_reject_reasons",
                            "from": None,
                            "to": None,
                            "note": "Ensure hard_reject_* still wired through main._apply_hard_buy_filters.",
                        },
                    ],
                }
            )

    cont = None
    # Approximate continuation band via ret 10-20% and vol 2-3x slices when present.
    ret_band = _bucket_stats(summary, "by_ret_5d_at_entry", "10-20%")
    vol_band = _bucket_stats(summary, "by_vol_ratio", "2-3x")
    if ret_band and int(ret_band.get("n") or 0) >= 3 and float(ret_band.get("win_rate_pct") or 0) >= 60:
        cont = ret_band
    if vol_band and int(vol_band.get("n") or 0) >= 3 and float(vol_band.get("win_rate_pct") or 0) >= 60:
        cont = vol_band if cont is None else cont
    if cont:
        items.append(
            {
                "priority": "medium",
                "title": "Keep continuation band (ret_5d 10–20%, vol 2–3×)",
                "rationale": (
                    f"Continuation-shaped bucket looks healthy "
                    f"(n={cont.get('n')} win%={cont.get('win_rate_pct')} avg={cont.get('avg_ret_pct')})."
                ),
                "suggested_changes": [
                    {
                        "path": "config.yaml",
                        "knob": "strategy.require_continuation_band",
                        "from": None,
                        "to": True,
                        "note": "Do not disable after a single outlier winner outside the band.",
                    }
                ],
            }
        )

    n_passed = _gate_n(summary, "passed")
    n_pending = _gate_n(summary, "pending")
    # Also count from loaded inventory when mature slices omit pending.
    if actionable_only and n_loaded == 0:
        items.append(
            {
                "priority": "critical",
                "title": "Actionable book empty — fix AI entry reliability before strategy tweaks",
                "rationale": (
                    "ai_gate=passed filter returned 0 rows. Likely pending (budget/429/wrong model) "
                    "or filtered/skipped. Product ledger cannot be measured."
                ),
                "suggested_changes": [
                    {
                        "path": "config.yaml",
                        "knob": "ai.pro_model",
                        "from": "gpt-5.4-pro",
                        "to": "",
                        "note": "Must stay empty or chat-compatible; gpt-5.4-pro is Responses-only.",
                    },
                    {
                        "path": "config.yaml",
                        "knob": "ai.entry_model",
                        "from": None,
                        "to": "gpt-5.4",
                        "note": "Keep chat/completions model for entry gate.",
                    },
                    {
                        "path": "scripts/ai_stock_eval/main.py",
                        "knob": "_CHAT_UNSUPPORTED_MODELS / fallback",
                        "from": None,
                        "to": None,
                        "note": "Ensure Responses-only ids never leave rows pending forever.",
                    },
                    {
                        "path": ".github/workflows/ai-entry-batch.yml",
                        "knob": "OPENAI_* retry/pace env",
                        "from": None,
                        "to": None,
                        "note": "Maintain budget + pacing so pending does not dominate.",
                    },
                ],
            }
        )
    elif n_passed == 0 and n_pending > 0:
        items.append(
            {
                "priority": "critical",
                "title": "AI gate stuck on pending — do not treat pending as actionable",
                "rationale": (
                    f"Mature slices show pending={n_pending}, passed={n_passed}. "
                    "Paper/Slack/UI must stay passed-only."
                ),
                "suggested_changes": [
                    {
                        "path": "config.yaml",
                        "knob": "slack.require_ai_passed",
                        "from": None,
                        "to": True,
                        "note": "Keep deferred Slack on AI pass only.",
                    },
                    {
                        "path": "frontend/src/app/features/signals-page/signals-page.component.ts",
                        "knob": "ledgerFilter default",
                        "from": None,
                        "to": "actionable",
                        "note": "Default ledger remains Actionable (ai_gate=passed).",
                    },
                ],
            }
        )

    conf100 = _bucket_stats(summary, "by_confidence", "100")
    if conf100 and int(conf100.get("n") or 0) > 0:
        avg_c = conf100.get("avg_ret_pct")
        if isinstance(avg_c, (int, float)) and avg_c < 0:
            items.append(
                {
                    "priority": "medium",
                    "title": "Keep hard-reject / demotion for conf ≥ 98–100",
                    "rationale": (
                        f"conf=100 bucket avg={avg_c}% win%={conf100.get('win_rate_pct')} "
                        "(historically toxic)."
                    ),
                    "suggested_changes": [
                        {
                            "path": "config.yaml",
                            "knob": "strategy.hard_reject_confidence_min",
                            "from": None,
                            "to": 98,
                            "note": "Keep; do not loosen for one LIFE-style outlier.",
                        }
                    ],
                }
            )

    if n_mature > 0 and isinstance(pf, (int, float)) and pf >= 1.5 and isinstance(win, (int, float)) and win >= 55:
        items.append(
            {
                "priority": "low",
                "title": "Technical book looks healthy — validate on actionable when n_passed grows",
                "rationale": (
                    f"Mature n={n_mature} win%={win} avg={avg} PF={pf}. "
                    "Do not loosen filters; remasure --actionable-only once passed holds mature."
                ),
                "suggested_changes": [
                    {
                        "path": "docs/research/",
                        "knob": "remeasure",
                        "from": None,
                        "to": None,
                        "note": remasure,
                    }
                ],
            }
        )

    if not items:
        items.append(
            {
                "priority": "low",
                "title": "No strong rule triggers — hold config steady",
                "rationale": "Cohort did not hit lottery/empty-pass/continuation heuristics.",
                "suggested_changes": [],
            }
        )

    # Priority order
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    items.sort(key=lambda x: order.get(str(x.get("priority")), 9))

    verdict_parts = []
    if actionable_only and n_loaded == 0:
        verdict_parts.append("Actionable cohort empty — AI reliability blocks product measurement.")
    elif n_mature == 0:
        verdict_parts.append("No mature holds yet — wait before strategy changes.")
    else:
        verdict_parts.append(
            f"Mature n={n_mature} win%={win} avg={avg}% PF={pf}."
        )
    if items and items[0].get("priority") in ("critical", "high"):
        verdict_parts.append(str(items[0].get("title")))

    coa: dict[str, Any] = {
        "verdict": " ".join(verdict_parts),
        "items": items,
        "remeasure_command": remasure,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "llm_narrative": None,
    }
    return coa


def estimate_next_research(
    *,
    since: date,
    min_mature_passed_target: int = 5,
    default_hold_days: int = 3,
) -> dict[str, Any]:
    """Estimate when ≥N mature ai_gate=passed holds will exist from current inventory."""
    db = get_firestore_client()
    query = (
        db.collection(SIGNALS_COLLECTION)
        .order_by("ts_utc", direction="DESCENDING")
        .limit(200)
    )
    today = date.today()
    passed_immature: list[tuple[date, int]] = []
    passed_mature = 0
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
        for sig in data.get("signals") or []:
            if not isinstance(sig, dict):
                continue
            if str(sig.get("ai_gate") or "").strip().lower() != "passed":
                continue
            try:
                hold = int(sig.get("hold_days") or default_hold_days)
            except (TypeError, ValueError):
                hold = default_hold_days
            # mature when calendar days > hold (same heuristic as cohort script)
            if (today - run_d).days >= hold + 1:
                passed_mature += 1
            else:
                passed_immature.append((run_d, hold))

    target = max(1, int(min_mature_passed_target))
    if passed_mature >= target:
        return {
            "due_date": today.isoformat(),
            "reason": (
                f"Already have {passed_mature} mature ai_gate=passed holds "
                f"(target {target}). Remeasure actionable cohort now."
            ),
            "min_mature_passed_target": target,
            "estimated_new_maturities": 0,
            "passed_mature_now": passed_mature,
            "passed_immature_now": len(passed_immature),
        }

    need = target - passed_mature
    # Sort by maturity date ascending
    maturity_dates = sorted(
        run_d + timedelta(days=hold + 1) for run_d, hold in passed_immature
    )
    if len(maturity_dates) >= need:
        due = maturity_dates[need - 1]
        return {
            "due_date": due.isoformat(),
            "reason": (
                f"Need {need} more mature passed holds; "
                f"{len(passed_immature)} immature passed in pipeline."
            ),
            "min_mature_passed_target": target,
            "estimated_new_maturities": need,
            "passed_mature_now": passed_mature,
            "passed_immature_now": len(passed_immature),
        }

    # Not enough passed in pipeline — schedule a check in ~2 weeks
    due = today + timedelta(days=14)
    return {
        "due_date": due.isoformat(),
        "reason": (
            f"Only {passed_mature} mature + {len(passed_immature)} immature passed "
            f"(target {target}). Re-check in ~2 weeks as AI gate produces passes."
        ),
        "min_mature_passed_target": target,
        "estimated_new_maturities": max(0, need - len(maturity_dates)),
        "passed_mature_now": passed_mature,
        "passed_immature_now": len(passed_immature),
    }


def maybe_llm_narrative(coa: dict[str, Any], summary: dict[str, Any]) -> str | None:
    """Optional short narrative; never invent knobs beyond deterministic items."""
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return None
    model = (os.getenv("OPENAI_MODEL") or "gpt-5.4").strip()
    items = coa.get("items") if isinstance(coa.get("items"), list) else []
    payload_user = {
        "verdict": coa.get("verdict"),
        "items": [
            {"priority": i.get("priority"), "title": i.get("title"), "rationale": i.get("rationale")}
            for i in items
            if isinstance(i, dict)
        ],
        "overall_at_hold": summary.get("overall_at_hold"),
        "n_mature_hold": summary.get("n_mature_hold"),
        "actionable_only": summary.get("actionable_only"),
    }
    try:
        resp = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "temperature": 0.2,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You summarize trading-signal research for an engineer. "
                            "2-4 sentences. Do not invent config knobs or file paths "
                            "beyond the provided items. Signal-only (no broker execution)."
                        ),
                    },
                    {
                        "role": "user",
                        "content": json.dumps(payload_user, default=str),
                    },
                ],
            },
            timeout=60,
        )
        if resp.status_code >= 400:
            return None
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        return str(content).strip() or None
    except Exception:  # noqa: BLE001
        return None
