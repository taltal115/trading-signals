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

        # Baseline filters (for new ideas; we still manage open buys even if they drift).
        avg_dollar_vol = float(close * avg20_vol) if avg20_vol and not np.isnan(avg20_vol) else np.nan
        passes_filters = (
            (self.cfg.price_min <= close <= self.cfg.price_max)
            and (avg_dollar_vol >= self.cfg.avg_dollar_vol_min if not np.isnan(avg_dollar_vol) else False)
            and (self.cfg.atr_pct_min <= atr_pct <= self.cfg.atr_pct_max if not np.isnan(atr_pct) else False)
        )

        # Exit logic if we have an open buy.
        if open_buy is not None:
            age_days = nyse_session_dates_between_exclusive_start(
                open_buy.buy_asof_date, asof_date
            )
            stop_hit = open_buy.stop is not None and close <= open_buy.stop
            time_exit = age_days >= self.cfg.max_hold_days
            if stop_hit or time_exit:
                notes = "stop hit" if stop_hit else f"time exit (sessions since buy={age_days})"
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

        if is_breakout and meets_momentum and meets_volume:
            action: SignalAction = "BUY"
            notes = "breakout + momentum + volume"
        else:
            action = "WAIT"
            missing = []
            if not is_breakout:
                missing.append("no breakout")
            if not meets_momentum:
                missing.append("weak momentum")
            if not meets_volume:
                missing.append("low volume")
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

