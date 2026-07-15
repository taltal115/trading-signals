"""Checks that AI eval context and rendered prompt have usable data from each provider."""

from __future__ import annotations

import os

from .context import EvalContext, MIN_HISTORY_ROWS


def verify_eval_context(
    *,
    ctx: EvalContext,
    placeholders: dict[str, str],
    candidate_from_firestore: bool,
) -> tuple[list[str], list[str]]:
    """
    Returns (errors, warnings). Errors should fail CI; warnings are informational.

    Services: Yahoo/Stooq (history), Finnhub (quote/news), NewsAPI/GDELT (headlines),
    FRED (macro events), Firestore (candidate score), SPY series (relative strength).
    """
    errors: list[str] = []
    warnings: list[str] = []

    hist = ctx.hist
    if hist is None or len(hist) < MIN_HISTORY_ROWS:
        errors.append(
            f"Price history too short ({len(hist) if hist is not None else 0} rows; need >= {MIN_HISTORY_ROWS}). "
            "Check Yahoo/Stooq in config.yaml provider_order and network."
        )

    if hist is not None and "close" not in hist.columns:
        errors.append("Price history missing 'close' column.")

    if ctx.spy_hist is None or len(ctx.spy_hist) < 21:
        warnings.append(
            "SPY benchmark series missing or short; relative strength vs SPY in the prompt may be approximate."
        )

    finnhub = bool((os.getenv("FINNHUB_API_KEY") or "").strip())
    if finnhub:
        if ctx.quote.price is None and ctx.quote.previous_close is None:
            warnings.append("Finnhub: no quote fields returned (check symbol / API limits). Using bar close for price in prompt.")
        if not ctx.headlines:
            warnings.append(
                "No headlines from Finnhub/NewsAPI/GDELT for lookback window "
                "(check FINNHUB_API_KEY / NEWSAPI_API_KEY or USE_* flags)."
            )
    else:
        warnings.append(
            "FINNHUB_API_KEY not set; quote uses OHLC history only. "
            "News may still come from NewsAPI/GDELT if configured."
        )

    if candidate_from_firestore and ctx.candidate_score <= 0.0:
        warnings.append(
            "Candidate score from Firestore is 0 — verify signals doc has this ticker row with a non-zero score, "
            "or pass --candidate-score for testing."
        )

    hl = placeholders.get("headlines", "")
    if "No headlines available." in hl:
        warnings.append("Prompt headlines section has no items (all news providers empty or disabled).")

    events = placeholders.get("events", "").strip()
    if events in ("", "No macro events."):
        if (os.getenv("FRED_API_KEY") or "").strip():
            warnings.append("FRED_API_KEY set but macro {{events}} is empty (check USE_FRED / API).")
        # else: expected when FRED is not configured

    return errors, warnings


def format_github_annotation(level: str, message: str) -> str:
    """level: 'error' | 'warning' | 'notice' for GitHub Actions log commands."""
    msg = message.replace("\n", " ").strip()
    return f"::{level}::{msg}"
