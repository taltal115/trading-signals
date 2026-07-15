from __future__ import annotations

import json
import os
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
class FirestoreUniverseConfig:
    enabled: bool = False
    collection: str = "universe"
    fallback_latest: bool = True


@dataclass(frozen=True)
class UniverseConfig:
    symbols: list[str] | None = None
    symbols_csv: str | None = None
    symbols_dir: str | None = None
    ibkr_scanner: dict[str, Any] | None = None
    firestore: FirestoreUniverseConfig = field(default_factory=FirestoreUniverseConfig)


@dataclass(frozen=True)
class IbkrScannerConfig:
    enabled: bool = False
    merge_with_static: bool = True
    max_symbols: int = 200
    scan_codes: list[str] = field(default_factory=lambda: ["TOP_PERC_GAIN", "HOT_BY_VOLUME"])
    instrument: str = "STK"
    location_code: str = "STK.US.MAJOR"


@dataclass(frozen=True)
class IbkrClientPortalConfig:
    enabled: bool = False
    base_url: str = "https://localhost:5000/v1/api"
    verify_ssl: bool = False
    account_id: str = ""
    collection: str = "ibkr_portfolio"
    snapshot_max_age_min: int = 30
    sync_interval_min: int = 5


@dataclass(frozen=True)
class IbkrConfig:
    host: str = "127.0.0.1"
    port: int = 7497
    client_id: int = 7
    connect_timeout_sec: int = 5
    client_portal: IbkrClientPortalConfig = field(default_factory=IbkrClientPortalConfig)


@dataclass(frozen=True)
class DataConfig:
    lookback_days: int = 90
    provider_order: list[str] = field(default_factory=lambda: ["yahoo", "stooq"])
    request_timeout_sec: int = 20
    ca_bundle_path: str | None = None
    ssl_verify: bool = True
    # Optional: Stooq daily CSV requires an api key (register at https://stooq.com/q/d/).
    # Env STOOQ_API_KEY overrides YAML when set (local `.env`; do not commit secrets).
    stooq_api_key: str | None = None


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
    # Overextension guards: reject BUYs that already ran too far (mean-revert in hold window).
    # 0 disables the cap.
    ret_5d_max_pct: float = 0.0
    ret_10d_max_pct: float = 0.0
    # Skip ret_5d/10d max caps when at/above prior high AND volume confirms (STAK 2026-06-03).
    # 0 disables.
    overextension_bypass_vol_ratio: float = 0.0
    # Volume ignition: huge 1-day surge approaching prior high before full breakout (STAK 2026-06-02).
    # 0 disables each ignite_* gate.
    ignite_vol_ratio_min: float = 0.0
    ignite_ret_1d_min_pct: float = 50.0
    ignite_prior_high_dist_pct_max: float = 25.0
    ignite_atr_pct_max: float = 20.0
    ignite_price_min: float = 1.0
    vol_ratio_min: float = 2.0
    max_hold_days: int = 5
    # Trailing exit (research: 2026-07 cohort — 74% of trades exited on a fixed time limit,
    # and winners kept improving past day 3). Once a BUY has been held this many sessions AND
    # is profitable, extend the hold (up to max_hold_days) as long as it stays above the prior
    # session's low; otherwise exit immediately. 0 disables (fixed time exit at max_hold_days).
    trailing_min_hold_days: int = 0
    stop_atr_mult: float = 1.5
    target_atr_mult: float = 3.0
    min_buy_confidence: int = 0
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
    min_confidence: int = 75


@dataclass(frozen=True)
class LoggingConfig:
    level: str = "INFO"


