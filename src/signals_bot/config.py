from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import yaml


@dataclass(frozen=True)
class RunConfig:
    name: str
    timezone: str


@dataclass(frozen=True)
class UniverseConfig:
    symbols: list[str] | None = None
    symbols_csv: str | None = None
    symbols_dir: str | None = None
    ibkr_scanner: dict[str, Any] | None = None


@dataclass(frozen=True)
class IbkrScannerConfig:
    enabled: bool = False
    merge_with_static: bool = True
    max_symbols: int = 200
    scan_codes: list[str] = field(default_factory=lambda: ["TOP_PERC_GAIN", "HOT_BY_VOLUME"])
    instrument: str = "STK"
    location_code: str = "STK.US.MAJOR"


@dataclass(frozen=True)
class IbkrConfig:
    host: str = "127.0.0.1"
    port: int = 7497
    client_id: int = 7
    connect_timeout_sec: int = 5


@dataclass(frozen=True)
class DataConfig:
    lookback_days: int = 90
    provider_order: list[str] = field(default_factory=lambda: ["yahoo", "stooq"])
    request_timeout_sec: int = 20
    ca_bundle_path: str | None = None
    ssl_verify: bool = True


@dataclass(frozen=True)
class StrategyWeights:
    breakout: float = 0.40
    momentum: float = 0.35
    volume: float = 0.25


@dataclass(frozen=True)
class StrategyConfig:
    price_min: float = 2.0
    price_max: float = 80.0
    avg_dollar_vol_min: float = 5_000_000
    atr_pct_min: float = 3.0
    atr_pct_max: float = 18.0
    breakout_lookback_days: int = 20
    breakout_dist_pct_max: float = 1.0
    ret_5d_min_pct: float = 8.0
    ret_10d_min_pct: float = 12.0
    vol_ratio_min: float = 2.0
    max_hold_days: int = 5
    stop_atr_mult: float = 1.5
    target_atr_mult: float = 3.0
    weights: StrategyWeights = StrategyWeights()


@dataclass(frozen=True)
class SqliteConfig:
    enabled: bool = True
    path: str = "./data/signals.db"


@dataclass(frozen=True)
class SlackConfig:
    enabled: bool = True
    channel: str = "YOUR_CHANNEL_ID"
    post_top_n: int = 10
    min_confidence: int = 60


@dataclass(frozen=True)
class LoggingConfig:
    level: str = "INFO"


@dataclass(frozen=True)
class RunSummary:
    run: RunConfig
    universe: UniverseConfig
    data: DataConfig
    strategy: StrategyConfig

    def to_json(self) -> str:
        return json.dumps(self, default=lambda o: o.__dict__, sort_keys=True)


@dataclass(frozen=True)
class AppConfig:
    config_path: Path
    run: RunConfig
    universe: UniverseConfig
    data: DataConfig
    strategy: StrategyConfig
    sqlite: SqliteConfig
    slack: SlackConfig
    logging: LoggingConfig
    ibkr: IbkrConfig
    ibkr_scanner: IbkrScannerConfig

    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.run.timezone)

    def asof_date(self) -> date:
        # Daily-close scan: use the local market date for “as-of”.
        return datetime.now(self.tz()).date()

    def resolve_path(self, p: str) -> Path:
        path = Path(p).expanduser()
        if path.is_absolute():
            return path
        return (self.config_path.parent / path).resolve()

    def load_universe(self) -> list[str]:
        static_symbols: set[str] = set()

        if self.universe.symbols_csv:
            csv_path = self.resolve_path(self.universe.symbols_csv)
            df = pd.read_csv(csv_path)
            if "symbol" not in df.columns:
                raise ValueError(f"Universe CSV missing required column 'symbol': {csv_path}")
            static_symbols |= {str(s).strip().upper() for s in df["symbol"].dropna().tolist() if str(s).strip()}

        if self.universe.symbols_dir:
            dir_path = self.resolve_path(self.universe.symbols_dir)
            if not dir_path.is_dir():
                raise ValueError(f"Universe symbols_dir is not a directory: {dir_path}")
            for csv_path in sorted(dir_path.glob("*.csv")):
                df = pd.read_csv(csv_path)
                if "symbol" not in df.columns:
                    raise ValueError(f"Universe CSV missing required column 'symbol': {csv_path}")
                static_symbols |= {
                    str(s).strip().upper()
                    for s in df["symbol"].dropna().tolist()
                    if str(s).strip()
                }

        if self.universe.symbols:
            static_symbols |= {s.strip().upper() for s in self.universe.symbols if s.strip()}

        # IBKR scanner symbols (optional; fetched at runtime in main, but we keep config structure here).
        if self.ibkr_scanner.enabled and not self.ibkr_scanner.merge_with_static and not static_symbols:
            # Pure-dynamic universe is allowed.
            return []

        if not static_symbols and not self.ibkr_scanner.enabled:
            raise ValueError("Universe is empty. Provide universe.symbols, universe.symbols_csv, or enable universe.ibkr_scanner.")

        return sorted(static_symbols)

    def to_summary(self) -> RunSummary:
        return RunSummary(run=self.run, universe=self.universe, data=self.data, strategy=self.strategy)


