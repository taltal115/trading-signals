"""OHLC setup metrics and historical earnings reaction for event rows."""

from __future__ import annotations

import logging
import math
import os
import time
from datetime import date, timedelta
from typing import Any

import finnhub
import numpy as np
import pandas as pd

from signals_bot.config import AppConfig
from signals_bot.providers.stooq import StooqProvider
from signals_bot.providers.yahoo import YahooProvider


def _parse_period_date(raw: Any) -> date | None:
    if raw is None:
        return None
    s = str(raw).strip()[:10]
    if len(s) < 10:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def _rsi14(close: pd.Series) -> float:
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.rolling(14).mean()
    avg_loss = loss.rolling(14).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    v = float(rsi.iloc[-1])
    return v if math.isfinite(v) else 50.0


def _compute_setup_from_hist(
    hist: pd.DataFrame,
    *,
    spy_hist: pd.DataFrame | None,
    cfg: AppConfig,
) -> dict[str, Any]:
    df = hist.copy().sort_index()
    close_s = df["close"].astype(float)
    high_s = df["high"].astype(float)
    vol_s = df["volume"].astype(float) if "volume" in df.columns else pd.Series(np.nan, index=df.index)

    last_close = float(close_s.iloc[-1])
    ret_5d = float(close_s.pct_change(5).iloc[-1] * 100.0) if len(close_s) > 5 else 0.0
    ret_10d = float(close_s.pct_change(10).iloc[-1] * 100.0) if len(close_s) > 10 else 0.0

    sma20 = float(close_s.rolling(20).mean().iloc[-1]) if len(close_s) >= 20 else last_close
    price_vs_sma20 = ((last_close / sma20) - 1.0) * 100.0 if sma20 else 0.0

    n = cfg.strategy.breakout_lookback_days
    prior_high = float(high_s.rolling(n).max().shift(1).iloc[-1]) if len(high_s) > n else last_close
    is_breakout = bool(last_close >= prior_high) if prior_high else False

    avg20_vol = float(vol_s.rolling(20).mean().iloc[-1]) if len(vol_s) >= 20 else np.nan
    last_vol = float(vol_s.iloc[-1])
    rel_vol = (last_vol / avg20_vol) if avg20_vol and math.isfinite(avg20_vol) and avg20_vol > 0 else 1.0

    rsi14 = _rsi14(close_s)

    stock_ret_20 = float(close_s.pct_change(20).iloc[-1] * 100.0) if len(close_s) > 21 else 0.0
    spy_rel_20: float | None = None
    if spy_hist is not None and len(spy_hist) > 21:
        spy_close = spy_hist["close"].astype(float)
        spy_ret_20 = float(spy_close.pct_change(20).iloc[-1] * 100.0)
        spy_rel_20 = stock_ret_20 - spy_ret_20

    extended = (
        ret_5d > cfg.events.pre_event_ret_5d_cap_pct
        or ret_10d > cfg.events.pre_event_ret_10d_cap_pct
    )

    return {
        "ret_5d_pct": round(ret_5d, 2),
        "ret_10d_pct": round(ret_10d, 2),
        "rel_vol": round(rel_vol, 2),
        "rsi14": round(rsi14, 1),
        "is_breakout": is_breakout,
        "price_vs_sma20_pct": round(price_vs_sma20, 2),
        "spy_rel_20d_pct": round(spy_rel_20, 2) if spy_rel_20 is not None else None,
        "pre_event_extended": extended,
    }


def _forward_returns_calendar_days(
    hist: pd.DataFrame,
    event_d: date,
    *,
    days_forward: int = 5,
) -> float | None:
    """Sum of daily % returns from first trading day strictly after event_d through N calendar days."""
    if hist.empty:
        return None
    idx_dates = [pd.Timestamp(d).date() if hasattr(d, "year") else d for d in hist.index]
    closes = hist["close"].astype(float).values
    pairs = sorted(zip(idx_dates, closes), key=lambda x: x[0])
    after = [(d, c) for d, c in pairs if d > event_d]
    if len(after) < 2:
        return None
    end_d = event_d + timedelta(days=days_forward)
    window = [(d, c) for d, c in after if d <= end_d]
    if len(window) < 2:
        return None
    start_px = window[0][1]
    end_px = window[-1][1]
    if not start_px or not math.isfinite(start_px):
        return None
    return float((end_px / start_px - 1.0) * 100.0)