@dataclass(frozen=True)
class AiConfig:
    enabled: bool = True
    entry_min_total: float = 70.0
    entry_min_conviction: float = 0.7
    max_entry_evals_per_run: int = 15
    max_holding_evals_per_run: int = 40
    # Default / legacy single model (overridden by entry/holding/pro when set).
    model: str = "gpt-5.4"
    entry_model: str = "gpt-5.4"
    holding_model: str = "gpt-5.4-mini"
    # Used for entry when technical_score >= pro_min_technical_score.
    pro_model: str = "gpt-5.4-pro"
    pro_min_technical_score: float = 75.0
    # model -> {prompt_per_1m, completion_per_1m} USD
    pricing: dict[str, dict[str, float]] | None = None


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
    ai: AiConfig = AiConfig()

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
        if self.universe.firestore.enabled:
            if self.ibkr_scanner.enabled and not self.ibkr_scanner.merge_with_static:
                return []

            from signals_bot.storage.firestore import read_universe_for_date

            return read_universe_for_date(
                asof_date=self.asof_date().isoformat(),
                collection=self.universe.firestore.collection,
                fallback_latest=self.universe.firestore.fallback_latest,
            )

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



def _load_ibkr_client_portal_config(raw: dict[str, Any]) -> IbkrClientPortalConfig:
    import os

    env_url = os.environ.get("IBKR_CP_GATEWAY_URL", "").strip()
    env_account = os.environ.get("IBKR_CP_ACCOUNT_ID", "").strip()
    base_url = env_url or str(raw.get("base_url", "https://localhost:5000/v1/api"))
    account_id = env_account or str(raw.get("account_id", "") or "")
    return IbkrClientPortalConfig(
        enabled=bool(raw.get("enabled", False)),
        base_url=base_url.strip(),
        verify_ssl=bool(raw.get("verify_ssl", False)),
        account_id=account_id.strip(),
        collection=str(raw.get("collection", "ibkr_portfolio")),
        snapshot_max_age_min=int(raw.get("snapshot_max_age_min", 30)),
        sync_interval_min=int(raw.get("sync_interval_min", 5)),
    )


