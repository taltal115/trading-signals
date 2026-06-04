"""Tests for deterministic event scoring."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from signals_bot.config import EventsConfig, load_config
from signals_bot.events.scoring import build_recommendations, score_event

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def cfg():
    return load_config(ROOT / "config.yaml")


def test_earnings_high_score_setup(cfg):
    today = date(2026, 6, 4)
    ev = {
        "symbol": "TEST",
        "event_type": "earnings",
        "event_date": "2026-06-08",
        "last_score": 0.85,
        "last_confidence": 90,
        "setup": {
            "ret_5d_pct": 4.0,
            "ret_10d_pct": 8.0,
            "rel_vol": 2.5,
            "rsi14": 55.0,
            "is_breakout": True,
            "price_vs_sma20_pct": 2.0,
            "spy_rel_20d_pct": 8.0,
            "pre_event_extended": False,
        },
        "history": {
            "samples": 6,
            "median_post_5d_pct": 4.0,
            "pct_positive_post_5d": 0.67,
            "median_gap_day_pct": 1.0,
        },
    }
    scored = score_event(ev, cfg=cfg, today=today)
    assert scored["event_score"] >= 70
    assert scored["action"] in ("SETUP", "WATCH")
    assert scored["bias"] in ("bullish", "neutral")
    assert len(scored["reasons"]) >= 1


def test_extended_penalty_avoid_or_watch(cfg):
    today = date(2026, 6, 4)
    ev = {
        "symbol": "EXT",
        "event_type": "earnings",
        "event_date": "2026-06-20",
        "last_score": 0.3,
        "last_confidence": 40,
        "setup": {
            "rel_vol": 0.8,
            "rsi14": 80.0,
            "is_breakout": False,
            "price_vs_sma20_pct": -5.0,
            "spy_rel_20d_pct": -10.0,
            "pre_event_extended": True,
            "ret_5d_pct": 15.0,
            "ret_10d_pct": 25.0,
        },
        "history": {"samples": 2},
    }
    scored = score_event(ev, cfg=cfg, today=today)
    assert scored["event_score"] < 60
    assert scored["action"] in ("WATCH", "AVOID")


def test_build_recommendations_ordering(cfg):
    today = date(2026, 6, 4)
    events = []
    for sym, sc in [("LOW", 50), ("HIGH", 85), ("MID", 72)]:
        events.append(
            score_event(
                {
                    "symbol": sym,
                    "event_type": "earnings",
                    "event_date": "2026-06-10",
                    "last_score": sc / 100.0,
                    "last_confidence": sc,
                    "setup": {
                        "rel_vol": 2.0,
                        "rsi14": 50.0,
                        "is_breakout": True,
                        "price_vs_sma20_pct": 1.0,
                        "pre_event_extended": False,
                    },
                    "history": {"samples": 5, "median_post_5d_pct": 3.0, "pct_positive_post_5d": 0.6},
                },
                cfg=cfg,
                today=today,
            )
        )
    recs = build_recommendations(events, cfg=cfg, today=today)
    assert len(recs) >= 1
    assert recs[0]["symbol"] == "HIGH"
    assert recs[0]["rank"] == 1


def test_ex_dividend_scores(cfg):
    today = date(2026, 6, 4)
    ev = {
        "symbol": "DIV",
        "event_type": "ex_dividend",
        "event_date": "2026-06-12",
        "last_score": 0.7,
        "last_confidence": 75,
        "setup": {
            "rel_vol": 1.2,
            "rsi14": 48.0,
            "is_breakout": False,
            "price_vs_sma20_pct": 1.0,
            "pre_event_extended": False,
        },
        "history": None,
    }
    scored = score_event(ev, cfg=cfg, today=today)
    assert 0 <= scored["event_score"] <= 100
    assert scored["action"] in ("SETUP", "WATCH", "AVOID")
