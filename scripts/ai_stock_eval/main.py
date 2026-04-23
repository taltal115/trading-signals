"""CLI: AI stock evaluation pipeline (context → LLM → score → Firestore)."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from signals_bot.config import load_config

from .context import build_context
from .features import build_features_strategy_and_placeholders, render_user_prompt
from .firestore_write import build_payload, read_candidate_score, write_evaluation
from .llm import call_openai_json, normalize_verdict
from .prompts import SYSTEM_PROMPT, USER_PROMPT_TEMPLATE
from .score import compute_total_score


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
    p.add_argument("--config", required=True, help="Path to config.yaml")
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
    args = p.parse_args(argv)

    log = _setup_logging()
    cfg_path = Path(args.config).expanduser().resolve()
    cfg = load_config(cfg_path)
    ticker = str(args.ticker).strip().upper()
    signal_doc_id = str(args.signal_doc_id).strip()
    position_id = str(args.position_id).strip() or None
    owner_uid = str(args.owner_uid).strip() or None

    if args.candidate_score is not None:
        candidate_score = float(args.candidate_score)
    else:
        from signals_bot.storage.firestore import get_firestore_client

        db = get_firestore_client()
        candidate_score = read_candidate_score(db, signal_doc_id, ticker)

    ctx = build_context(ticker=ticker, cfg=cfg, candidate_score=candidate_score)
    feats, strategy_results, best_strategy, placeholders = build_features_strategy_and_placeholders(
        ctx=ctx,
        cfg=cfg,
        theme=str(args.theme),
        source_process=str(args.source_process),
    )
    user_msg = render_user_prompt(USER_PROMPT_TEMPLATE, placeholders)

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

    log.info(
        "AI eval %s total=%.2f conviction=%.2f action=%s source=%s",
        ticker,
        total,
        conviction,
        verdict.get("action"),
        llm_source,
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