def load_config(config_path: Path) -> AppConfig:
    raw = yaml.safe_load(config_path.read_text()) or {}

    run_raw = raw.get("run", {}) or {}
    universe_raw = raw.get("universe", {}) or {}
    fs_raw = universe_raw.get("firestore") or {}
    firestore_universe = FirestoreUniverseConfig(
        enabled=bool(fs_raw.get("enabled", False)),
        collection=str(fs_raw.get("collection", "universe")),
        fallback_latest=bool(fs_raw.get("fallback_latest", True)),
    )
    data_raw = raw.get("data", {}) or {}
    ibkr_raw = raw.get("ibkr", {}) or {}
    strategy_raw = raw.get("strategy", {}) or {}
    sqlite_raw = raw.get("sqlite", {}) or {}
    slack_raw = raw.get("slack", {}) or {}
    logging_raw = raw.get("logging", {}) or {}
    ai_raw = raw.get("ai", {}) or {}

    data_provider_order = data_raw.get("provider_order") or ["yahoo", "stooq"]
    _raw_stooq = data_raw.get("stooq_api_key")
    stooq_api_key_yaml = (
        str(_raw_stooq).strip() if _raw_stooq not in (None, "") else ""
    )
    _stooq_env = os.environ.get("STOOQ_API_KEY", "").strip()
    # Prefer env (local secret) over YAML value.
    stooq_api_key_resolved = _stooq_env if _stooq_env else (stooq_api_key_yaml or None)

    pricing_raw = ai_raw.get("pricing") or {}
    pricing: dict[str, dict[str, float]] | None = None
    if isinstance(pricing_raw, dict) and pricing_raw:
        pricing = {}
        for model_name, row in pricing_raw.items():
            if not isinstance(row, dict):
                continue
            pricing[str(model_name)] = {
                "prompt_per_1m": float(row.get("prompt_per_1m", 0.0) or 0.0),
                "completion_per_1m": float(row.get("completion_per_1m", 0.0) or 0.0),
            }

    ai_cfg = AiConfig(
        enabled=bool(ai_raw.get("enabled", True)),
        entry_min_total=float(ai_raw.get("entry_min_total", 70.0)),
        entry_min_conviction=float(ai_raw.get("entry_min_conviction", 0.7)),
        max_entry_evals_per_run=int(ai_raw.get("max_entry_evals_per_run", 15)),
        max_holding_evals_per_run=int(ai_raw.get("max_holding_evals_per_run", 40)),
        model=str(ai_raw.get("model", "gpt-5.4")),
        entry_model=str(ai_raw.get("entry_model", ai_raw.get("model", "gpt-5.4"))),
        holding_model=str(ai_raw.get("holding_model", "gpt-5.4-mini")),
        pro_model=str(ai_raw.get("pro_model", "gpt-5.4-pro")),
        pro_min_technical_score=float(ai_raw.get("pro_min_technical_score", 75.0)),
        pricing=pricing,
    )

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
        ret_5d_max_pct=float(strategy_raw.get("ret_5d_max_pct", 0.0)),
        ret_10d_max_pct=float(strategy_raw.get("ret_10d_max_pct", 0.0)),
        overextension_bypass_vol_ratio=float(strategy_raw.get("overextension_bypass_vol_ratio", 0.0)),
        ignite_vol_ratio_min=float(strategy_raw.get("ignite_vol_ratio_min", 0.0)),
        ignite_ret_1d_min_pct=float(strategy_raw.get("ignite_ret_1d_min_pct", 50.0)),
        ignite_prior_high_dist_pct_max=float(strategy_raw.get("ignite_prior_high_dist_pct_max", 25.0)),
        ignite_atr_pct_max=float(strategy_raw.get("ignite_atr_pct_max", 20.0)),
        ignite_price_min=float(strategy_raw.get("ignite_price_min", 1.0)),
        vol_ratio_min=float(strategy_raw.get("vol_ratio_min", 2.0)),
        max_hold_days=int(strategy_raw.get("max_hold_days", 5)),
        trailing_min_hold_days=int(strategy_raw.get("trailing_min_hold_days", 0)),
        stop_atr_mult=float(strategy_raw.get("stop_atr_mult", 1.5)),
        target_atr_mult=float(strategy_raw.get("target_atr_mult", 3.0)),
        min_buy_confidence=int(strategy_raw.get("min_buy_confidence", 0)),
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
            firestore=firestore_universe,
        ),
        data=DataConfig(
            lookback_days=int(data_raw.get("lookback_days", 90)),
            provider_order=[str(x) for x in data_provider_order],
            request_timeout_sec=int(data_raw.get("request_timeout_sec", 20)),
            ca_bundle_path=data_raw.get("ca_bundle_path"),
            ssl_verify=bool(data_raw.get("ssl_verify", True)),
            stooq_api_key=stooq_api_key_resolved,
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
            min_confidence=int(slack_raw.get("min_confidence", 75)),
        ),
        logging=LoggingConfig(level=str(logging_raw.get("level", "INFO"))),
        ibkr=IbkrConfig(
            host=str(ibkr_raw.get("host", "127.0.0.1")),
            port=int(ibkr_raw.get("port", 7497)),
            client_id=int(ibkr_raw.get("client_id", 7)),
            connect_timeout_sec=int(ibkr_raw.get("connect_timeout_sec", 5)),
            client_portal=_load_ibkr_client_portal_config(ibkr_raw.get("client_portal") or {}),
        ),
        ibkr_scanner=IbkrScannerConfig(
            enabled=bool((universe_raw.get("ibkr_scanner") or {}).get("enabled", False)),
            merge_with_static=bool((universe_raw.get("ibkr_scanner") or {}).get("merge_with_static", True)),
            max_symbols=int((universe_raw.get("ibkr_scanner") or {}).get("max_symbols", 200)),
            scan_codes=[str(x) for x in ((universe_raw.get("ibkr_scanner") or {}).get("scan_codes") or ["TOP_PERC_GAIN", "HOT_BY_VOLUME"])],
            instrument=str((universe_raw.get("ibkr_scanner") or {}).get("instrument", "STK")),
            location_code=str((universe_raw.get("ibkr_scanner") or {}).get("location_code", "STK.US.MAJOR")),
        ),
        ai=ai_cfg,
    )
    return cfg

