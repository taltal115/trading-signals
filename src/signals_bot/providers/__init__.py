"""Market data providers (history for scans / research)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from signals_bot.providers.base import MarketDataProvider
from signals_bot.providers.stooq import StooqProvider
from signals_bot.providers.yahoo import YahooProvider

if TYPE_CHECKING:
    from signals_bot.config import AppConfig

__all__ = [
    "MarketDataProvider",
    "YahooProvider",
    "StooqProvider",
    "PolygonProvider",
    "build_history_providers",
    "ordered_history_providers",
]


def build_history_providers(cfg: AppConfig) -> dict[str, Any]:
    """Named providers for history fetch. Polygon only when ``polygon_api_key`` is set."""
    ca = (
        cfg.resolve_path(cfg.data.ca_bundle_path).as_posix()
        if cfg.data.ca_bundle_path
        else None
    )
    out: dict[str, Any] = {
        "yahoo": YahooProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=ca,
        ),
        "stooq": StooqProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=ca,
            api_key=cfg.data.stooq_api_key,
        ),
    }
    key = (cfg.data.polygon_api_key or "").strip()
    if key:
        from signals_bot.providers.polygon import PolygonProvider

        out["polygon"] = PolygonProvider(
            api_key=key,
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=ca,
        )
    return out


def ordered_history_providers(cfg: AppConfig) -> list[Any]:
    """Providers in ``provider_order`` (skip missing names / unset polygon)."""
    by_name = build_history_providers(cfg)
    order = [n for n in cfg.data.provider_order if n in by_name]
    if not order:
        order = [n for n in ("polygon", "yahoo", "stooq") if n in by_name]
    return [by_name[n] for n in order]


# Re-export PolygonProvider lazily for ``from signals_bot.providers import PolygonProvider``.
def __getattr__(name: str) -> Any:
    if name == "PolygonProvider":
        from signals_bot.providers.polygon import PolygonProvider as _P

        return _P
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
