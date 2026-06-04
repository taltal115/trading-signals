#!/usr/bin/env python3
"""Fetch IBKR portfolio from Client Portal Gateway and write Firestore snapshot."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from signals_bot.config import load_config
from signals_bot.providers.ibkr_cp_gateway import (
    fetch_portfolio_snapshot,
    resolve_cp_gateway_config,
    snapshot_to_firestore_doc,
    snapshot_to_holdings,
)
from signals_bot.storage.firestore import write_ibkr_portfolio_snapshot


def sync_once(cfg_path: Path, *, dry_run: bool) -> int:
    cfg = load_config(cfg_path)
    cp = cfg.ibkr.client_portal
    gw = resolve_cp_gateway_config(
        base_url=cp.base_url,
        verify_ssl=cp.verify_ssl,
        account_id=cp.account_id,
        timeout_sec=cfg.data.request_timeout_sec,
    )
    snap = fetch_portfolio_snapshot(gw)
    doc = snapshot_to_firestore_doc(snap)
    holdings, _ = snapshot_to_holdings(snap)
    print(
        f"account={snap.account_id} positions={len(holdings)} ts_utc={doc['ts_utc']}"
    )
    if dry_run:
        print("(dry-run — not writing Firestore)")
        return 0
    account_id = write_ibkr_portfolio_snapshot(doc, collection=cp.collection)
    print(f"Firestore write ok collection={cp.collection} account={account_id} latest=latest")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Sync IBKR portfolio snapshot to Firestore.")
    p.add_argument("--config", default="config.yaml", help="Path to YAML config.")
    p.add_argument("--dry-run", action="store_true", help="Fetch only; do not write Firestore.")
    p.add_argument(
        "--loop",
        action="store_true",
        help="Run continuously (interval from ibkr.client_portal.sync_interval_min).",
    )
    args = p.parse_args()
    cfg_path = Path(args.config).expanduser().resolve()

    if not args.loop:
        try:
            return sync_once(cfg_path, dry_run=args.dry_run)
        except Exception as e:  # noqa: BLE001
            print(f"ERROR: {e}", file=sys.stderr)
            return 1

    cfg = load_config(cfg_path)
    interval_sec = max(60, int(cfg.ibkr.client_portal.sync_interval_min) * 60)
    print(f"Looping every {interval_sec}s (Ctrl+C to stop)")
    while True:
        try:
            sync_once(cfg_path, dry_run=args.dry_run)
        except Exception as e:  # noqa: BLE001
            print(f"ERROR: {e}", file=sys.stderr)
        time.sleep(interval_sec)


if __name__ == "__main__":
    raise SystemExit(main())
