"""Deterministic event_score, bias, action, and top recommendations."""

from __future__ import annotations

from datetime import date
from typing import Any

from signals_bot.config import AppConfig


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _days_until(event_date_str: str, today: date) -> int | None:
    try:
        ed = date.fromisoformat(str(event_date_str).strip()[:10])
        return (ed - today).days
    except ValueError:
        return None


def _score_earnings(ev: dict[str, Any], *, cfg: AppConfig, today: date) -> tuple[int, str, str, list[str]]:
    setup = ev.get("setup") or {}
    history = ev.get("history") or {}
    reasons: list[str] = []

    last_score = float(ev.get("last_score") or 0.0)
    last_conf = ev.get("last_confidence")
    conf_f = float(last_conf) / 100.0 if last_conf is not None else last_score
    universe_pts = 20.0 * _clamp01(last_score * 0.6 + conf_f * 0.4)
    if last_score >= 0.5:
        reasons.append(f"Universe momentum score {last_score:.2f}")

    rel_vol = float(setup.get("rel_vol") or 1.0)
    rsi = float(setup.get("rsi14") or 50.0)
    is_breakout = bool(setup.get("is_breakout"))
    price_vs_sma20 = float(setup.get("price_vs_sma20_pct") or 0.0)
    tech = 0.0
    if is_breakout:
        tech += 8.0
        reasons.append("At/near breakout")
    if rel_vol >= cfg.events.vol_ratio_min:
        tech += 8.0
        reasons.append(f"Relative volume {rel_vol:.1f}x")
    if 40 <= rsi <= 65:
        tech += 5.0
    elif rsi > 75:
        tech += 1.0
        reasons.append("RSI extended (>75)")
    else:
        tech += 3.0
    if price_vs_sma20 >= 0:
        tech += 4.0
    technical_pts = min(25.0, tech)

    spy_rel = setup.get("spy_rel_20d_pct")
    if spy_rel is not None:
        rs_pts = 15.0 * _clamp01(0.5 + float(spy_rel) / 30.0)
        if float(spy_rel) > 5:
            reasons.append(f"Outperforming SPY 20d by {float(spy_rel):.1f}%")
    else:
        rs_pts = 7.5

    days = _days_until(str(ev.get("event_date", "")), today)
    if days is None:
        timing_pts = 5.0
    elif 2 <= days <= 7:
        timing_pts = 10.0
        reasons.append(f"Earnings in {days} days (sweet spot)")
    elif days <= 1:
        timing_pts = 6.0
    elif days <= 14:
        timing_pts = 7.0
    else:
        timing_pts = 4.0

    extended = bool(setup.get("pre_event_extended"))
    if extended:
        ext_pts = 3.0
        reasons.append("Pre-event extension (5d/10d run-up)")
    else:
        ext_pts = 15.0

    samples = int(history.get("samples") or 0)
    if samples >= 4:
        med_post = history.get("median_post_5d_pct")
        pct_pos = history.get("pct_positive_post_5d")
        hist_score = 0.0
        if med_post is not None:
            hist_score += 8.0 * _clamp01(0.5 + float(med_post) / 15.0)
        if pct_pos is not None:
            hist_score += 7.0 * float(pct_pos)
        hist_pts = min(15.0, hist_score)
        if med_post is not None and float(med_post) > 0:
            reasons.append(f"Hist median +5d post-earnings {float(med_post):.1f}%")
    else:
        hist_pts = 7.0

    total = int(round(universe_pts + technical_pts + rs_pts + timing_pts + ext_pts + hist_pts))
    total = max(0, min(100, total))

    bias = "bullish" if total >= 65 else "bearish" if total < 45 else "neutral"
    action = _action_from_score(total, cfg, extended=extended, samples=samples)
    return total, bias, action, reasons[:6]


