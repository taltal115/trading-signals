"""CLI: AI stock evaluation pipeline (context → LLM → score → Firestore dual-write)."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from signals_bot.config import load_config

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
    latest_signal_doc_id,
    list_pending_tickers,
    read_candidate_score,
    write_entry_evaluation,
)
from .llm import call_openai_json, normalize_verdict
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
    if not log.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        log.addHandler(h)
    log.setLevel(logging.INFO)
    return log


def _ai_pricing(cfg: Any) -> dict[str, dict[str, float]] | None:
    ai = getattr(cfg, "ai", None)
    if ai is None:
        return None
    return getattr(ai, "pricing", None)


def _ai_model(cfg: Any, *, technical_score: float) -> str:
    """Entry gate model: gpt-5.4 by default; gpt-5.4-pro when technical score is high."""
    ai = getattr(cfg, "ai", None)
    if ai is None:
        return "gpt-5.4"
    entry = str(getattr(ai, "entry_model", None) or getattr(ai, "model", None) or "gpt-5.4")
    pro = str(getattr(ai, "pro_model", None) or "gpt-5.4-pro")
    threshold = float(getattr(ai, "pro_min_technical_score", 75.0) or 75.0)
    if technical_score >= threshold and pro:
        return pro
    return entry


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

    technical_for_routing = float(feats.get("technical_score") or candidate_score or 0.0)
    entry_model = _ai_model(cfg, technical_score=technical_for_routing)
    log.info(
        "Entry model for %s: %s (technical_score=%.1f)",
        ticker,
        entry_model,
        technical_for_routing,
    )
    raw_verdict, usage, raw_response_text = call_openai_json(
        system=system_prompt,
        user=user_msg,
        model=entry_model,
        pricing=_ai_pricing(cfg),
    )
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
    ai_cfg = getattr(cfg, "ai", None)
    entry_min_total = float(getattr(ai_cfg, "entry_min_total", 70.0) if ai_cfg else 70.0)
    entry_min_conviction = float(getattr(ai_cfg, "entry_min_conviction", 0.7) if ai_cfg else 0.7)
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
        pending = list_pending_tickers(db, signal_doc_id)
        cap = int(getattr(ai_cfg, "max_entry_evals_per_run", 15) if ai_cfg else 15)
        pending = pending[: max(0, cap)]
        log.info("Batch entry eval doc=%s pending=%s (cap=%s)", signal_doc_id, len(pending), cap)
        if not pending:
            log.info("No pending tickers")
            return 0
        failures = 0
        for ticker, _idx, cand in pending:
            rc = evaluate_one(
                cfg=cfg,
                log=log,
                ticker=ticker,
                signal_doc_id=signal_doc_id,
                candidate_score=cand,
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
            )
            if rc != 0:
                failures += 1
        return 1 if failures else 0

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
    )


if __name__ == "__main__":
    raise SystemExit(main())
