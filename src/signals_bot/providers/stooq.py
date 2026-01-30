from __future__ import annotations

from io import StringIO
import re

import pandas as pd
import requests
from requests.exceptions import RequestException, SSLError

from signals_bot.providers.base import MarketDataProvider


class StooqProvider(MarketDataProvider):
    """
    Free daily OHLCV via Stooq CSV endpoint.

    Notes:
    - Stooq uses symbols like `aapl.us`.
    - Some tickers (e.g., with dots) may not map cleanly.
    """

    def __init__(self, *, timeout_sec: int = 20, ssl_verify: bool = True, ca_bundle_path: str | None = None) -> None:
        self._timeout_sec = timeout_sec
        self._cache: dict[tuple[str, int], pd.DataFrame] = {}
        self._ssl_verify = ssl_verify
        self._ca_bundle_path = ca_bundle_path

    @staticmethod
    def _to_stooq_symbol(symbol: str) -> str:
        s = symbol.strip().lower()
        # Stooq generally uses dot-classes, but mapping is inconsistent. Keep conservative.
        s = re.sub(r"[^a-z0-9\.\-]", "", s)
        return f"{s}.us"

    def get_history(self, symbol: str, *, lookback_days: int) -> pd.DataFrame:
        cache_key = (symbol.upper(), int(lookback_days))
        if cache_key in self._cache:
            return self._cache[cache_key].copy()

        stooq_symbol = self._to_stooq_symbol(symbol)
        url_https = f"https://stooq.com/q/d/l/?s={stooq_symbol}&i=d"
        url_http = f"http://stooq.com/q/d/l/?s={stooq_symbol}&i=d"

        verify = self._ca_bundle_path if self._ca_bundle_path else self._ssl_verify

        def is_sslish(exc: Exception) -> bool:
            return isinstance(exc, SSLError) or "CERTIFICATE_VERIFY_FAILED" in str(exc)

        # 1) Preferred: HTTPS with verification (or corporate CA bundle).
        try:
            resp = requests.get(url_https, timeout=self._timeout_sec, verify=verify)
            resp.raise_for_status()
        except RequestException as e:
            if not is_sslish(e):
                raise

            # 2) Retry plain HTTP without redirects. Some environments MITM HTTPS but allow HTTP.
            resp = requests.get(url_http, timeout=self._timeout_sec, allow_redirects=False)
            if resp.is_redirect:
                # If Stooq forces redirect back to HTTPS, we can't use HTTP safely.
                # 3) Last resort: HTTPS without verification (keeps bot usable; prefer setting ca_bundle_path).
                resp = requests.get(url_https, timeout=self._timeout_sec, verify=False)
            resp.raise_for_status()

        df = pd.read_csv(StringIO(resp.text))
        if df is None or df.empty:
            raise ValueError("empty dataframe from stooq")

        df = df.rename(
            columns={
                "Date": "date",
                "Open": "open",
                "High": "high",
                "Low": "low",
                "Close": "close",
                "Volume": "volume",
            }
        )
        if "date" not in df.columns:
            raise ValueError("stooq missing date column")
        if "close" not in df.columns:
            raise ValueError("stooq missing close column")

        df["date"] = pd.to_datetime(df["date"])
        df = df.set_index("date").sort_index()

        for col in ["open", "high", "low", "close", "volume"]:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")

        df = df.dropna(subset=["open", "high", "low", "close"]).copy()
        keep = [c for c in ["open", "high", "low", "close", "volume"] if c in df.columns]
        df = df[keep].copy()
        df = df.tail(lookback_days + 10)
        self._cache[cache_key] = df.copy()
        return df