def _score_dividend_type(ev: dict[str, Any], *, cfg: AppConfig, today: date) -> tuple[int, str, str, list[str]]:
    setup = ev.get("setup") or {}
    reasons: list[str] = []

    last_score = float(ev.get("last_score") or 0.0)
    last_conf = ev.get("last_confidence")
    conf_f = float(last_conf) / 100.0 if last_conf is not None else last_score
    universe_pts = 30.0 * _clamp01(last_score * 0.6 + conf_f * 0.4)

    rel_vol = float(setup.get("rel_vol") or 1.0)
    price_vs_sma20 = float(setup.get("price_vs_sma20_pct") or 0.0)
    tech = 0.0
    if rel_vol >= 1.0:
        tech += 12.0
    if price_vs_sma20 >= 0:
        tech += 13.0
        reasons.append("Price above SMA20")
    technical_pts = min(25.0, tech)

    days = _days_until(str(ev.get("event_date", "")), today)
    if days is None:
        timing_pts = 7.0
    elif 1 <= days <= 10:
        timing_pts = 15.0
    else:
        timing_pts = 8.0

    extended = bool(setup.get("pre_event_extended"))
    ext_pts = 3.0 if extended else 15.0
    if extended:
        reasons.append("Extended into ex-date")

    div_pts = 7.5
    reasons.append("Dividend/ex-div: lighter model (no earnings history)")

    total = int(round(universe_pts + technical_pts + timing_pts + ext_pts + div_pts))
    total = max(0, min(100, total))
    bias = "bullish" if total >= 60 else "bearish" if total < 42 else "neutral"
    action = _action_from_score(total, cfg, extended=extended, samples=0)
    return total, bias, action, reasons[:6]


def _action_from_score(score: int, cfg: AppConfig, *, extended: bool, samples: int) -> str:
    if score >= cfg.events.setup_min_score and not extended:
        if samples == 0 or samples >= 4:
            return "SETUP"
    if score >= cfg.events.watch_min_score:
        return "WATCH"
    return "AVOID"


def score_event(ev: dict[str, Any], *, cfg: AppConfig, today: date | None = None) -> dict[str, Any]:
    """Return event dict with event_score, bias, action, reasons."""
    row = dict(ev)
    asof = today or cfg.asof_date()
    event_type = str(row.get("event_type") or "").lower()

    if event_type == "earnings":
        score, bias, action, reasons = _score_earnings(row, cfg=cfg, today=asof)
    else:
        score, bias, action, reasons = _score_dividend_type(row, cfg=cfg, today=asof)

    row["event_score"] = score
    row["bias"] = bias
    row["action"] = action
    row["reasons"] = reasons
    return row


def build_recommendations(
    events: list[dict[str, Any]],
    *,
    cfg: AppConfig,
    today: date | None = None,
) -> list[dict[str, Any]]:
    """Top-N recommendation cards for the Firestore document."""
    asof = today or cfg.asof_date()
    min_score = cfg.events.min_recommendation_score
    top_n = cfg.events.recommendations_top_n

    candidates = [e for e in events if int(e.get("event_score") or 0) >= min_score]

    def sort_key(e: dict[str, Any]) -> tuple[int, int, str]:
        sc = -int(e.get("event_score") or 0)
        days = _days_until(str(e.get("event_date", "")), asof)
        d = days if days is not None else 999
        return (sc, d, str(e.get("symbol", "")))

    candidates.sort(key=sort_key)
    picked = candidates[:top_n]

    recs: list[dict[str, Any]] = []
    for rank, ev in enumerate(picked, start=1):
        reasons = list(ev.get("reasons") or [])[:4]
        summary = "; ".join(reasons[:2]) if reasons else f"{ev.get('event_type')} on {ev.get('event_date')}"
        if len(summary) > 200:
            summary = summary[:197] + "…"
        recs.append(
            {
                "rank": rank,
                "symbol": ev.get("symbol"),
                "event_type": ev.get("event_type"),
                "event_date": ev.get("event_date"),
                "action": ev.get("action"),
                "bias": ev.get("bias"),
                "event_score": ev.get("event_score"),
                "summary": summary,
                "reasons": reasons,
            }
        )
    return recs
