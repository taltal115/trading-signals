"""Extra headline/macro providers for AI eval context (NewsAPI, GDELT, FRED)."""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

import requests

logger = logging.getLogger(__name__)

NEWSAPI_URL = "https://newsapi.org/v2/everything"
GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
FRED_OBS_URL = "https://api.stlouisfed.org/fred/series/observations"

# GDELT public API asks for ~1 request / 5s; GitHub runners share egress so stay conservative.
DEFAULT_GDELT_MIN_INTERVAL_SECONDS = 5.5
DEFAULT_GDELT_MAX_RETRIES = 2
DEFAULT_GDELT_RETRY_SECONDS = 15.0
DEFAULT_GDELT_COOLDOWN_SECONDS = 60.0

# Snapshot series for prompt macro block (latest observation each).
FRED_SERIES: list[tuple[str, str]] = [
    ("CPIAUCSL", "CPI (all urban)"),
    ("DFF", "Fed funds effective rate"),
    ("T10Y2Y", "10Y-2Y Treasury spread"),
    ("UNRATE", "Unemployment rate"),
]

_gdelt_lock = threading.Lock()
_gdelt_next_allowed_at = 0.0
_gdelt_skip_until = 0.0


def _truthy_env(name: str, default: bool = True) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def _env_float(name: str, default: float) -> float:
    try:
        return max(0.0, float(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return max(0, int(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


def _short_err(exc: BaseException, *, limit: int = 180) -> str:
    msg = str(exc).strip().replace("\n", " ")
    if len(msg) > limit:
        return msg[: limit - 1] + "…"
    return msg


def _gdelt_wait_turn() -> bool:
    """Pace GDELT calls. Returns False if a prior 429 put us in cooldown (skip call)."""
    global _gdelt_next_allowed_at
    min_interval = _env_float("GDELT_MIN_INTERVAL_SECONDS", DEFAULT_GDELT_MIN_INTERVAL_SECONDS)
    with _gdelt_lock:
        now = time.monotonic()
        if now < _gdelt_skip_until:
            remaining = _gdelt_skip_until - now
            logger.info(
                "GDELT cooldown active (%.0fs left) — skipping request this ticker",
                remaining,
            )
            return False
        wait = _gdelt_next_allowed_at - now
        if wait > 0:
            time.sleep(wait)
        _gdelt_next_allowed_at = time.monotonic() + min_interval
        return True


def _gdelt_mark_rate_limited() -> None:
    """After exhausted 429s, skip further GDELT calls for a cooldown window."""
    global _gdelt_skip_until, _gdelt_next_allowed_at
    cooldown = _env_float("GDELT_COOLDOWN_SECONDS", DEFAULT_GDELT_COOLDOWN_SECONDS)
    with _gdelt_lock:
        now = time.monotonic()
        _gdelt_skip_until = max(_gdelt_skip_until, now + cooldown)
        _gdelt_next_allowed_at = max(_gdelt_next_allowed_at, _gdelt_skip_until)


def reset_gdelt_rate_limit_state_for_tests() -> None:
    """Test helper — clear module pacing/cooldown state."""
    global _gdelt_next_allowed_at, _gdelt_skip_until
    with _gdelt_lock:
        _gdelt_next_allowed_at = 0.0
        _gdelt_skip_until = 0.0


def fetch_newsapi_headlines(query: str, *, limit: int = 12) -> list[str]:
    """Return headline titles from NewsAPI everything search."""
    if not _truthy_env("USE_NEWSAPI", True):
        return []
    api_key = (os.getenv("NEWSAPI_API_KEY") or "").strip()
    if not api_key:
        return []
    q = (query or "").strip()
    if not q:
        return []
    try:
        resp = requests.get(
            NEWSAPI_URL,
            params={
                "q": q,
                "language": "en",
                "sortBy": "publishedAt",
                "pageSize": min(max(limit, 1), 20),
                "apiKey": api_key,
            },
            timeout=25,
        )
        resp.raise_for_status()
        payload = resp.json() or {}
        articles = payload.get("articles") if isinstance(payload, dict) else None
        if not isinstance(articles, list):
            return []
        out: list[str] = []
        for a in articles:
            if not isinstance(a, dict):
                continue
            title = str(a.get("title") or "").strip()
            if title and title.lower() != "[removed]":
                src = ""
                source = a.get("source")
                if isinstance(source, dict):
                    src = str(source.get("name") or "").strip()
                out.append(f"{title}" + (f" ({src})" if src else ""))
            if len(out) >= limit:
                break
        return out
    except Exception as e:  # noqa: BLE001
        logger.warning("NewsAPI headlines failed for %s: %s", q, _short_err(e))
        return []


def fetch_gdelt_headlines(query: str, *, limit: int = 12) -> list[str]:
    """Return headline titles from GDELT doc API (no key)."""
    if not _truthy_env("USE_GDELT", True):
        return []
    q = (query or "").strip()
    if not q:
        return []
    if not _gdelt_wait_turn():
        return []
    normalized = f"({q})" if " OR " in q.upper() else q
    max_retries = _env_int("GDELT_MAX_RETRIES", DEFAULT_GDELT_MAX_RETRIES)
    retry_seconds = _env_float("GDELT_RETRY_SECONDS", DEFAULT_GDELT_RETRY_SECONDS)
    try:
        for attempt in range(max_retries + 1):
            resp = requests.get(
                GDELT_URL,
                params={
                    "query": normalized,
                    "mode": "ArtList",
                    "format": "json",
                    "sort": "DateDesc",
                    "maxrecords": min(max(limit, 1), 20),
                },
                timeout=25,
            )
            if resp.status_code == 429:
                if attempt >= max_retries:
                    _gdelt_mark_rate_limited()
                    logger.warning(
                        "GDELT rate-limited for %s after %d tries — cooling down "
                        "(entry AI continues without GDELT headlines)",
                        q,
                        attempt + 1,
                    )
                    return []
                delay = retry_seconds * (attempt + 1)
                logger.warning(
                    "GDELT HTTP 429 for %s; retrying in %.1fs (%d/%d)",
                    q,
                    delay,
                    attempt + 1,
                    max_retries,
                )
                time.sleep(delay)
                continue
            resp.raise_for_status()
            payload = resp.json() or {}
            articles = payload.get("articles") if isinstance(payload, dict) else None
            if not isinstance(articles, list):
                return []
            out: list[str] = []
            for a in articles:
                if not isinstance(a, dict):
                    continue
                title = str(a.get("title") or "").strip()
                if not title:
                    continue
                domain = str(a.get("domain") or "").strip()
                out.append(f"{title}" + (f" ({domain})" if domain else ""))
                if len(out) >= limit:
                    break
            return out
        return []
    except Exception as e:  # noqa: BLE001
        logger.warning("GDELT headlines failed for %s: %s", q, _short_err(e))
        return []


def fetch_fred_macro_lines(*, limit: int = 5) -> list[str]:
    """Latest FRED observations as short macro lines for the prompt."""
    if not _truthy_env("USE_FRED", True):
        return []
    api_key = (os.getenv("FRED_API_KEY") or "").strip()
    if not api_key:
        return []
    lines: list[str] = []
    for series_id, label in FRED_SERIES:
        if len(lines) >= limit:
            break
        try:
            resp = requests.get(
                FRED_OBS_URL,
                params={
                    "series_id": series_id,
                    "api_key": api_key,
                    "file_type": "json",
                    "sort_order": "desc",
                    "limit": 3,
                },
                timeout=20,
            )
            resp.raise_for_status()
            payload = resp.json() or {}
            obs = payload.get("observations") if isinstance(payload, dict) else None
            if not isinstance(obs, list):
                continue
            for row in obs:
                if not isinstance(row, dict):
                    continue
                val = str(row.get("value") or "").strip()
                if not val or val == ".":
                    continue
                date = str(row.get("date") or "").strip()
                lines.append(f"{label} ({series_id}): {val}" + (f" as of {date}" if date else ""))
                break
        except Exception as e:  # noqa: BLE001
            logger.warning("FRED series %s failed: %s", series_id, _short_err(e))
            continue
    return lines


def merge_headline_titles(
    *,
    finnhub_titles: list[str],
    ticker: str,
    max_total: int = 10,
) -> tuple[list[str], dict[str, bool]]:
    """Dedupe and merge Finnhub + NewsAPI + GDELT titles. Returns (titles, status flags)."""
    seen: set[str] = set()
    out: list[str] = []
    status = {
        "finnhub_news_ok": False,
        "newsapi_configured": bool((os.getenv("NEWSAPI_API_KEY") or "").strip())
        and _truthy_env("USE_NEWSAPI", True),
        "newsapi_ok": False,
        "gdelt_enabled": _truthy_env("USE_GDELT", True),
        "gdelt_ok": False,
    }

    def _add(title: str) -> None:
        t = title.strip()
        if not t:
            return
        key = t.lower()
        if key in seen:
            return
        seen.add(key)
        out.append(t)

    for t in finnhub_titles:
        _add(t)
    if any(str(t or "").strip() for t in finnhub_titles):
        status["finnhub_news_ok"] = True
    if len(out) >= max_total:
        return out[:max_total], status

    newsapi = fetch_newsapi_headlines(ticker, limit=8)
    if newsapi:
        status["newsapi_ok"] = True
    for t in newsapi:
        _add(t)
        if len(out) >= max_total:
            break

    # Skip GDELT when Finnhub/NewsAPI already filled most of the slot — fewer 429s.
    min_before_gdelt = _env_int("GDELT_SKIP_IF_HEADLINES_GE", 5)
    if len(out) < max_total and len(out) < min_before_gdelt:
        gdelt = fetch_gdelt_headlines(ticker, limit=8)
        if gdelt:
            status["gdelt_ok"] = True
        for t in gdelt:
            _add(t)
            if len(out) >= max_total:
                break

    return out[:max_total], status


def build_macro_events_text() -> tuple[str, dict[str, bool]]:
    """Prompt-ready macro block + FRED status flags."""
    status = {
        "fred_configured": bool((os.getenv("FRED_API_KEY") or "").strip()) and _truthy_env("USE_FRED", True),
        "fred_ok": False,
    }
    lines = fetch_fred_macro_lines(limit=5)
    if lines:
        status["fred_ok"] = True
        return "\n".join(f"- {ln}" for ln in lines), status
    return "No macro events.", status
