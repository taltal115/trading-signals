#!/usr/bin/env python3
"""Smoke-test IBKR Client Portal Gateway (requires authenticated session)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from signals_bot.config import load_config
from signals_bot.providers.ibkr_cp_gateway import (
    IbkrCpGatewayClient,
    fetch_portfolio_snapshot,
    resolve_cp_gateway_config,
    snapshot_to_holdings,
)


def main() -> int:
    p = argparse.ArgumentParser(description="Test IBKR Client Portal Gateway connectivity.")
    p.add_argument("--config", default="config.yaml", help="Path to YAML config.")
    p.add_argument("--positions-only", action="store_true", help="Print holdings tickers only.")
    args = p.parse_args()

    cfg = load_config(Path(args.config).expanduser().resolve())
    cp = cfg.ibkr.client_portal
    gw = resolve_cp_gateway_config(
        base_url=cp.base_url,
        verify_ssl=cp.verify_ssl,
        account_id=cp.account_id,
        timeout_sec=cfg.data.request_timeout_sec,
    )

    client = IbkrCpGatewayClient(gw)
    auth = client.auth_status()
    print("auth/status:", json.dumps(auth, indent=2))

    if not auth.get("authenticated"):
        print(
            "\nERROR: Gateway not authenticated. Start Client Portal Gateway and log in via browser.",
            file=sys.stderr,
        )
        return 2

    accounts = client.list_accounts()
    print("accounts:", accounts)

    snap = fetch_portfolio_snapshot(gw)
    holdings, merged = snapshot_to_holdings(snap)

    if args.positions_only:
        for sym in sorted(holdings):
            info = merged.get(sym, {})
            print(f"{sym} qty={info.get('qty')} avg={info.get('price')} mkt={info.get('mkt_value')}")
        return 0

    payload = {
        "account_id": snap.account_id,
        "authenticated": snap.authenticated,
        "position_count": len(snap.positions),
        "summary": snap.summary,
        "positions": [
            {
                "ticker": x.ticker,
                "qty": x.qty,
                "avg_cost": x.avg_cost,
                "mkt_value": x.mkt_value,
                "unrealized_pnl": x.unrealized_pnl,
            }
            for x in snap.positions
        ],
    }
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
