from __future__ import annotations

from abc import ABC, abstractmethod

import pandas as pd


class MarketDataProvider(ABC):
    @abstractmethod
    def get_history(self, symbol: str, *, lookback_days: int) -> pd.DataFrame:
        """
        Returns a daily OHLCV dataframe with a DatetimeIndex (ascending).

        Required columns (lowercase):
        - open, high, low, close, volume
        """
        raise NotImplementedError

