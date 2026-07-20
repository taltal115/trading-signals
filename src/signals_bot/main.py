from __future__ import annotations

import argparse
import sys
from dataclasses import asdict, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from signals_bot.config import AppConfig, load_config
from signals_bot.logging import get_logger, log_run_header, log_signal, print_action_table
from signals_bot.notifiers.slack import SlackNotifier
from signals_bot.providers.ibkr_scanner import IbkrScannerClient, IbkrScannerRequest
from signals_bot.providers.stooq import StooqProvider
from signals_bot.providers.yahoo import YahooProvider
from signals_bot.providers.ibkr_holdings import load_holdings_for_scan
from signals_bot.storage.firestore import write_buy_signals
from signals_bot.storage.sqlite import SqliteStore
from signals_bot.strategy.breakout import BreakoutMomentumStrategy, Signal
from signals_bot.strategy.signal_quality import annotate_buy_quality_flags, buy_rank_key


def _signal_rank_key(signal: Signal, cfg: AppConfig) -> tuple:
    """Sort key: BUY first, non-high-risk conf, preferred conf band, preferred ret_5d band,
    non-lottery, least overextended.

    Research 2026-07-20 follow-up #2:
    - Conf 100: 16.7% win rate, −18.38% avg (penalize)
    - Conf 90–94: 60% win rate, +0.72% avg (prioritize)
    """
    metrics = signal.metrics if signal.action == "BUY" else {}
    return buy_rank_key(
        action=signal.action,
        confidence=float(signal.confidence),
        score=float(signal.score),
        metrics=metrics or {},
        prefer_min_pct=cfg.strategy.ret_5d_prefer_min_pct,
        prefer_max_pct=cfg.strategy.ret_5d_prefer_max_pct,
        lottery_vol_ratio_min=cfg.strategy.lottery_vol_ratio_min,
        lottery_ret_5d_min_pct=cfg.strategy.lottery_ret_5d_min_pct,
        high_confidence_risk_threshold=cfg.strategy.high_confidence_risk_threshold,
        prefer_confidence_min=cfg.strategy.prefer_confidence_min,
        prefer_confidence_max=cfg.strategy.prefer_confidence_max,
    )


def _apply_min_buy_confidence(signal: Signal, min_conf: int) -> Signal:
    """Downgrade weak BUY setups to WAIT so Firestore/Slack only see high-confidence entries."""
    if min_conf <= 0 or signal.action != "BUY" or signal.confidence >= min_conf:
        return signal
    return replace(
        signal,
        action="WAIT",
        notes=f"buy setup but confidence {signal.confidence} < min {min_conf}",
        suggested_entry=None,
        suggested_stop=None,
        suggested_target=None,
    )


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="signals-bot", description="Signal-only breakout scanner.")
    p.add_argument("--config", required=True, help="Path to YAML config.")
    p.add_argument("--no-slack", action="store_true", help="Disable Slack posting for this run.")
    p.add_argument("--dry-run", action="store_true", help="Do not write SQLite or send Slack.")
    p.add_argument("--ticker", default="", help="Single ticker to evaluate (default: full universe).")
    return p


