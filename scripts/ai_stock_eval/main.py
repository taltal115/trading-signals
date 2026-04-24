"""CLI: AI stock evaluation pipeline (context → LLM → score → Firestore)."""

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

from .context import build_context
from .features import build_features_strategy_and_placeholders, render_user_prompt
from .firestore_write import build_payload, read_candidate_score, write_evaluation
from .llm import call_openai_json, normalize_verdict
from .prompts import SYSTEM_PROMPT, USER_PROMPT_TEMPLATE
from .score import compute_total_score
from .verify_context import format_github_annotation, verify_eval_context


def _short_reason(verdict: dict[str, Any]) -> str:
    s = str(verdict.get("summary") or "").strip()
    w = str(verdict.get("why_now") or "").strip()
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


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="AI-assisted stock evaluation (signal-only).")
    p.add_argument(
        "--config",
        default="config.yaml",
        help="Path to config.yaml (default: config.yaml at repo root)",
    )
    p.add_argument("--ticker", required=True, help="Ticker symbol")
    p.add_argument("--signal-doc-id", required=True, help="Firestore signals document id")
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
    ticker = str(args.ticker).strip().upper()
    signal_doc_id = str(args.signal_doc_id).strip()
    position_id = str(args.position_id).strip() or None
    owner_uid = str(args.owner_uid).strip() or None

    if args.candidate_score is not None:
        candidate_score = float(args.candidate_score)
        candidate_from_firestore = False
    else:
        from signals_bot.storage.firestore import get_firestore_client

        db = get_firestore_client()
        candidate_score = read_candidate_score(db, signal_doc_id, ticker)
        candidate_from_firestore = True

    ctx = build_context(ticker=ticker, cfg=cfg, candidate_score=candidate_score)
    feats, strategy_results, best_strategy, placeholders = build_features_strategy_and_placeholders(
        ctx=ctx,
        cfg=cfg,
        theme=str(args.theme),
        source_process=str(args.source_process),
    )
    strat_score = float(strategy_results.get(best_strategy, {}).get("score", 0.0))
    user_msg = render_user_prompt(USER_PROMPT_TEMPLATE, placeholders)

    verr, vwarn = verify_eval_context(
        ctx=ctx,
        placeholders=placeholders,
        candidate_from_firestore=candidate_from_firestore,
    )
    log.info("[VERIFY] Context check for %s (history rows=%d)", ticker, len(ctx.hist))
    for w in vwarn:
        if args.github_verify_annotations:
            print(format_github_annotation("warning", w), flush=True)
        log.warning("[VERIFY] %s", w)
    for e in verr:
        if args.github_verify_annotations:
            print(format_github_annotation("error", e), flush=True)
        log.error("[VERIFY] %s", e)

    if args.verify_only:
        return 1 if verr else 0

    if verr:
        log.error("Context verification failed; fix errors above or use --verify-only to debug.")
        return 1

    if args.debug_prompt:
        print("========== AI EVAL DEBUG: SYSTEM PROMPT ==========", flush=True)
        print(SYSTEM_PROMPT, flush=True)
        print("========== AI EVAL DEBUG: USER PROMPT ==========", flush=True)
        print(user_msg, flush=True)
        print("========== END DEBUG PROMPTS ==========", flush=True)

    raw_verdict, llm_source = call_openai_json(system=SYSTEM_PROMPT, user=user_msg)
    verdict = normalize_verdict(raw_verdict)
    conviction = float(verdict["conviction"])

    total, breakdown = compute_total_score(
        features=feats,
        strategy_results=strategy_results,
        best_strategy=best_strategy,
        conviction=conviction,
    )

    payload = build_payload(
        ticker=ticker,
        signal_doc_id=signal_doc_id,
        total=total,
        conviction=conviction,
        verdict=verdict,
        breakdown=breakdown,
        source=llm_source,
    )

    ai_pts = float(breakdown.get("ai_component", 0.0))
    log.info(
        "AI eval %s signal_score=%.2f strategy=%s breakout_0_1=%.4f blended_total=%.2f "
        "llm_conviction=%.2f ai_layer_pts=%.2f action=%s source=%s | %s",
        ticker,
        candidate_score,
        best_strategy,
        strat_score,
        total,
        conviction,
        ai_pts,
        verdict.get("action"),
        llm_source,
        _short_reason(verdict),
    )

    if args.stdout_json:
        print(json.dumps(payload, indent=2, default=str))

    if args.dry_run:
        return 0

    write_evaluation(
        ticker=ticker,
        signal_doc_id=signal_doc_id,
        position_id=position_id,
        owner_uid=owner_uid,
        payload=payload,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
