from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Literal

import numpy as np
import pandas as pd

from signals_bot.config import StrategyConfig
from signals_bot.trading_calendar import nyse_session_dates_between_exclusive_start


SignalAction = Literal["BUY", "WAIT", "SELL"]


@dataclass(frozen=True)
class OpenBuy:
    ticker: str
    buy_asof_date: date
    entry: float
    stop: float | None


@dataclass(frozen=True)
class Signal:
    ticker: str
    action: SignalAction
    confidence: int
    score: float
    close: float
    suggested_entry: float | None
    suggested_stop: float | None
    suggested_target: float | None
    max_hold_days: int
    data_provider: str
    notes: str
    metrics: dict[str, float | None]


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def _atr14(df: pd.DataFrame) -> pd.Series:
    high = df["high"]
    low = df["low"]
    close = df["close"]
    prev_close = close.shift(1)
    tr = pd.concat([(high - low).abs(), (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)
    return tr.rolling(14).mean()


class BreakoutMomentumStrategy:
    def __init__(self, cfg: StrategyConfig) -> None:
        self.cfg = cfg

    def generate_signal(
        self,
        *,
        ticker: str,
        hist: pd.DataFrame,
        asof_date: date,
        data_provider: str,
        open_buy: OpenBuy | None,
    ) -> Signal | None:
        df = hist.copy().sort_index()
        needed = max(self.cfg.breakout_lookback_days + 5, 40)
        if len(df) < needed:
            return None

        close = float(df["close"].iloc[-1])
        vol = float(df["volume"].iloc[-1]) if "volume" in df.columns else np.nan

        # Rolling stats.
        avg20_vol = float(df["volume"].rolling(20).mean().iloc[-1]) if "volume" in df.columns else np.nan
        vol_ratio = float(vol / avg20_vol) if avg20_vol and not np.isnan(avg20_vol) else np.nan

        ret_1d = float(df["close"].pct_change(1).iloc[-1] * 100.0)
        ret_5d = float(df["close"].pct_change(5).iloc[-1] * 100.0)
        ret_10d = float(df["close"].pct_change(10).iloc[-1] * 100.0)

        atr14 = float(_atr14(df).iloc[-1])
        atr_pct = float((atr14 / close) * 100.0) if close else np.nan

        n = self.cfg.breakout_lookback_days
        prior_high_n = float(df["high"].rolling(n).max().shift(1).iloc[-1])
        breakout_dist_pct = float(((prior_high_n - close) / prior_high_n) * 100.0) if prior_high_n else np.nan
        is_breakout = bool(close >= prior_high_n) if prior_high_n else False

        # High-volume fresh breakout: at/above the N-day high with volume confirming continuation
        # (STAK 2026-06-03: 13% ATR, 5.4x volume). Used both to relax the ATR ceiling below and to
        # bypass the overextension caps further down.
        high_volume_breakout = (
            is_breakout
            and self.cfg.overextension_bypass_vol_ratio > 0
            and not np.isnan(vol_ratio)
            and vol_ratio >= self.cfg.overextension_bypass_vol_ratio
        )

        # Baseline filters (for new ideas; we still manage open buys even if they drift).
        avg_dollar_vol = float(close * avg20_vol) if avg20_vol and not np.isnan(avg20_vol) else np.nan
        passes_price = self.cfg.price_min <= close <= self.cfg.price_max
        passes_dollar_vol = (
            avg_dollar_vol >= self.cfg.avg_dollar_vol_min if not np.isnan(avg_dollar_vol) else False
        )
        passes_standard_atr = (
            self.cfg.atr_pct_min <= atr_pct <= self.cfg.atr_pct_max if not np.isnan(atr_pct) else False
        )
        # Higher ATR ceiling for high-volume fresh breakouts (reuses the ignition ceiling —
        # both represent "volatility is acceptable because volume confirms the move").
        passes_high_vol_atr = (
            self.cfg.atr_pct_min <= atr_pct <= self.cfg.ignite_atr_pct_max
            if not np.isnan(atr_pct)
            else False
        )

        # Volume ignition: violent 1-day surge near (but not yet through) the N-day high.
        # Example: STAK 2026-06-02 — +95% day, 9× volume, 22% below the 20d high; next session broke out.
        volume_ignition = (
            not is_breakout
            and self.cfg.ignite_vol_ratio_min > 0
            and not np.isnan(vol_ratio)
            and vol_ratio >= self.cfg.ignite_vol_ratio_min
            and ret_1d >= self.cfg.ignite_ret_1d_min_pct
            and not np.isnan(breakout_dist_pct)
            and breakout_dist_pct <= self.cfg.ignite_prior_high_dist_pct_max
        )
        passes_ignite_price = self.cfg.ignite_price_min <= close <= self.cfg.price_max
        passes_ignite_atr = passes_high_vol_atr
        passes_filters = passes_dollar_vol and (
            (passes_price and (passes_standard_atr or (high_volume_breakout and passes_high_vol_atr)))
            or (volume_ignition and passes_ignite_price and passes_ignite_atr)
        )

        # Exit logic if we have an open buy.
        if open_buy is not None:
            age_days = nyse_session_dates_between_exclusive_start(
                open_buy.buy_asof_date, asof_date
            )
            stop_hit = open_buy.stop is not None and close <= open_buy.stop
            hit_ceiling = age_days >= self.cfg.max_hold_days

            # Trailing exit (research: 2026-07 cohort — 74% of trades exited on a fixed time
            # limit, and several winners kept improving from day 3 to day 5). Once the min hold
            # is reached, keep riding a profitable trade as long as it holds above the prior
            # session's low; otherwise exit now. Hard stop and max_hold_days ceiling still apply.
            trailing_enabled = (
                self.cfg.trailing_min_hold_days > 0
                and self.cfg.trailing_min_hold_days < self.cfg.max_hold_days
            )
            trail_exit_reason: str | None = None
            if not stop_hit and not hit_ceiling and trailing_enabled and age_days >= self.cfg.trailing_min_hold_days:
                prior_low = float(df["low"].iloc[-2]) if len(df) >= 2 else None
                in_profit = close > open_buy.entry
                trail_broken = prior_low is not None and close < prior_low
                if in_profit and not trail_broken:
                    time_exit = False
                else:
                    time_exit = True
                    trail_exit_reason = "trail break" if trail_broken else "below entry"
            else:
                time_exit = hit_ceiling

            if stop_hit or time_exit:
                if stop_hit:
                    notes = "stop hit"
                elif hit_ceiling:
                    notes = f"time exit (max hold, sessions since buy={age_days})"
                elif trail_exit_reason:
                    notes = f"trailing exit ({trail_exit_reason}, sessions since buy={age_days})"
                else:
                    notes = f"time exit (sessions since buy={age_days})"
                conf = 85 if stop_hit else 70
                return Signal(
                    ticker=ticker,
                    action="SELL",
                    confidence=conf,
                    score=0.0,
                    close=close,
                    suggested_entry=None,
                    suggested_stop=None,
                    suggested_target=None,
                    max_hold_days=self.cfg.max_hold_days,
                    data_provider=data_provider,
                    notes=notes,
                    metrics={
                        "ret_1d_pct": ret_1d,
                        "ret_5d_pct": ret_5d,
                        "ret_10d_pct": ret_10d,
                        "vol": vol,
                        "avg20_vol": avg20_vol,
                        "vol_ratio": vol_ratio,
                        "atr14": atr14,
                        "atr_pct": atr_pct,
                        "prior_high_n": prior_high_n,
                        "breakout_dist_pct": breakout_dist_pct,
                        "open_buy_age_days": float(age_days),
                        "open_buy_entry": float(open_buy.entry),
                        "open_buy_stop": float(open_buy.stop) if open_buy.stop is not None else None,
                    },
                )

        if not passes_filters:
            return None

        # Component scores (0..1)
        breakout_near = (not np.isnan(breakout_dist_pct)) and (breakout_dist_pct <= self.cfg.breakout_dist_pct_max)
        breakout_component = 1.0 if is_breakout else (
            _clamp(1.0 - (max(0.0, breakout_dist_pct) / max(self.cfg.breakout_dist_pct_max, 1e-9)))
            if breakout_near
            else 0.0
        )

        momentum_component = _clamp(
            min(ret_5d / max(self.cfg.ret_5d_min_pct, 1e-9), ret_10d / max(self.cfg.ret_10d_min_pct, 1e-9))
            / 1.5
        )
        volume_component = _clamp((vol_ratio / max(self.cfg.vol_ratio_min, 1e-9)) / 1.5) if not np.isnan(vol_ratio) else 0.0

        w = self.cfg.weights
        score = (
            w.breakout * breakout_component
            + w.momentum * momentum_component
            + w.volume * volume_component
        )
        score = _clamp(score)
        confidence = int(round(score * 100))

        # Action rules.
        meets_momentum = (ret_5d >= self.cfg.ret_5d_min_pct) and (ret_10d >= self.cfg.ret_10d_min_pct)
        meets_volume = (vol_ratio >= self.cfg.vol_ratio_min) if not np.isnan(vol_ratio) else False
        # Overextension guard: a name that already ran too far tends to mean-revert
        # inside the hold window (backtest-derived). 0 disables each cap.
        # Fresh high-volume breakouts (STAK 2026-06-03) may look overextended on 5d/10d
        # returns but still have continuation — bypass caps when volume confirms.
        overextended = (not high_volume_breakout) and (
            (self.cfg.ret_5d_max_pct > 0 and ret_5d > self.cfg.ret_5d_max_pct)
            or (self.cfg.ret_10d_max_pct > 0 and ret_10d > self.cfg.ret_10d_max_pct)
        )

        standard_buy = is_breakout and meets_momentum and meets_volume and not overextended
        ignite_buy = volume_ignition and meets_momentum and meets_volume

        if standard_buy or ignite_buy:
            action: SignalAction = "BUY"
            notes = (
                "volume ignition + momentum + volume"
                if ignite_buy and not standard_buy
                else "breakout + momentum + volume"
            )
        else:
            action = "WAIT"
            missing = []
            if not is_breakout and not volume_ignition:
                missing.append("no breakout")
            if not meets_momentum:
                missing.append("weak momentum")
            if not meets_volume:
                missing.append("low volume")
            if overextended:
                missing.append("overextended")
            notes = ", ".join(missing) if missing else "watch"

        suggested_entry = close if action == "BUY" else None
        suggested_stop = float(close - (self.cfg.stop_atr_mult * atr14)) if action == "BUY" and not np.isnan(atr14) else None
        suggested_target = float(close + (self.cfg.target_atr_mult * atr14)) if action == "BUY" and not np.isnan(atr14) else None

        hold_days = self.cfg.max_hold_days
        estimated_hold: float | None = None
        if action == "BUY" and suggested_target is not None and not np.isnan(atr14) and atr14 > 0:
            target_dist = suggested_target - close
            estimated_hold = target_dist / atr14
            hold_days = max(2, min(math.ceil(estimated_hold), self.cfg.max_hold_days))

        return Signal(
            ticker=ticker,
            action=action,
            confidence=confidence,
            score=score,
            close=close,
            suggested_entry=suggested_entry,
            suggested_stop=suggested_stop,
            suggested_target=suggested_target,
            max_hold_days=hold_days,
            data_provider=data_provider,
            notes=notes,
            metrics={
                "ret_1d_pct": ret_1d,
                "ret_5d_pct": ret_5d,
                "ret_10d_pct": ret_10d,
                "vol": vol,
                "avg20_vol": avg20_vol,
                "vol_ratio": vol_ratio,
                "atr14": atr14,
                "atr_pct": atr_pct,
                "prior_high_n": prior_high_n,
                "breakout_dist_pct": breakout_dist_pct,
                "estimated_hold_days": estimated_hold,
            },
        )