def _coerce_weights(d: dict[str, Any] | None) -> StrategyWeights:
    if not d:
        return StrategyWeights()
    return StrategyWeights(
        breakout=float(d.get("breakout", 0.40)),
        momentum=float(d.get("momentum", 0.35)),
        volume=float(d.get("volume", 0.25)),
    )


def load_config(config_path: Path) -> AppConfig:
    raw = yaml.safe_load(config_path.read_text()) or {}

    run_raw = raw.get("run", {}) or {}
    universe_raw = raw.get("universe", {}) or {}
    data_raw = raw.get("data", {}) or {}
    ibkr_raw = raw.get("ibkr", {}) or {}
    strategy_raw = raw.get("strategy", {}) or {}
    sqlite_raw = raw.get("sqlite", {}) or {}
    slack_raw = raw.get("slack", {}) or {}
    logging_raw = raw.get("logging", {}) or {}

    data_provider_order = data_raw.get("provider_order") or ["yahoo", "stooq"]

    strategy_weights = _coerce_weights(strategy_raw.get("weights"))
    strategy_cfg = StrategyConfig(
        price_min=float(strategy_raw.get("price_min", 2.0)),
        price_max=float(strategy_raw.get("price_max", 80.0)),
        avg_dollar_vol_min=float(strategy_raw.get("avg_dollar_vol_min", 5_000_000)),
        atr_pct_min=float(strategy_raw.get("atr_pct_min", 3.0)),
        atr_pct_max=float(strategy_raw.get("atr_pct_max", 18.0)),
        breakout_lookback_days=int(strategy_raw.get("breakout_lookback_days", 20)),
        breakout_dist_pct_max=float(strategy_raw.get("breakout_dist_pct_max", 1.0)),
        ret_5d_min_pct=float(strategy_raw.get("ret_5d_min_pct", 8.0)),
        ret_10d_min_pct=float(strategy_raw.get("ret_10d_min_pct", 12.0)),
        vol_ratio_min=float(strategy_raw.get("vol_ratio_min", 2.0)),
        max_hold_days=int(strategy_raw.get("max_hold_days", 5)),
        stop_atr_mult=float(strategy_raw.get("stop_atr_mult", 1.5)),
        target_atr_mult=float(strategy_raw.get("target_atr_mult", 3.0)),
        weights=strategy_weights,
    )

    sqlite_path_raw = str(sqlite_raw.get("path", "./data/signals.db"))
    sqlite_path_abs = str((config_path.parent / Path(sqlite_path_raw)).resolve()) if not Path(sqlite_path_raw).expanduser().is_absolute() else str(Path(sqlite_path_raw).expanduser())

    cfg = AppConfig(
        config_path=config_path,
        run=RunConfig(
            name=str(run_raw.get("name", "daily_close_scan")),
            timezone=str(run_raw.get("timezone", "America/New_York")),
        ),
        universe=UniverseConfig(
            symbols=universe_raw.get("symbols"),
            symbols_csv=universe_raw.get("symbols_csv"),
            symbols_dir=universe_raw.get("symbols_dir"),
            ibkr_scanner=universe_raw.get("ibkr_scanner"),
        ),
        data=DataConfig(
            lookback_days=int(data_raw.get("lookback_days", 90)),
            provider_order=[str(x) for x in data_provider_order],
            request_timeout_sec=int(data_raw.get("request_timeout_sec", 20)),
            ca_bundle_path=data_raw.get("ca_bundle_path"),
            ssl_verify=bool(data_raw.get("ssl_verify", True)),
        ),
        strategy=strategy_cfg,
        sqlite=SqliteConfig(
            enabled=bool(sqlite_raw.get("enabled", True)),
            path=sqlite_path_abs,
        ),
        slack=SlackConfig(
            enabled=bool(slack_raw.get("enabled", True)),
            channel=str(slack_raw.get("channel", "YOUR_CHANNEL_ID")),
            post_top_n=int(slack_raw.get("post_top_n", 10)),
            min_confidence=int(slack_raw.get("min_confidence", 60)),
        ),
        logging=LoggingConfig(level=str(logging_raw.get("level", "INFO"))),
        ibkr=IbkrConfig(
            host=str(ibkr_raw.get("host", "127.0.0.1")),
            port=int(ibkr_raw.get("port", 7497)),
            client_id=int(ibkr_raw.get("client_id", 7)),
            connect_timeout_sec=int(ibkr_raw.get("connect_timeout_sec", 5)),
        ),
        ibkr_scanner=IbkrScannerConfig(
            enabled=bool((universe_raw.get("ibkr_scanner") or {}).get("enabled", False)),
            merge_with_static=bool((universe_raw.get("ibkr_scanner") or {}).get("merge_with_static", True)),
            max_symbols=int((universe_raw.get("ibkr_scanner") or {}).get("max_symbols", 200)),
            scan_codes=[str(x) for x in ((universe_raw.get("ibkr_scanner") or {}).get("scan_codes") or ["TOP_PERC_GAIN", "HOT_BY_VOLUME"])],
            instrument=str((universe_raw.get("ibkr_scanner") or {}).get("instrument", "STK")),
            location_code=str((universe_raw.get("ibkr_scanner") or {}).get("location_code", "STK.US.MAJOR")),
        ),
    )
    return cfg