def main() -> int:
    args = _build_arg_parser().parse_args()
    config_path = Path(args.config).expanduser().resolve()
    cfg: AppConfig = load_config(config_path)

    logger = get_logger(cfg.logging.level)
    run_id = f"{cfg.run.name}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"

    log_run_header(logger, run_id=run_id, config_path=str(config_path))
    if cfg.strategy.min_buy_confidence > 0:
        logger.info(
            "Min BUY confidence: %d (weaker BUY setups logged as WAIT)",
            cfg.strategy.min_buy_confidence,
        )

    store = SqliteStore(cfg.sqlite.path) if (cfg.sqlite.enabled and not args.dry_run) else None
    if store:
        store.ensure_schema()
        store.start_run(run_id=run_id, asof_date=cfg.asof_date())

    # SSL notes: on corporate networks with SSL interception, set data.ca_bundle_path in YAML
    # (preferred) or temporarily set data.ssl_verify=false.
    providers = {
        "yahoo": YahooProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=cfg.resolve_path(cfg.data.ca_bundle_path).as_posix() if cfg.data.ca_bundle_path else None,
        ),
        "stooq": StooqProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=cfg.resolve_path(cfg.data.ca_bundle_path).as_posix() if cfg.data.ca_bundle_path else None,
            api_key=cfg.data.stooq_api_key,
        ),
    }

    strategy = BreakoutMomentumStrategy(cfg.strategy)

    held_symbols, latest_buys = load_holdings_for_scan(cfg, logger)
    if held_symbols:
        for sym in sorted(held_symbols):
            info = latest_buys.get(sym, {})
            price = info.get("price")
            time = info.get("time")
            price_s = f"${price:.2f}" if isinstance(price, (int, float)) else "-"
            time_s = time or "-"
            logger.info("IBKR holding: %s buy_price=%s buy_time=%s", sym, price_s, time_s)

    static_universe = cfg.load_universe()
    scanner_universe: list[str] = []
    if cfg.ibkr_scanner.enabled:
        try:
            scanner = IbkrScannerClient(
                host=cfg.ibkr.host,
                port=cfg.ibkr.port,
                client_id=cfg.ibkr.client_id,
                connect_timeout_sec=cfg.ibkr.connect_timeout_sec,
            )
            merged: set[str] = set()
            for scan_code in cfg.ibkr_scanner.scan_codes:
                syms = scanner.scan(
                    IbkrScannerRequest(
                        scan_code=scan_code,
                        instrument=cfg.ibkr_scanner.instrument,
                        location_code=cfg.ibkr_scanner.location_code,
                        number_of_rows=min(50, cfg.ibkr_scanner.max_symbols),
                    )
                )
                merged |= set(syms)
            scanner_universe = sorted(merged)[: cfg.ibkr_scanner.max_symbols]
            logger.info("IBKR scanner universe: %d tickers", len(scanner_universe))
        except Exception as e:  # noqa: BLE001
            logger.warning("IBKR scanner failed; falling back to static universe. Error: %s", e)

    universe_set: set[str] = set()
    if cfg.ibkr_scanner.enabled and not cfg.ibkr_scanner.merge_with_static:
        universe_set |= set(scanner_universe)
    else:
        universe_set |= set(static_universe)
        universe_set |= set(scanner_universe)

    universe = sorted(universe_set)

    single_ticker = (args.ticker or "").strip().upper()
    if single_ticker:
        if single_ticker in universe_set:
            universe = [single_ticker]
            logger.info("Single ticker mode: evaluating only %s", single_ticker)
        else:
            universe = [single_ticker]
            logger.info("Single ticker mode: %s (not in universe, evaluating anyway)", single_ticker)
    else:
        logger.info("Universe size: %d tickers", len(universe))

    signals = []
    for ticker in universe:
        provider_used = None
        hist = None
        for prov_name in cfg.data.provider_order:
            prov = providers.get(prov_name)
            if not prov:
                continue
            try:
                hist = prov.get_history(ticker, lookback_days=cfg.data.lookback_days)
                provider_used = prov_name
                break
            except Exception as e:  # noqa: BLE001 - provider errors are expected
                logger.warning("Data provider failed for %s (%s): %s", ticker, prov_name, e)

        if hist is None or hist.empty:
            continue

        last_open_buy = store.get_open_buy(ticker) if store else None
        if held_symbols is not None and ticker not in held_symbols:
            last_open_buy = None
        signal = strategy.generate_signal(
            ticker=ticker,
            hist=hist,
            asof_date=cfg.asof_date(),
            data_provider=provider_used or "unknown",
            open_buy=last_open_buy,
        )
        if signal is None:
            continue

        signal = _apply_min_buy_confidence(signal, cfg.strategy.min_buy_confidence)

        yahoo_prov = providers.get("yahoo")
        if signal.action == "BUY" and isinstance(yahoo_prov, YahooProvider):
            try:
                info = yahoo_prov.get_ticker_info(ticker)
                signal.metrics["sector"] = info.get("sector", "")
                signal.metrics["industry"] = info.get("industry", "")
            except Exception:
                pass

        if signal.action == "BUY":
            signal = replace(
                signal,
                metrics=annotate_buy_quality_flags(
                    signal.metrics or {},
                    confidence=float(signal.confidence),
                    prefer_min_pct=cfg.strategy.ret_5d_prefer_min_pct,
                    prefer_max_pct=cfg.strategy.ret_5d_prefer_max_pct,
                    lottery_vol_ratio_min=cfg.strategy.lottery_vol_ratio_min,
                    lottery_ret_5d_min_pct=cfg.strategy.lottery_ret_5d_min_pct,
                    high_confidence_risk_threshold=cfg.strategy.high_confidence_risk_threshold,
                    prefer_confidence_min=cfg.strategy.prefer_confidence_min,
                    prefer_confidence_max=cfg.strategy.prefer_confidence_max,
                ),
            )

        signals.append(signal)
        log_signal(logger, signal)

        if store:
            store.insert_signal(run_id=run_id, asof_date=cfg.asof_date(), signal=signal)

    # Rank for Slack/Firestore: preferred ret_5d band → non-lottery → least overextended.
    signals_sorted = sorted(signals, key=lambda s: _signal_rank_key(s, cfg))

    if store:
        store.finish_run(run_id=run_id, status="ok", summary_json=asdict(cfg.to_summary()))

    if not args.dry_run:
        try:
            write_buy_signals(
                signals=signals_sorted,
                run_id=run_id,
                asof_date=cfg.asof_date().isoformat(),
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("Firestore write failed: %s", e)

    defer_slack = bool(cfg.ai.enabled and cfg.slack.require_ai_passed)
    slack_enabled = cfg.slack.enabled and not args.no_slack and not args.dry_run and not defer_slack
    if defer_slack and cfg.slack.enabled and not args.no_slack and not args.dry_run:
        logger.info(
            "Slack deferred: ai.enabled + slack.require_ai_passed — "
            "AI entry batch posts ai_gate=passed BUYs only"
        )
    if slack_enabled:
        try:
            notifier = SlackNotifier.from_env_and_config(channel=cfg.slack.channel)
            notifier.post_signals(
                run_name=cfg.run.name,
                asof_date=cfg.asof_date(),
                signals=signals_sorted,
                top_n=cfg.slack.post_top_n,
                min_confidence=cfg.slack.min_confidence,
            )
        except Exception as e:  # noqa: BLE001 - Slack is best-effort; do not crash runs
            logger.error("Slack notification failed: %s", e)

    print_action_table(signals_sorted)
    logger.info("Done. Signals generated: %d", len(signals))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

