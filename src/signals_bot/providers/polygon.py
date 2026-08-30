"""Massive (Polygon) daily OHLCV provider — primary when POLYGON_API_KEY is set."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pandas as pd
import requests

from signals_bot.providers.base import MarketDataProvider

POLYGON_AGGS_BASE = "https://api.polygon.io/v2/aggs/ticker"


def aggs_results_to_ohlcv_df(results: list[dict[str, Any]] | None) -> pd.DataFrame:
    """Parse Polygon aggs ``results`` into ascending daily OHLCV (DatetimeIndex)."""
    if not results:
        raise ValueError("empty results from polygon")
    rows: list[dict[str, Any]] = []
    for bar in results:
        if not isinstance(bar, dict):
            continue
        ts_ms = bar.get("t")
        if ts_ms is None:
            continue
        try:
            ts = pd.Timestamp(int(ts_ms), unit="ms", tz="UTC").tz_localize(None).normalize()
        except (TypeError, ValueError):
            continue
        o = bar.get("o")
        h = bar.get("h")
        l = bar.get("l")
        c = bar.get("c")
        v = bar.get("v")
        if c is None:
            continue
        rows.append(
            {
                "date": ts,
                "open": float(o) if o is not None else float(c),
                "high": float(h) if h is not None else float(c),
                "low": float(l) if l is not None else float(c),
                "close": float(c),
                "volume": float(v) if v is not None else 0.0,
            }
        )
    if not rows:
        raise ValueError("no parseable bars from polygon")
    df = pd.DataFrame(rows).set_index("date").sort_index()
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["open", "high", "low", "close"]).copy()
    if df.empty:
        raise ValueError("empty dataframe after polygon parse")
    return df


class PolygonProvider(MarketDataProvider):
    """Daily bars via Polygon/Massive ``/v2/aggs/ticker/.../range/1/day/...``."""

    def __init__(
        self,
        *,
        api_key: str,
        timeout_sec: int = 20,
        ssl_verify: bool = True,
        ca_bundle_path: str | None = None,
    ) -> None:
        key = (api_key or "").strip()
        if not key:
            raise ValueError("polygon api_key is required")
        self._api_key = key
        self._timeout_sec = timeout_sec
        self._ssl_verify: bool | str = ca_bundle_path if ca_bundle_path else ssl_verify
        self._cache: dict[tuple[str, int], pd.DataFrame] = {}

    def get_history(self, symbol: str, *, lookback_days: int) -> pd.DataFrame:
        cache_key = (symbol.upper(), int(lookback_days))
        if cache_key in self._cache:
            return self._cache[cache_key].copy()

        end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=max(lookback_days, 30) + 40)
        sym = symbol.strip().upper()
        url = (
            f"{POLYGON_AGGS_BASE}/{sym}/range/1/day/{start.isoformat()}/{end.isoformat()}"
            f"?adjusted=true&sort=asc&limit=50000&apiKey={self._api_key}"
        )
        resp = requests.get(url, timeout=self._timeout_sec, verify=self._ssl_verify)
        if resp.status_code == 401 or resp.status_code == 403:
            raise ValueError(f"polygon auth failed HTTP {resp.status_code}")
        if resp.status_code == 429:
            raise ValueError("polygon rate limited")
        if not resp.ok:
            raise ValueError(f"polygon HTTP {resp.status_code}: {resp.text[:160]}")
        payload = resp.json()
        status = str(payload.get("status") or "")
        if status.upper() not in ("OK", "DELAYED", ""):
            # Polygon returns OK / DELAYED for success; ERROR etc. for failures.
            if status.upper() == "ERROR" or payload.get("error"):
                raise ValueError(
                    f"polygon error: {payload.get('error') or payload.get('message') or status}"
                )
        results = payload.get("results")
        if not isinstance(results, list):
            raise ValueError("polygon missing results")
        df = aggs_results_to_ohlcv_df(results)
        df = df.tail(lookback_days + 10)
        self._cache[cache_key] = df.copy()
        return df
