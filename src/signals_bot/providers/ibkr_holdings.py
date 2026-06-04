"""Resolve IBKR holdings for the signal bot: Firestore snapshot → gateway → Flex."""

from __future__ import annotations

import logging
from typing import Any

from signals_bot.config import AppConfig
from signals_bot.providers.ibkr_cp_gateway import (
    fetch_portfolio_snapshot,
    resolve_cp_gateway_config,
    snapshot_to_firestore_doc,
    snapshot_to_holdings,
)
from signals_bot.providers.ibkr_flex import fetch_holdings_and_latest_buys
from signals_bot.storage.firestore import read_ibkr_portfolio_holdings, write_ibkr_portfolio_snapshot


def load_holdings_for_scan(
    cfg: AppConfig,
    logger: logging.Logger,
) -> tuple[set[str] | None, dict[str, dict[str, Any]]]:
    """Return ``(held_symbols, info_by_ticker)`` for SELL / open-buy gating."""
    cp = cfg.ibkr.client_portal
    timeout = cfg.data.request_timeout_sec

    if cp.enabled:
        try:
            holdings, merged = read_ibkr_portfolio_holdings(
                collection=cp.collection,
                account_id=cp.account_id or None,
                max_age_min=cp.snapshot_max_age_min,
            )
            if holdings:
                logger.info(
                    "IBKR holdings from Firestore (%s): %d symbols (max age %d min)",
                    cp.collection,
                    len(holdings),
                    cp.snapshot_max_age_min,
                )
                return holdings, merged
            logger.info(
                "No fresh IBKR portfolio snapshot in Firestore (max age %d min); trying gateway",
                cp.snapshot_max_age_min,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("Firestore IBKR portfolio read failed: %s", e)

        try:
            gw_cfg = resolve_cp_gateway_config(
                base_url=cp.base_url,
                verify_ssl=cp.verify_ssl,
                account_id=cp.account_id,
                timeout_sec=timeout,
            )
            snap = fetch_portfolio_snapshot(gw_cfg)
            holdings, merged = snapshot_to_holdings(snap)
            logger.info(
                "IBKR Client Portal Gateway holdings: %d symbols (account %s)",
                len(holdings),
                snap.account_id,
            )
            try:
                write_ibkr_portfolio_snapshot(
                    snapshot_to_firestore_doc(snap),
                    collection=cp.collection,
                )
                logger.info("Wrote IBKR portfolio snapshot to Firestore (%s)", cp.collection)
            except Exception as w:  # noqa: BLE001
                logger.warning("Firestore IBKR portfolio write-through failed: %s", w)
            return holdings, merged
        except Exception as e:  # noqa: BLE001
            logger.warning("IBKR Client Portal Gateway fetch failed: %s", e)

    try:
        holdings, merged = fetch_holdings_and_latest_buys(timeout_sec=timeout)
        logger.info("IBKR Flex holdings loaded: %d symbols", len(holdings))
        return holdings, merged
    except Exception as e:  # noqa: BLE001
        logger.warning("IBKR Flex fetch failed; proceeding without holdings gate. Error: %s", e)
        return None, {}
