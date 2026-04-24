"""Feature dict, strategy scores, and user-prompt placeholder values."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

from signals_bot.config import AppConfig
from signals_bot.strategy.breakout import BreakoutMomentumStrategy

from .context import EvalContext


def _fmt2(x: float | None) -> str:
    if x is None or not math.isfinite(float(x)):
        return "0.00"
    return f"{float(x):.2f}"


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


def _macd(close: pd.Series) -> tuple[float, float, float]:
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    signal = macd_line.ewm(span=9, adjust=False).mean()
    hist = macd_line - signal
    return (
        float(macd_line.iloc[-1]),
        float(signal.iloc[-1]),
        float(hist.iloc[-1]),
    )


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def compute_weight_features(
    *,
    ctx: EvalContext,
    cfg: AppConfig,
    sma10: float,
    sma20: float,
    sma50: float,
    sma200: float,
    price_vs_sma20: float,
    price_vs_sma50: float,
    price_vs_sma200: float,
    ma_alignment_score: float,
    trend_direction: float,
    rsi14: float,
    rel_vol: float,
    gap_strength_metric: float,
    stock_ret_20: float,
    spy_ret_20: float | None,
    avg_dollar_vol: float,
    headline_count: int,
    macd_histogram: float,
) -> dict[str, float]:
    """Float features for DEFAULT_WEIGHTS (each should live in a sensible 0–1 band for weighting)."""
    close = float(ctx.hist["close"].iloc[-1])
    ret_1d = float(ctx.hist["close"].pct_change(1).iloc[-1] * 100.0)
    ret_5d = float(ctx.hist["close"].pct_change(5).iloc[-1] * 100.0)
    ret_10d = float(ctx.hist["close"].pct_change(10).iloc[-1] * 100.0)

    price_strength = _clamp01(
        (max(0, ret_5d) / 25.0) * 0.4 + (max(0, ret_10d) / 40.0) * 0.4 + (max(0, ret_1d) / 8.0) * 0.2
    )

    gap_feat = _clamp01(abs(gap_strength_metric) / 100.0)

    if spy_ret_20 is not None:
        diff = stock_ret_20 - spy_ret_20
        relative_strength = _clamp01(0.5 + diff / 40.0)
    else:
        relative_strength = _clamp01(0.5 + max(-20, min(20, ret_10d)) / 40.0)

    rv = rel_vol if math.isfinite(rel_vol) else 1.0
    relative_volume = _clamp01(rv / 3.0)
    volume_strength = _clamp01(math.sqrt(max(0.0, rv)) / math.sqrt(3.0))

    catalyst_strength = _clamp01(headline_count / 6.0) if headline_count else 0.0

    event_timing_score = 0.5

    bull = sum(1 for w in ("beat", "upgrade", "growth", "surge", "win") if any(w in n.title.lower() for n in ctx.headlines))
    bear = sum(1 for w in ("miss", "downgrade", "lawsuit", "sec", "warning") if any(w in n.title.lower() for n in ctx.headlines))
    sentiment_intensity = _clamp01(0.35 + (bull - bear) * 0.1)

    ticker_news_relevance = _clamp01(headline_count / 5.0) if headline_count else 0.0

    thr = float(cfg.strategy.avg_dollar_vol_min)
    liquidity_ok = 1.0 if avg_dollar_vol >= thr else 0.3

    tech_score_100 = _technical_score_100(
        rsi14=rsi14,
        ma_align=ma_alignment_score,
        trend_dir=trend_direction,
        rel_vol=rv,
        macd_histogram=macd_histogram,
    )

    return {
        "price_strength": price_strength,
        "gap_strength": gap_feat,
        "relative_strength": relative_strength,
        "relative_volume": relative_volume,
        "volume_strength": volume_strength,
        "catalyst_strength": catalyst_strength,
        "event_timing_score": event_timing_score,
        "sentiment_intensity": sentiment_intensity,
        "ticker_news_relevance": ticker_news_relevance,
        "liquidity_ok": liquidity_ok,
        "technical_score": float(tech_score_100),
        "price_strength_display": float(price_strength * 100.0),
    }


def _technical_score_100(
    *,
    rsi14: float,
    ma_align: float,
    trend_dir: float,
    rel_vol: float,
    macd_histogram: float,
) -> float:
    """0–100 composite for template and §5 technical_component."""
    rsi_part = 0.0
    if 40 <= rsi14 <= 65:
        rsi_part = 100.0
    elif rsi14 < 40:
        rsi_part = 70.0
    elif rsi14 <= 70:
        rsi_part = 55.0
    else:
        rsi_part = 30.0
    align_part = ma_align * 100.0
    trend_part = 50.0 + trend_dir * 50.0
    vol_part = min(100.0, rel_vol * 35.0) if rel_vol >= 1.0 else rel_vol * 25.0
    macd_part = 80.0 if macd_histogram > 0 else 45.0
    return float(
        max(0.0, min(100.0, rsi_part * 0.25 + align_part * 0.25 + trend_part * 0.2 + vol_part * 0.15 + macd_part * 0.15))
    )


def build_features_strategy_and_placeholders(
    *,
    ctx: EvalContext,
    cfg: AppConfig,
    theme: str,
    source_process: str,
) -> tuple[dict[str, float], dict[str, dict[str, Any]], str, dict[str, str]]:
    df = ctx.hist.copy().sort_index()
    close_s = df["close"].astype(float)
    high_s = df["high"].astype(float)
    low_s = df["low"].astype(float)
    vol_s = df["volume"].astype(float) if "volume" in df.columns else pd.Series(np.nan, index=df.index)

    last_close = float(close_s.iloc[-1])
    prev_close = float(close_s.iloc[-2]) if len(close_s) > 1 else last_close
    last_open = float(df["open"].iloc[-1]) if "open" in df.columns else last_close
    gap_raw_pct = ((last_open - prev_close) / prev_close * 100.0) if prev_close else 0.0
    gap_strength_metric = max(0.0, min(100.0, abs(gap_raw_pct) * 6.0))

    def _sma(n: int) -> float:
        v = float(close_s.rolling(n).mean().iloc[-1])
        return v if math.isfinite(v) else last_close

    sma10, sma20, sma50, sma200 = _sma(10), _sma(20), _sma(50), _sma(200)
    p_vs_20 = ((last_close / sma20) - 1.0) * 100.0 if sma20 else 0.0
    p_vs_50 = ((last_close / sma50) - 1.0) * 100.0 if sma50 else 0.0
    p_vs_200 = ((last_close / sma200) - 1.0) * 100.0 if sma200 else 0.0

    bullish_stack = last_close >= sma20 >= sma50 >= sma200
    bearish_stack = last_close <= sma20 <= sma50 <= sma200
    if bullish_stack:
        ma_align = 1.0
    elif bearish_stack:
        ma_align = 0.0
    else:
        ma_align = 0.5

    if sma20 > sma50 * 1.001:
        trend_dir = 1.0
    elif sma20 < sma50 * 0.999:
        trend_dir = -1.0
    else:
        trend_dir = 0.0

    rsi14 = _rsi14(close_s)
    macd_line, macd_signal_val, macd_histogram = _macd(close_s)

    sma20_s = close_s.rolling(20).mean()
    std20 = close_s.rolling(20).std()
    upper = sma20_s + 2 * std20
    lower = sma20_s - 2 * std20
    u, l, mid = float(upper.iloc[-1]), float(lower.iloc[-1]), float(sma20_s.iloc[-1])
    if u != l and math.isfinite(u) and math.isfinite(l):
        bb_pos = (last_close - l) / (u - l)
    else:
        bb_pos = 0.5
    bb_width = ((u - l) / mid) if mid else 0.0

    support = float(low_s.rolling(20).min().iloc[-1])
    resistance = float(high_s.rolling(20).max().iloc[-1])

    win = min(len(df), 252)
    low_52 = float(low_s.iloc[-win:].min())
    high_52 = float(high_s.iloc[-win:].max())
    if high_52 > low_52:
        pos_52 = (last_close - low_52) / (high_52 - low_52)
    else:
        pos_52 = 0.5

    avg20_vol = float(vol_s.rolling(20).mean().iloc[-1])
    last_vol = float(vol_s.iloc[-1])
    rel_vol = (last_vol / avg20_vol) if avg20_vol and math.isfinite(avg20_vol) and avg20_vol > 0 else 1.0

    stock_ret_20 = float(close_s.pct_change(20).iloc[-1] * 100.0) if len(close_s) > 21 else 0.0
    spy_ret_20: float | None = None
    if ctx.spy_hist is not None and len(ctx.spy_hist) > 21:
        spy_close = ctx.spy_hist["close"].astype(float)
        spy_ret_20 = float(spy_close.pct_change(20).iloc[-1] * 100.0)

    atr14 = float(
        pd.concat(
            [
                (high_s - low_s).abs(),
                (high_s - close_s.shift(1)).abs(),
                (low_s - close_s.shift(1)).abs(),
            ],
            axis=1,
        )
        .max(axis=1)
        .rolling(14)
        .mean()
        .iloc[-1]
    )

    avg_dollar_vol = last_close * avg20_vol if math.isfinite(avg20_vol) else 0.0

    weight_feats = compute_weight_features(
        ctx=ctx,
        cfg=cfg,
        sma10=sma10,
        sma20=sma20,
        sma50=sma50,
        sma200=sma200,
        price_vs_sma20=p_vs_20,
        price_vs_sma50=p_vs_50,
        price_vs_sma200=p_vs_200,
        ma_alignment_score=ma_align,
        trend_direction=trend_dir,
        rsi14=rsi14,
        rel_vol=rel_vol,
        gap_strength_metric=gap_strength_metric,
        stock_ret_20=stock_ret_20,
        spy_ret_20=spy_ret_20,
        avg_dollar_vol=avg_dollar_vol,
        headline_count=len(ctx.headlines),
        macd_histogram=macd_histogram,
    )

    strategy = BreakoutMomentumStrategy(cfg.strategy)
    sig = strategy.generate_signal(
        ticker=ctx.ticker,
        hist=df,
        asof_date=cfg.asof_date(),
        data_provider="ai_eval",
        open_buy=None,
    )
    strat_score = float(sig.score) if sig is not None else 0.0
    strategy_results: dict[str, dict[str, Any]] = {"breakout_momentum": {"score": strat_score}}
    best_strategy = "breakout_momentum"
    strategy_score_display = _fmt2(strat_score * 100.0)

    q = ctx.quote
    price = q.price if q.price is not None and math.isfinite(q.price) else last_close
    open_px = q.open if q.open is not None and math.isfinite(q.open) else last_open
    prev_c = q.previous_close if q.previous_close is not None and math.isfinite(q.previous_close) else prev_close
    pct_change = ((price - prev_c) / prev_c * 100.0) if prev_c else 0.0

    rs_vs_spy_str = _fmt2((stock_ret_20 - spy_ret_20) if spy_ret_20 is not None else stock_ret_20)

    headlines_block = (
        "\n".join(f"- {h.title}" for h in ctx.headlines[:8])
        if ctx.headlines
        else "No headlines available."
    )

    cand = ctx.candidate_score
    cand_str = f"{cand:.1f}" if math.isfinite(cand) else "0.0"

    placeholders: dict[str, str] = {
        "ticker": ctx.ticker,
        "theme": theme,
        "source_process": source_process,
        "candidate_score": cand_str,
        "price": _fmt2(price),
        "open_price": _fmt2(open_px),
        "previous_close": _fmt2(prev_c),
        "percent_change": _fmt2(pct_change),
        "gap_pct": _fmt2(gap_strength_metric),
        "relative_strength_pct": rs_vs_spy_str,
        "sma_10": _fmt2(sma10),
        "sma_20": _fmt2(sma20),
        "sma_50": _fmt2(sma50),
        "sma_200": _fmt2(sma200),
        "price_vs_sma20": _fmt2(p_vs_20),
        "price_vs_sma50": _fmt2(p_vs_50),
        "price_vs_sma200": _fmt2(p_vs_200),
        "ma_alignment_score": _fmt2(ma_align),
        "trend_direction": _fmt2(trend_dir),
        "rsi_14": _fmt2(rsi14),
        "atr_14": _fmt2(atr14),
        "macd_line": _fmt2(macd_line),
        "macd_signal_val": _fmt2(macd_signal_val),
        "macd_histogram": _fmt2(macd_histogram),
        "bb_position": _fmt2(bb_pos),
        "bb_width": _fmt2(bb_width),
        "support": _fmt2(support),
        "resistance": _fmt2(resistance),
        "position_in_52w_range": _fmt2(pos_52),
        "volume": str(int(last_vol)) if math.isfinite(last_vol) else "0",
        "avg_volume_20d": str(int(avg20_vol)) if math.isfinite(avg20_vol) else "0",
        "relative_volume": _fmt2(rel_vol),
        "technical_score": _fmt2(weight_feats["technical_score"]),
        "deterministic_score": _fmt2(weight_feats["price_strength_display"]),
        "strategy_score": strategy_score_display,
        "best_strategy": best_strategy,
        "headlines": headlines_block,
        "events": ctx.events_text,
    }

    features_for_score = {k: weight_feats[k] for k in weight_feats if k != "price_strength_display"}

    return features_for_score, strategy_results, best_strategy, placeholders


def render_user_prompt(template: str, placeholders: dict[str, str]) -> str:
    out = template
    for k, v in placeholders.items():
        out = out.replace("{{" + k + "}}", v)
    return out
