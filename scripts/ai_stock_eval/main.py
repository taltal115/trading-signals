"""CLI: AI stock evaluation pipeline (context → LLM → score → Firestore dual-write)."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from signals_bot.config import load_config

# Exit codes: 0 ok; 1 hard failure; 3 transient OpenAI rate limit (leave pending).
EXIT_RATE_LIMITED = 3

# scripts/ai_stock_eval/main.py → repo root
REPO_ROOT = Path(__file__).resolve().parents[2]


def _resolve_repo_path(path_str: str) -> Path:
    """Resolve config (and similar) relative to repo root when not absolute."""
    p = Path(path_str).expanduser()
    if not p.is_absolute():
        p = REPO_ROOT / p
    return p.resolve()


from .context import build_context, build_provider_status_dict
from .features import build_features_strategy_and_placeholders, render_user_prompt
from .firestore_write import (
    in_continuation_band,
    latest_signal_doc_id,
    list_pending_tickers,
    list_recent_pending_entry_targets,
    load_signal_run_rows,
    partition_entry_eval_queue,
    read_candidate_score,
    read_signal_row,
    write_entry_evaluation,
    write_entry_rank_skipped,
)
from .llm import OpenAIHttpError, call_openai_json, normalize_verdict
from .prompts import get_entry_prompts
from .recommendation import build_recommendation, resolve_ai_gate
from .score import compute_total_score
from .verify_context import format_github_annotation, verify_eval_context


def _short_reason(recommendation: dict[str, Any]) -> str:
    s = str(recommendation.get("headline") or "").strip()
    w = str(recommendation.get("why") or "").strip()
    parts = [p for p in (s, w) if p]
    out = " — ".join(parts) if parts else "(no summary from model)"
    if len(out) > 280:
        return out[:279] + "…"
    return out


def _setup_logging() -> logging.Logger:
    log = logging.getLogger("ai_stock_eval")
    fmt = logging.Formatter("%(levelname)s %(message)s")
    if not log.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(fmt)
        log.addHandler(h)
    log.setLevel(logging.INFO)
    # Surface retry warnings from llm.py (different logger name) on stdout.
    llm_log = logging.getLogger("scripts.ai_stock_eval.llm")
    if not llm_log.handlers:
        h2 = logging.StreamHandler(sys.stdout)
        h2.setFormatter(fmt)
        llm_log.addHandler(h2)
    llm_log.setLevel(logging.INFO)
    llm_log.propagate = False
    return log


def _inter_request_seconds() -> float:
    try:
        return max(0.0, float(os.getenv("OPENAI_INTER_REQUEST_SECONDS", "15")))
    except (TypeError, ValueError):
        return 15.0


def _ai_pricing(cfg: Any) -> dict[str, dict[str, float]] | None:
    ai = getattr(cfg, "ai", None)
    if ai is None:
        return None
    return getattr(ai, "pricing", None)


# Models that reject v1/chat/completions (Responses API only as of 2026-03).
_CHAT_UNSUPPORTED_MODELS = frozenset(
    {
        "gpt-5.4-pro",
        "gpt-5.4-pro-2026-03-05",
        "gpt-5.2-pro",
        "gpt-5.2-pro-2025-12-11",
    }
)


def _ai_model(cfg: Any, *, technical_score: float, force_pro: bool = False) -> str:
    """Entry gate model: gpt-5.4 by default; optional pro_model when score is high."""
    ai = getattr(cfg, "ai", None)
    if ai is None:
        return "gpt-5.4"
    entry = str(getattr(ai, "entry_model", None) or getattr(ai, "model", None) or "gpt-5.4")
    pro = str(getattr(ai, "pro_model", None) or "").strip()
    threshold = float(getattr(ai, "pro_min_technical_score", 75.0) or 75.0)
    chosen = entry
    if pro and (force_pro or technical_score >= threshold):
        chosen = pro
    # Never send Responses-only ids to chat/completions.
    if chosen in _CHAT_UNSUPPORTED_MODELS or chosen.split("/")[-1] in _CHAT_UNSUPPORTED_MODELS:
        return entry
    return chosen


def _is_not_a_chat_model_error(exc: OpenAIHttpError) -> bool:
    blob = f"{exc} {exc.body_snippet}".lower()
    return "not a chat model" in blob or (
        exc.status_code == 404 and "chat/completions" in blob
    )


def evaluate_one(
    *,
    cfg: Any,
    log: logging.Logger,
    ticker: str,
    signal_doc_id: str,
    candidate_score: float,
    candidate_from_firestore: bool,
    theme: str,
    source_process: str,
    position_id: str | None,
    owner_uid: str | None,
    dry_run: bool,
    debug_prompt: bool,
    stdout_json: bool,
    verify_only: bool,
    github_verify_annotations: bool,
    lottery_flag: bool = False,
    skip_paper: bool = False,
) -> int:
    system_prompt, user_template = get_entry_prompts()
    ctx = build_context(ticker=ticker, cfg=cfg, candidate_score=candidate_score)
    feats, strategy_results, best_strategy, placeholders = build_features_strategy_and_placeholders(
        ctx=ctx,
        cfg=cfg,
        theme=theme,
        source_process=source_process,
    )
    strat_score = float(strategy_results.get(best_strategy, {}).get("score", 0.0))
    user_msg = render_user_prompt(user_template, placeholders)

    verr, vwarn = verify_eval_context(
        ctx=ctx,
        placeholders=placeholders,
        candidate_from_firestore=candidate_from_firestore,
    )
    log.info("[VERIFY] Context check for %s (history rows=%d)", ticker, len(ctx.hist))
    for w in vwarn:
        if github_verify_annotations:
            print(format_github_annotation("warning", w), flush=True)
        log.warning("[VERIFY] %s", w)
    for e in verr:
        if github_verify_annotations:
            print(format_github_annotation("error", e), flush=True)
        log.error("[VERIFY] %s", e)

    if verify_only:
        return 1 if verr else 0

    if verr:
        log.error("Context verification failed for %s; skipping.", ticker)
        return 1

    if debug_prompt:
        print("========== AI EVAL DEBUG: SYSTEM PROMPT ==========", flush=True)
        print(system_prompt, flush=True)
        print("========== AI EVAL DEBUG: USER PROMPT ==========", flush=True)
        print(user_msg, flush=True)
        print("========== END DEBUG PROMPTS ==========", flush=True)

    ai_cfg = getattr(cfg, "ai", None)
    # Lottery names are hard-rejected by rules (2026-08); pro forced only if still flagged + config.
    force_pro = bool(
        lottery_flag and ai_cfg is not None and getattr(ai_cfg, "lottery_force_pro_model", False)
    )
    technical_for_routing = float(feats.get("technical_score") or candidate_score or 0.0)
    entry_model = _ai_model(cfg, technical_score=technical_for_routing, force_pro=force_pro)
    if ai_cfg is not None:
        fallback_model = str(
            getattr(ai_cfg, "entry_model", None) or getattr(ai_cfg, "model", None) or "gpt-5.4"
        )
    else:
        fallback_model = "gpt-5.4"
    log.info(
        "Entry model for %s: %s (technical_score=%.1f lottery=%s)",
        ticker,
        entry_model,
        technical_for_routing,
        lottery_flag,
    )
    try:
        try:
            raw_verdict, usage, raw_response_text = call_openai_json(
                system=system_prompt,
                user=user_msg,
                model=entry_model,
                pricing=_ai_pricing(cfg),
            )
        except OpenAIHttpError as e:
            if (
                _is_not_a_chat_model_error(e)
                and fallback_model
                and fallback_model != entry_model
            ):
                log.warning(
                    "Entry model %s rejected by chat/completions for %s; falling back to %s (%s)",
                    entry_model,
                    ticker,
                    fallback_model,
                    e,
                )
                raw_verdict, usage, raw_response_text = call_openai_json(
                    system=system_prompt,
                    user=user_msg,
                    model=fallback_model,
                    pricing=_ai_pricing(cfg),
                )
            else:
                raise
    except OpenAIHttpError as e:
        # Keep ai_gate=pending; never stub-BUY on rate limit / quota.
        if e.is_insufficient_quota:
            log.error(
                "Entry LLM insufficient_quota for %s (leave pending): %s",
                ticker,
                e,
            )
            return 1
        if e.is_rate_limit:
            log.error(
                "Entry LLM rate-limited for %s (leave pending for next run): %s",
                ticker,
                e,
            )
            return EXIT_RATE_LIMITED
        log.error(
            "Entry LLM HTTP failed for %s (leave ai_gate=pending, not passed): %s",
            ticker,
            e,
        )
        return 1
    except Exception as e:  # noqa: BLE001 — keep ai_gate=pending; never stub-BUY on failures
        log.error(
            "Entry LLM failed for %s (leave ai_gate=pending, not passed): %s",
            ticker,
            e,
        )
        return 1
    verdict = normalize_verdict(raw_verdict)
    conviction = float(verdict["conviction"])

    total, breakdown = compute_total_score(
        features=feats,
        strategy_results=strategy_results,
        best_strategy=best_strategy,
        conviction=conviction,
    )

    scores: dict[str, Any] = {
        "candidate_score": float(candidate_score),
        "total": float(total),
        "breakdown": {k: float(v) for k, v in breakdown.items()},
        "conviction": float(conviction),
        "best_strategy": str(best_strategy),
        "strategy_score": float(strat_score),
    }
    technical = float(feats.get("technical_score") or 0.0)
    recommendation = build_recommendation(
        verdict=verdict,
        scores=scores,
        technical_score=technical,
    )
    entry_min_total = float(getattr(ai_cfg, "entry_min_total", 70.0) if ai_cfg else 70.0)
    entry_min_conviction = float(getattr(ai_cfg, "entry_min_conviction", 0.7) if ai_cfg else 0.7)
    if lottery_flag and ai_cfg is not None:
        entry_min_total = float(getattr(ai_cfg, "lottery_entry_min_total", entry_min_total))
        entry_min_conviction = float(
            getattr(ai_cfg, "lottery_entry_min_conviction", entry_min_conviction)
        )
        log.info(
            "Lottery thresholds for %s: min_total=%.1f min_conviction=%.2f",
            ticker,
            entry_min_total,
            entry_min_conviction,
        )
    ai_gate = resolve_ai_gate(
        recommendation=recommendation,
        conviction=conviction,
        entry_min_total=entry_min_total,
        entry_min_conviction=entry_min_conviction,
    )

    provider_status = build_provider_status_dict(
        ctx, candidate_from_firestore=candidate_from_firestore
    )
    result_payload = {
        "ticker": ticker,
        "signal_doc_id": signal_doc_id,
        "ai_gate": ai_gate,
        "recommendation": recommendation,
        "usage": {
            "model": usage.model,
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "total_tokens": usage.total_tokens,
            "estimated_cost_usd": usage.estimated_cost_usd,
            "cost_estimated": usage.cost_estimated,
            "source": usage.source,
        },
        "provider_status": provider_status,
        "raw_response": raw_response_text if debug_prompt else None,
    }

    log.info(
        "AI eval %s gate=%s decision=%s total=%.2f conviction=%.2f tokens=%d model=%s | %s",
        ticker,
        ai_gate,
        recommendation.get("decision"),
        total,
        conviction,
        usage.total_tokens,
        usage.model,
        _short_reason(recommendation),
    )

    if stdout_json:
        print(json.dumps(result_payload, indent=2, default=str))

    if dry_run:
        return 0

    write_entry_evaluation(
        ticker=ticker,
        signal_doc_id=signal_doc_id,
        position_id=position_id,
        owner_uid=owner_uid,
        recommendation=recommendation,
        ai_gate=ai_gate,
        stage="entry",
        usage=usage,
        detail={
            "verdict": verdict,
            "scores": scores,
            "provider_status": provider_status,
        },
        apply_plan_overrides=True,
        skip_paper=bool(skip_paper),
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="AI-assisted stock evaluation (signal-only).")
    p.add_argument(
        "--config",
        default="config.yaml",
        help="Path to config.yaml (default: config.yaml at repo root)",
    )
    p.add_argument("--ticker", default="", help="Ticker symbol (required unless --batch)")
    p.add_argument(
        "--signal-doc-id",
        default="",
        help="Firestore run document id in signals collection",
    )
    p.add_argument(
        "--batch",
        action="store_true",
        help="Evaluate all ai_gate=pending tickers on the run (capped by config)",
    )
    p.add_argument("--position-id", default="", help="Firestore my_positions document id (optional)")
    p.add_argument("--owner-uid", default="", help="Firebase auth uid owning the position (optional)")
    p.add_argument("--theme", default="", help="Theme label for the prompt")
    p.add_argument("--source-process", default="ai_stock_eval", help="Source label for the prompt")
    p.add_argument("--dry-run", action="store_true", help="Compute only; do not write Firestore")
    p.add_argument(
        "--skip-paper",
        action="store_true",
        help="Write ai_gate/recommendation but do not open/close my_positions (research backfill).",
    )
    p.add_argument("--stdout-json", action="store_true", help="Print result JSON to stdout")
    p.add_argument(
        "--candidate-score",
        type=float,
        default=None,
        help="Override candidate score (0–100 scale); skips Firestore read for signals doc",
    )
    p.add_argument(
        "--verify-only",
        action="store_true",
        help="Fetch context, run provider checks, exit (no OpenAI / no Firestore write).",
    )
    p.add_argument(
        "--debug-prompt",
        action="store_true",
        help="Print system + user prompts to stdout before calling the LLM.",
    )
    p.add_argument(
        "--github-verify-annotations",
        action="store_true",
        help="Emit ::warning:: / ::error:: lines for GitHub Actions (use with --verify-only).",
    )
    args = p.parse_args(argv)

    load_dotenv(REPO_ROOT / ".env", override=False)

    log = _setup_logging()
    if not args.verify_only and not (os.getenv("OPENAI_API_KEY") or "").strip():
        log.warning(
            "OPENAI_API_KEY is unset — using LLM stub (source=stub). "
            "For GitHub Actions set repo secret OPENAI_API_KEY; locally add it to .env."
        )
    cfg_path = _resolve_repo_path(args.config)
    if not cfg_path.is_file():
        log.error("Config not found: %s", cfg_path)
        return 2
    cfg = load_config(cfg_path)

    ai_cfg = getattr(cfg, "ai", None)
    if ai_cfg is not None and not bool(getattr(ai_cfg, "enabled", True)):
        log.info("ai.enabled=false — skipping evaluation")
        return 0

    from signals_bot.storage.firestore import get_firestore_client

    db = get_firestore_client()
    explicit_signal_doc = bool(str(args.signal_doc_id).strip())
    signal_doc_id = str(args.signal_doc_id).strip()
    if not signal_doc_id:
        signal_doc_id = latest_signal_doc_id(db) or ""
        if not signal_doc_id:
            log.error("No --signal-doc-id and no latest signals run found")
            return 2
        log.info("Using latest signal doc id=%s", signal_doc_id)

    position_id = str(args.position_id).strip() or None
    owner_uid = str(args.owner_uid).strip() or None

    if args.batch:
        strat = getattr(cfg, "strategy", None)
        prefer_min = float(getattr(strat, "ret_5d_prefer_min_pct", 8.0) if strat else 8.0)
        prefer_max = float(getattr(strat, "ret_5d_prefer_max_pct", 20.0) if strat else 20.0)
        lottery_vol = float(getattr(strat, "lottery_vol_ratio_min", 5.0) if strat else 5.0)
        lottery_ret = float(getattr(strat, "lottery_ret_5d_min_pct", 50.0) if strat else 50.0)
        cont_ret_min = float(getattr(strat, "continuation_ret_5d_min_pct", 10.0) if strat else 10.0)
        cont_ret_max = float(getattr(strat, "continuation_ret_5d_max_pct", 20.0) if strat else 20.0)
        cont_vol_min = float(getattr(strat, "continuation_vol_ratio_min", 2.0) if strat else 2.0)
        cont_vol_max = float(getattr(strat, "continuation_vol_ratio_max", 3.0) if strat else 3.0)
        top_n = int(getattr(ai_cfg, "max_entry_evals_per_run", 5) if ai_cfg else 5)
        top_n = max(0, top_n)

        if explicit_signal_doc:
            pending_tuples = list_pending_tickers(
                db,
                signal_doc_id,
                prefer_min_pct=prefer_min,
                prefer_max_pct=prefer_max,
                lottery_vol_ratio_min=lottery_vol,
                lottery_ret_5d_min_pct=lottery_ret,
            )
            targets: list[dict[str, Any]] = []
            for ticker, _idx, cand in pending_tuples:
                row = read_signal_row(db, signal_doc_id, ticker) or {}
                targets.append(
                    {
                        "signal_doc_id": signal_doc_id,
                        "ticker": ticker,
                        "candidate_score": cand,
                        "in_band": in_continuation_band(
                            row,
                            ret_min=cont_ret_min,
                            ret_max=cont_ret_max,
                            vol_min=cont_vol_min,
                            vol_max=cont_vol_max,
                        ),
                        "lottery_flag": bool(row.get("lottery_flag")),
                    }
                )
            # Preserve list_pending rank within band; continuation-band first.
            targets = [t for t in targets if t["in_band"]] + [
                t for t in targets if not t["in_band"]
            ]
        else:
            targets = list_recent_pending_entry_targets(
                db,
                limit_runs=20,
                prefer_min_pct=prefer_min,
                prefer_max_pct=prefer_max,
                lottery_vol_ratio_min=lottery_vol,
                lottery_ret_5d_min_pct=lottery_ret,
                cont_ret_min=cont_ret_min,
                cont_ret_max=cont_ret_max,
                cont_vol_min=cont_vol_min,
                cont_vol_max=cont_vol_max,
            )

        for_llm, for_skip, leave_pending = partition_entry_eval_queue(targets, top_n=top_n)
        log.info(
            "Batch entry pending=%s llm=%s skip=%s leave_pending_in_band=%s multi_doc=%s",
            len(targets),
            len(for_llm),
            len(for_skip),
            len(leave_pending),
            not explicit_signal_doc,
        )
        if leave_pending:
            log.info(
                "Leaving %s continuation-band pending for next batch (over top_n=%s)",
                len(leave_pending),
                top_n,
            )
        if not targets:
            log.info("No pending tickers")
            _maybe_slack_ai_passed(cfg, log, db, signal_doc_id, dry_run=bool(args.dry_run))
            return 0
        failures = 0
        if not args.dry_run and not args.verify_only:
            for rank, item in enumerate(for_skip, start=len(for_llm) + 1):
                try:
                    write_entry_rank_skipped(
                        ticker=str(item["ticker"]),
                        signal_doc_id=str(item["signal_doc_id"]),
                        rank=rank,
                        top_n=top_n,
                    )
                    log.info(
                        "Entry skip %s doc=%s rank=%s (below top %s, out of continuation band)",
                        item["ticker"],
                        item["signal_doc_id"],
                        rank,
                        top_n,
                    )
                except Exception as e:  # noqa: BLE001
                    log.error("Entry skip write failed %s: %s", item.get("ticker"), e)
                    failures += 1
        elif for_skip:
            log.info("Dry-run/verify: would skip %s out-of-band tickers below top %s", len(for_skip), top_n)
        pace = _inter_request_seconds()
        rate_limited = False
        touched_docs: set[str] = set()
        for i, item in enumerate(for_llm):
            if rate_limited:
                log.warning(
                    "Circuit-break: skip remaining entry LLM calls after rate limit "
                    "(leave %s+ pending for next run)",
                    item.get("ticker"),
                )
                break
            if i > 0 and pace > 0 and not args.verify_only:
                log.info("Pacing %.1fs before next entry LLM call", pace)
                time.sleep(pace)
            doc_id = str(item["signal_doc_id"])
            ticker = str(item["ticker"])
            touched_docs.add(doc_id)
            lottery = bool(item.get("lottery_flag"))
            rc = evaluate_one(
                cfg=cfg,
                log=log,
                ticker=ticker,
                signal_doc_id=doc_id,
                candidate_score=float(item.get("candidate_score") or 0.0),
                candidate_from_firestore=True,
                theme=str(args.theme),
                source_process=str(args.source_process),
                position_id=None,
                owner_uid=None,
                dry_run=bool(args.dry_run),
                debug_prompt=bool(args.debug_prompt),
                stdout_json=bool(args.stdout_json),
                verify_only=bool(args.verify_only),
                github_verify_annotations=bool(args.github_verify_annotations),
                lottery_flag=lottery,
                skip_paper=bool(args.skip_paper),
            )
            if rc == EXIT_RATE_LIMITED:
                rate_limited = True
            elif rc != 0:
                failures += 1
        if not args.verify_only and not args.skip_paper:
            for doc_id in sorted(touched_docs) or [signal_doc_id]:
                _maybe_slack_ai_passed(cfg, log, db, doc_id, dry_run=bool(args.dry_run))
        # Rate-limit alone is soft: pending rows retry on the next cron / workflow_run.
        if failures:
            return 1
        if rate_limited:
            log.warning(
                "Batch finished with OpenAI rate limit; ai_gate left pending (exit 0 soft)"
            )
        return 0

    ticker = str(args.ticker).strip().upper()
    if not ticker:
        log.error("--ticker is required unless --batch")
        return 2

    if args.candidate_score is not None:
        candidate_score = float(args.candidate_score)
        candidate_from_firestore = False
    else:
        candidate_score = read_candidate_score(db, signal_doc_id, ticker)
        candidate_from_firestore = True
    _row_single = read_signal_row(db, signal_doc_id, ticker) or {}
    _lottery_single = bool(_row_single.get("lottery_flag"))

    return evaluate_one(
        cfg=cfg,
        log=log,
        ticker=ticker,
        signal_doc_id=signal_doc_id,
        candidate_score=candidate_score,
        candidate_from_firestore=candidate_from_firestore,
        theme=str(args.theme),
        source_process=str(args.source_process),
        position_id=position_id,
        owner_uid=owner_uid,
        dry_run=bool(args.dry_run),
        debug_prompt=bool(args.debug_prompt),
        stdout_json=bool(args.stdout_json),
        verify_only=bool(args.verify_only),
        github_verify_annotations=bool(args.github_verify_annotations),
        lottery_flag=_lottery_single,
        skip_paper=bool(args.skip_paper),
    )


def _maybe_slack_ai_passed(
    cfg: Any,
    log: logging.Logger,
    db: Any,
    signal_doc_id: str,
    *,
    dry_run: bool,
) -> None:
    """When slack.require_ai_passed, post only ai_gate=passed BUYs after entry batch."""
    slack_cfg = getattr(cfg, "slack", None)
    ai_cfg = getattr(cfg, "ai", None)
    if slack_cfg is None or not bool(getattr(slack_cfg, "enabled", False)):
        return
    if not bool(getattr(slack_cfg, "require_ai_passed", False)):
        return
    if ai_cfg is not None and not bool(getattr(ai_cfg, "enabled", True)):
        return
    if dry_run:
        log.info("Slack AI-passed skipped (dry-run)")
        return
    asof, rows = load_signal_run_rows(db, signal_doc_id)
    try:
        from signals_bot.notifiers.slack import SlackNotifier

        notifier = SlackNotifier.from_env_and_config(channel=str(slack_cfg.channel))
        notifier.post_ai_passed_rows(
            asof_date=asof or "unknown",
            rows=rows,
            top_n=int(getattr(slack_cfg, "post_top_n", 5)),
            min_confidence=int(getattr(slack_cfg, "min_confidence", 70)),
        )
    except Exception as e:  # noqa: BLE001
        log.error("Slack AI-passed post failed: %s", e)


if __name__ == "__main__":
    raise SystemExit(main())
