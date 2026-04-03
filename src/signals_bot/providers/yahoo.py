from __future__ import annotations

from datetime import datetime, timedelta, timezone
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import os

import pandas as pd
import yfinance as yf

from signals_bot.providers.base import MarketDataProvider


class YahooProvider(MarketDataProvider):
    def __init__(self, *, timeout_sec: int = 20, ssl_verify: bool = True, ca_bundle_path: str | None = None) -> None:
        self._timeout_sec = timeout_sec
        self._cache: dict[tuple[str, int], pd.DataFrame] = {}
        self._info_cache: dict[str, dict[str, str]] = {}
        self._ssl_verify = ssl_verify
        self._ca_bundle_path = ca_bundle_path

    def get_history(self, symbol: str, *, lookback_days: int) -> pd.DataFrame:
        cache_key = (symbol.upper(), int(lookback_days))
        if cache_key in self._cache:
            return self._cache[cache_key].copy()

        # Using explicit start/end improves determinism and reduces surprises with "period".
        end = datetime.now(timezone.utc).date() + timedelta(days=1)
        start = end - timedelta(days=max(lookback_days, 30) + 20)

        # yfinance (recent versions) may use curl_cffi internally, so passing a requests.Session can fail.
        # We rely on standard environment variables for SSL trust when running behind corporate proxies.
        if self._ca_bundle_path:
            # Used by requests/urllib3 and respected by many TLS stacks.
            os.environ.setdefault("REQUESTS_CA_BUNDLE", self._ca_bundle_path)
            os.environ.setdefault("SSL_CERT_FILE", self._ca_bundle_path)
            # curl/curl_cffi often respects this.
            os.environ.setdefault("CURL_CA_BUNDLE", self._ca_bundle_path)
        if not self._ssl_verify:
            # curl_cffi/yfinance doesn't expose a clean "verify=False" switch here.
            # We keep this as a no-op and rely on ca_bundle_path instead.
            pass

        # yfinance can print noisy "Failed download: ['TSLA']: TypeError(...)" messages directly to stdout.
        # We suppress that output and handle failures based on returned dataframe.
        _stdout = StringIO()
        _stderr = StringIO()
        with redirect_stdout(_stdout), redirect_stderr(_stderr):
            df = yf.download(
                tickers=symbol,
                start=str(start),
                end=str(end),
                interval="1d",
                auto_adjust=False,
                progress=False,
                threads=False,
            )

        if df is None or df.empty:
            raise ValueError("empty dataframe from yfinance")

        # yfinance can return MultiIndex columns in some cases; normalize to a single symbol.
        if isinstance(df.columns, pd.MultiIndex):
            sym = symbol.upper()
            if sym in df.columns.get_level_values(-1):
                df = df.xs(sym, axis=1, level=-1)
            else:
                df.columns = df.columns.get_level_values(0)

        # Normalize column names.
        df = df.rename(
            columns={
                "Open": "open",
                "High": "high",
                "Low": "low",
                "Close": "close",
                "Adj Close": "adj_close",
                "Volume": "volume",
            }
        )
        keep = [c for c in ["open", "high", "low", "close", "volume"] if c in df.columns]
        df = df[keep].copy()
        if "close" not in df.columns:
            raise ValueError("yfinance missing close column")

        df = df.dropna(subset=["close"]).copy()
        df.index = pd.to_datetime(df.index)
        df = df.sort_index()

        # Ensure numeric dtypes.
        for col in ["open", "high", "low", "close", "volume"]:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")

        df = df.dropna(subset=["open", "high", "low", "close"]).copy()
        df = df.tail(lookback_days + 10)
        self._cache[cache_key] = df.copy()
        return df

    def get_ticker_info(self, symbol: str) -> dict[str, str]:
        key = symbol.upper()
        if key in self._info_cache:
            return self._info_cache[key]

        try:
            _stdout = StringIO()
            _stderr = StringIO()
            with redirect_stdout(_stdout), redirect_stderr(_stderr):
                t = yf.Ticker(symbol)
                info = t.info or {}
            result = {
                "sector": info.get("sector", ""),
                "industry": info.get("industry", ""),
            }
        except Exception:
            result = {"sector": "", "industry": ""}

        self._info_cache[key] = result
        return result

