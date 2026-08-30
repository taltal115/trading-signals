"""Tests for the 2026-08 signal-quality bug fixes.

Run: PYTHONPATH=./src:. python -m pytest scripts/test_signal_fixes.py -q
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import pytest

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))
sys.path.insert(0, str(ROOT_DIR))

from scripts.ai_stock_eval.llm import normalize_verdict
from scripts.ai_stock_eval.recommendation import build_recommendation, resolve_ai_gate


# ---------------------------------------------------------------------------
# llm.normalize_verdict — conviction scale handling
# ---------------------------------------------------------------------------

def test_conviction_fraction_passthrough() -> None:
    assert normalize_verdict({"conviction": 0.72})["conviction"] == pytest.approx(0.72)


def test_conviction_percent_scale_rescaled() -> None:
    # A 0-100 style answer must not clamp to 1.0 (that auto-passed the gate).
    assert normalize_verdict({"conviction": 70})["conviction"] == pytest.approx(0.70)
    assert normalize_verdict({"conviction": 45})["conviction"] == pytest.approx(0.45)


def test_conviction_slightly_above_one_clamps() -> None:
    assert normalize_verdict({"conviction": 1.2})["conviction"] == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# recommendation — primary target selection and long-only gate
# ---------------------------------------------------------------------------

def _reco_with_targets(targets: list[dict]) -> dict:
    verdict = {
        "action": "BUY",
        "conviction": 0.8,
        "direction": "long",
        "targets": targets,
        "entry_zone": {"ideal_price": 10.0, "min_price": 9.5, "max_price": 10.5},
        "stop_loss": 9.0,
    }
    return build_recommendation(
        verdict=verdict,
        scores={"total": 80.0, "breakdown": {"ai_component": 12.8}},
        technical_score=70.0,
    )


def test_primary_target_prefers_t1_even_when_t2_listed_first() -> None:
    reco = _reco_with_targets(
        [{"label": "T2", "price": 14.0}, {"label": "T1", "price": 12.0}]
    )
    assert reco["plan"]["target"] == pytest.approx(12.0)


def test_primary_target_falls_back_to_first_positive() -> None:
    reco = _reco_with_targets([{"label": "", "price": 0.0}, {"label": "", "price": 11.0}])
    assert reco["plan"]["target"] == pytest.approx(11.0)


def test_short_direction_never_passes_gate() -> None:
    verdict = {
        "action": "BUY",
        "conviction": 0.9,
        "direction": "short",
        "targets": [],
    }
    reco = build_recommendation(
        verdict=verdict,
        scores={"total": 95.0, "breakdown": {}},
        technical_score=80.0,
    )
    gate = resolve_ai_gate(
        recommendation=reco,
        conviction=0.9,
        entry_min_total=70.0,
        entry_min_conviction=0.7,
    )
    assert gate == "filtered"


def test_long_direction_passes_gate_when_thresholds_met() -> None:
    verdict = {"action": "BUY", "conviction": 0.9, "direction": "long", "targets": []}
    reco = build_recommendation(
        verdict=verdict,
        scores={"total": 95.0, "breakdown": {}},
        technical_score=80.0,
    )
    gate = resolve_ai_gate(
        recommendation=reco,
        conviction=0.9,
        entry_min_total=70.0,
        entry_min_conviction=0.7,
    )
    assert gate == "passed"


# ---------------------------------------------------------------------------
# features — gap placeholder and word-boundary sentiment
# ---------------------------------------------------------------------------

def _make_hist(days: int = 260, base: float = 10.0) -> pd.DataFrame:
    idx = pd.bdate_range(end="2026-08-28", periods=days)
    close = pd.Series(np.linspace(base, base * 1.5, days), index=idx)
    df = pd.DataFrame(
        {
            "open": close * 0.99,
            "high": close * 1.02,
            "low": close * 0.98,
            "close": close,
            "volume": np.full(days, 1_000_000.0),
        }
    )
    return df


def test_gap_placeholder_is_raw_percent_not_scaled_feature() -> None:
    from scripts.ai_stock_eval.context import EvalContext, NewsItem, QuoteSnapshot
    from scripts.ai_stock_eval.features import build_features_strategy_and_placeholders
    from signals_bot.config import load_config

    cfg = load_config(ROOT_DIR / "config.yaml")
    hist = _make_hist()
    # Force a known 2% gap on the last bar: open = prev_close * 1.02.
    prev_close = float(hist["close"].iloc[-2])
    hist.iloc[-1, hist.columns.get_loc("open")] = prev_close * 1.02

    ctx = EvalContext(
        ticker="TEST",
        hist=hist,
        spy_hist=None,
        quote=QuoteSnapshot(price=None, open=None, previous_close=None, high=None, low=None),
        headlines=[NewsItem(title="Company beats estimates")],
        events_text="",
        candidate_score=80.0,
    )
    _feats, _strat, _best, placeholders = build_features_strategy_and_placeholders(
        ctx=ctx, cfg=cfg, theme="", source_process="test"
    )
    assert placeholders["gap_pct"] == "2.00"  # was "12.00" (abs(gap)*6) before the fix


def test_sentiment_sec_substring_no_false_positive() -> None:
    from scripts.ai_stock_eval.context import EvalContext, NewsItem, QuoteSnapshot
    from scripts.ai_stock_eval.features import build_features_strategy_and_placeholders
    from signals_bot.config import load_config

    cfg = load_config(ROOT_DIR / "config.yaml")
    hist = _make_hist()

    def _sentiment(titles: list[str]) -> float:
        ctx = EvalContext(
            ticker="TEST",
            hist=hist,
            spy_hist=None,
            quote=QuoteSnapshot(price=None, open=None, previous_close=None, high=None, low=None),
            headlines=[NewsItem(title=t) for t in titles],
            events_text="",
            candidate_score=80.0,
        )
        feats, _s, _b, _p = build_features_strategy_and_placeholders(
            ctx=ctx, cfg=cfg, theme="", source_process="test"
        )
        return feats["sentiment_intensity"]

    neutral = _sentiment(["Tech sector second-quarter securities update"])
    bearish = _sentiment(["SEC opens probe into company"])
    assert neutral == pytest.approx(0.35)  # "sector"/"second"/"securities" are not "sec"
    assert bearish < neutral


# ---------------------------------------------------------------------------
# research_open_signals — no premature "time" finalization
# ---------------------------------------------------------------------------

def _fwd_hist(dates: list[str], closes: list[float]) -> pd.DataFrame:
    idx = pd.to_datetime(dates)
    c = pd.Series(closes, index=idx)
    return pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c})


def test_finalizer_waits_for_deadline_bar() -> None:
    from scripts.research_open_signals import _simulate_outcome

    # asof Mon 8/24, deadline Fri 8/28 — but bars only through Thu 8/27 (pre-open run).
    hist = _fwd_hist(
        ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27"],
        [10.0, 10.2, 10.4, 10.6],
    )
    out = _simulate_outcome(
        entry_price=10.0, stop=8.0, target=99.0,
        hist=hist, asof=date(2026, 8, 24), deadline=date(2026, 8, 28),
    )
    assert out is None  # must retry once the deadline bar exists


def test_finalizer_time_exit_on_deadline_bar() -> None:
    from scripts.research_open_signals import _simulate_outcome

    hist = _fwd_hist(
        ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"],
        [10.0, 10.2, 10.4, 10.6, 10.8],
    )
    out = _simulate_outcome(
        entry_price=10.0, stop=8.0, target=99.0,
        hist=hist, asof=date(2026, 8, 24), deadline=date(2026, 8, 28),
    )
    assert out is not None and out["outcome"] == "time"
    assert out["exit_date"] == date(2026, 8, 28)


def test_finalizer_stop_hit_still_finalizes_early() -> None:
    from scripts.research_open_signals import _simulate_outcome

    hist = _fwd_hist(["2026-08-25", "2026-08-26"], [10.0, 7.5])
    out = _simulate_outcome(
        entry_price=10.0, stop=8.0, target=99.0,
        hist=hist, asof=date(2026, 8, 24), deadline=date(2026, 8, 28),
    )
    assert out is not None and out["outcome"] == "stop"


# ---------------------------------------------------------------------------
# backtest_buy_signals — incomplete window is no_data, not a "time" win
# ---------------------------------------------------------------------------

def test_backtest_incomplete_window_is_no_data() -> None:
    from scripts.backtest_buy_signals import _simulate

    buy = {
        "asof_date": "2026-08-24",
        "ticker": "TEST",
        "confidence": 90,
        "close": 10.0,
        "suggested_entry": 10.0,
        "suggested_stop": 8.0,
        "suggested_target": 99.0,
        "max_hold_days": 5,
        "ret_5d_pct": None,
        "ret_10d_pct": None,
        "vol_ratio": None,
        "atr_pct": None,
        "breakout_dist_pct": None,
    }
    hist = _fwd_hist(
        ["2026-08-25", "2026-08-26", "2026-08-27"], [11.0, 11.5, 12.0]
    )
    res = _simulate(buy, hist)
    assert res.outcome == "no_data"  # only 3 of 5 sessions available


# ---------------------------------------------------------------------------
# monitor — plan-due before trailing_min still applies the trailing ride test
# ---------------------------------------------------------------------------

def test_monitor_trailing_extends_short_plan_hold() -> None:
    from datetime import datetime, timezone

    from scripts.monitor_open_positions import _eval_position

    # Paper position opened 2 sessions ago with an ATR plan of 2 days, profitable,
    # holding above prior session low → live strategy would keep riding, so the
    # monitor must not fire DURATION_DUE.
    data = {
        "ticker": "TEST",
        "entry_price": 10.0,
        "stop_price": 9.0,
        "target_price": 20.0,
        "hold_days_from_signal": 2,
        "created_at_utc": "2026-08-25T13:00:00+00:00",
    }
    alert = _eval_position(
        data=data,
        last_close=11.0,
        session_high=11.2,
        session_low=10.8,
        atr14=None,
        now_utc=datetime(2026, 8, 27, 21, 0, tzinfo=timezone.utc),
        market_tz=ZoneInfo("America/New_York"),
        prior_session_low=10.5,
        trailing_min_hold_days=3,
        max_hold_days=5,
    )
    assert alert.kind != "DURATION_DUE"


def test_monitor_duration_due_at_max_hold_ceiling() -> None:
    from datetime import datetime, timezone

    from scripts.monitor_open_positions import _eval_position

    data = {
        "ticker": "TEST",
        "entry_price": 10.0,
        "stop_price": 9.0,
        "target_price": 20.0,
        "hold_days_from_signal": 2,
        "created_at_utc": "2026-08-14T13:00:00+00:00",
    }
    alert = _eval_position(
        data=data,
        last_close=11.0,
        session_high=11.2,
        session_low=10.8,
        atr14=None,
        now_utc=datetime(2026, 8, 27, 21, 0, tzinfo=timezone.utc),
        market_tz=ZoneInfo("America/New_York"),
        prior_session_low=10.5,
        trailing_min_hold_days=3,
        max_hold_days=5,
    )
    assert alert.kind == "DURATION_DUE"