def _compute_history(
    *,
    symbol: str,
    hist: pd.DataFrame,
    earnings_periods: list[date],
    upcoming_date: date | None,
) -> dict[str, Any] | None:
    post_returns: list[float] = []
    gap_returns: list[float] = []
    for period_d in earnings_periods:
        if upcoming_date and period_d >= upcoming_date:
            continue
        post = _forward_returns_calendar_days(hist, period_d, days_forward=5)
        if post is not None and math.isfinite(post):
            post_returns.append(post)
        idx_dates = [pd.Timestamp(d).date() if hasattr(d, "year") else d for d in hist.index]
        if period_d in idx_dates:
            i = idx_dates.index(period_d)
            if i > 0:
                prev_c = float(hist["close"].iloc[i - 1])
                day_c = float(hist["close"].iloc[i])
                if prev_c and math.isfinite(prev_c):
                    gap_returns.append((day_c / prev_c - 1.0) * 100.0)

    if not post_returns:
        return {"samples": 0, "median_post_5d_pct": None, "pct_positive_post_5d": None, "median_gap_day_pct": None}

    pos = sum(1 for r in post_returns if r > 0)
    return {
        "samples": len(post_returns),
        "median_post_5d_pct": round(float(np.median(post_returns)), 2),
        "pct_positive_post_5d": round(pos / len(post_returns), 2),
        "median_gap_day_pct": round(float(np.median(gap_returns)), 2) if gap_returns else None,
    }


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
            api_key=cfg.data.stooq_api_key,
        ),
    }


def _fetch_history(
    ticker: str,
    *,
    cfg: AppConfig,
    providers: dict[str, Any],
) -> pd.DataFrame | None:
    sym = ticker.strip().upper()
    lookback = max(cfg.data.lookback_days, 260)
    for name in cfg.data.provider_order:
        prov = providers.get(name)
        if not prov:
            continue
        try:
            hist = prov.get_history(sym, lookback_days=lookback)
            if hist is not None and not hist.empty:
                return hist
        except Exception:  # noqa: BLE001
            continue
    return None


def _finnhub_earnings_periods(
    client: finnhub.Client | None,
    symbol: str,
    *,
    limit: int,
) -> list[date]:
    if client is None:
        return []
    try:
        raw = client.company_earnings(symbol)
    except Exception:  # noqa: BLE001
        return []
    if not isinstance(raw, list):
        return []
    dates: list[date] = []
    for row in raw[:limit]:
        if not isinstance(row, dict):
            continue
        d = _parse_period_date(row.get("period"))
        if d is not None:
            dates.append(d)
    return sorted(set(dates))


def enrich_events(
    events: list[dict[str, Any]],
    *,
    cfg: AppConfig,
    log: logging.Logger,
    finnhub_client: finnhub.Client | None = None,
) -> list[dict[str, Any]]:
    """Attach ``setup`` and ``history`` to each event row (per symbol cache)."""
    if not events:
        return []

    providers = _build_providers(cfg)
    spy_hist = _fetch_history("SPY", cfg=cfg, providers=providers)

    symbols = sorted({str(e.get("symbol", "")).strip().upper() for e in events if e.get("symbol")})
    setup_by_sym: dict[str, dict[str, Any]] = {}
    history_by_sym: dict[str, dict[str, Any] | None] = {}

    api_key = (os.getenv("FINNHUB_API_KEY") or "").strip()
    fh_client = finnhub_client
    if fh_client is None and api_key:
        fh_client = finnhub.Client(api_key=api_key)

    gap = float(cfg.events.finnhub_symbol_gap_sec)

    for i, sym in enumerate(symbols):
        if i > 0 and fh_client is not None:
            time.sleep(gap)
        hist = _fetch_history(sym, cfg=cfg, providers=providers)
        if hist is None or hist.empty:
            log.warning("WAIT %s: no OHLC for enrichment", sym)
            setup_by_sym[sym] = {}
            history_by_sym[sym] = None
            continue
        setup_by_sym[sym] = _compute_setup_from_hist(hist, spy_hist=spy_hist, cfg=cfg)
        periods = _finnhub_earnings_periods(
            fh_client,
            sym,
            limit=cfg.events.history_quarters,
        )
        upcoming = None
        for ev in events:
            if ev.get("symbol") == sym and ev.get("event_type") == "earnings":
                upcoming = _parse_period_date(ev.get("event_date"))
                break
        history_by_sym[sym] = _compute_history(
            symbol=sym,
            hist=hist,
            earnings_periods=periods,
            upcoming_date=upcoming,
        )

    out: list[dict[str, Any]] = []
    for ev in events:
        sym = str(ev.get("symbol", "")).strip().upper()
        row = dict(ev)
        setup = setup_by_sym.get(sym) or {}
        row["setup"] = setup if setup else None
        if ev.get("event_type") == "earnings":
            row["history"] = history_by_sym.get(sym)
        else:
            row["history"] = None
        out.append(row)
    return out
