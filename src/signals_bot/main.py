from __future__ import annotations

import argparse
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from signals_bot.config import AppConfig, load_config
from signals_bot.logging import get_logger, log_run_header, log_signal, print_action_table
from signals_bot.notifiers.slack import SlackNotifier
from signals_bot.providers.ibkr_scanner import IbkrScannerClient, IbkrScannerRequest
from signals_bot.providers.stooq import StooqProvider
from signals_bot.providers.yahoo import YahooProvider
from signals_bot.providers.ibkr_flex import fetch_holdings_and_latest_buys
from signals_bot.storage.firestore import write_buy_signals
from signals_bot.storage.sqlite import SqliteStore
from signals_bot.strategy.breakout import BreakoutMomentumStrategy


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

    held_symbols: set[str] | None = None
    latest_buys: dict[str, dict[str, Any]] = {}
    try:
        held_symbols, latest_buys = fetch_holdings_and_latest_buys(timeout_sec=cfg.data.request_timeout_sec)
        logger.info("IBKR Flex holdings loaded: %d symbols", len(held_symbols))
        for sym in sorted(held_symbols):
            info = latest_buys.get(sym, {})
            price = info.get("price")
            time = info.get("time")
            price_s = f"${price:.2f}" if isinstance(price, (int, float)) else "-"
            time_s = time or "-"
            logger.info("IBKR holding: %s buy_price=%s buy_time=%s", sym, price_s, time_s)
    except Exception as e:  # noqa: BLE001
        held_symbols = None
        latest_buys = {}
        logger.warning("IBKR Flex fetch failed; proceeding without holdings gate. Error: %s", e)

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

        yahoo_prov = providers.get("yahoo")
        if signal.action == "BUY" and isinstance(yahoo_prov, YahooProvider):
            try:
                info = yahoo_prov.get_ticker_info(ticker)
                signal.metrics["sector"] = info.get("sector", "")
                signal.metrics["industry"] = info.get("industry", "")
            except Exception:
                pass

        signals.append(signal)
        log_signal(logger, signal)

        if store:
            store.insert_signal(run_id=run_id, asof_date=cfg.asof_date(), signal=signal)

    # Rank for Slack: prioritize BUY then high confidence
    signals_sorted = sorted(
        signals,
        key=lambda s: (
            0 if s.action == "BUY" else (1 if s.action == "SELL" else 2),
            -s.confidence,
            -s.score,
        ),
    )

    if store:
        store.finish_run(run_id=run_id, status="ok", summary_json=asdict(cfg.to_summary()))

    if not args.dry_run:
        try:
            write_buy_signals(
                signals=signals_sorted,
                run_id=run_id,
                asof_date=cfg.asof_date().isoformat(),
                collection="signals",
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("Firestore write failed: %s", e)

    slack_enabled = cfg.slack.enabled and not args.no_slack and not args.dry_run
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

