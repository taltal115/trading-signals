"""Fetch quote, candles, headlines, SPY series."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import finnhub
import numpy as np
import pandas as pd

from signals_bot.config import AppConfig
from signals_bot.providers.stooq import StooqProvider
from signals_bot.providers.yahoo import YahooProvider

MIN_HISTORY_ROWS = 20


@dataclass
class QuoteSnapshot:
    price: float | None
    open: float | None
    previous_close: float | None
    high: float | None
    low: float | None


@dataclass
class NewsItem:
    title: str


@dataclass
class EvalContext:
    ticker: str
    hist: pd.DataFrame
    spy_hist: pd.DataFrame | None
    quote: QuoteSnapshot
    headlines: list[NewsItem]
    events_text: str
    candidate_score: float
    history_provider_ok: dict[str, bool] = field(default_factory=dict)


def _build_providers(cfg: AppConfig) -> dict[str, Any]:
    return {
        "yahoo": YahooProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=cfg.resolve_path(cfg.data.ca_bundle_path).as_posix()
            if cfg.data.ca_bundle_path
            else None,
        ),
        "stooq": StooqProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=cfg.resolve_path(cfg.data.ca_bundle_path).as_posix()
            if cfg.data.ca_bundle_path
            else None,
        ),
    }


def fetch_history_with_provider_flags(
    *,
    ticker: str,
    cfg: AppConfig,
    providers: dict[str, Any],
) -> tuple[pd.DataFrame, dict[str, bool]]:
    """Return chosen history and per-provider flags (True if that provider returned non-empty history)."""
    sym = ticker.strip().upper()
    flags: dict[str, bool] = {name: False for name in providers}
    last_err: Exception | None = None
    for name in cfg.data.provider_order:
        prov = providers.get(name)
        if not prov:
            continue
        try:
            hist = prov.get_history(sym, lookback_days=max(cfg.data.lookback_days, 260))
            ok = hist is not None and not hist.empty
            flags[name] = ok
            if ok:
                return hist, flags
        except Exception as e:  # noqa: BLE001
            flags[name] = False
            last_err = e
            continue
    if last_err:
        raise RuntimeError(f"No market history for {sym}: {last_err}") from last_err
    raise RuntimeError(f"No market history for {sym}")


def fetch_history(
    *,
    ticker: str,
    cfg: AppConfig,
    providers: dict[str, Any],
) -> pd.DataFrame:
    hist, _ = fetch_history_with_provider_flags(ticker=ticker, cfg=cfg, providers=providers)
    return hist


def fetch_spy_hist(cfg: AppConfig, providers: dict[str, Any]) -> pd.DataFrame | None:
    try:
        return fetch_history(ticker="SPY", cfg=cfg, providers=providers)
    except Exception:  # noqa: BLE001
        return None


def finnhub_quote_and_news(ticker: str) -> tuple[QuoteSnapshot, list[NewsItem]]:
    api_key = (os.getenv("FINNHUB_API_KEY") or "").strip()
    sym = ticker.strip().upper()
    if not api_key:
        return QuoteSnapshot(None, None, None, None, None), []

    client = finnhub.Client(api_key=api_key)
    q_raw: dict[str, Any] = {}
    try:
        q_raw = client.quote(sym) or {}
    except Exception:  # noqa: BLE001
        q_raw = {}

    def _f(key: str) -> float | None:
        v = q_raw.get(key)
        if v is None:
            return None
        try:
            x = float(v)
            return x if np.isfinite(x) else None
        except (TypeError, ValueError):
            return None

    quote = QuoteSnapshot(
        price=_f("c"),
        open=_f("o"),
        previous_close=_f("pc"),
        high=_f("h"),
        low=_f("l"),
    )

    headlines: list[NewsItem] = []
    try:
        end_d = datetime.now(timezone.utc).date()
        start_d = end_d - timedelta(days=14)
        raw_news = client.company_news(sym, _from=start_d.isoformat(), to=end_d.isoformat()) or []
        for item in raw_news[:20]:
            if isinstance(item, dict):
                t = item.get("headline") or item.get("title") or ""
                if t:
                    headlines.append(NewsItem(title=str(t)))
    except Exception:  # noqa: BLE001
        pass

    return quote, headlines[:8]


def build_provider_status_dict(
    ctx: EvalContext,
    *,
    candidate_from_firestore: bool,
) -> dict[str, bool]:
    """Booleans for Firestore `ai_evaluation.provider_status`."""
    hist = ctx.hist
    history_ok = (
        hist is not None
        and len(hist) >= MIN_HISTORY_ROWS
        and "close" in hist.columns
    )
    flags = ctx.history_provider_ok
    finnhub_configured = bool((os.getenv("FINNHUB_API_KEY") or "").strip())
    q = ctx.quote
    finnhub_quote_ok = bool(
        finnhub_configured and (q.price is not None or q.previous_close is not None)
    )
    finnhub_news_ok = bool(finnhub_configured and len(ctx.headlines) > 0)
    spy_ok = ctx.spy_hist is not None and len(ctx.spy_hist) >= 21
    firestore_candidate_ok = (not candidate_from_firestore) or (ctx.candidate_score > 0.0)
    return {
        "yahoo_history_ok": bool(flags.get("yahoo", False)),
        "stooq_history_ok": bool(flags.get("stooq", False)),
        "history_ok": history_ok,
        "spy_ok": spy_ok,
        "finnhub_configured": finnhub_configured,
        "finnhub_quote_ok": finnhub_quote_ok,
        "finnhub_news_ok": finnhub_news_ok,
        "firestore_candidate_ok": firestore_candidate_ok,
    }


def build_context(
    *,
    ticker: str,
    cfg: AppConfig,
    candidate_score: float,
) -> EvalContext:
    providers = _build_providers(cfg)
    hist, history_provider_ok = fetch_history_with_provider_flags(
        ticker=ticker, cfg=cfg, providers=providers
    )
    spy = fetch_spy_hist(cfg, providers)
    quote, headlines = finnhub_quote_and_news(ticker)
    return EvalContext(
        ticker=ticker.strip().upper(),
        hist=hist,
        spy_hist=spy,
        quote=quote,
        headlines=headlines,
        events_text="No macro events.",
        candidate_score=float(candidate_score),
        history_provider_ok=history_provider_ok,
    )
