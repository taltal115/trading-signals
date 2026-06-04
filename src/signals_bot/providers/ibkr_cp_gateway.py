"""IBKR Client Portal Gateway REST client (https://localhost:5000/v1/api/).

Signal-only: reads portfolio data. Requires an authenticated gateway session
(log in via browser at the gateway root URL).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

import requests
from dotenv import load_dotenv


@dataclass(frozen=True)
class IbkrCpGatewayConfig:
    base_url: str = "https://localhost:5000/v1/api"
    verify_ssl: bool = False
    account_id: str = ""
    timeout_sec: int = 20


@dataclass(frozen=True)
class IbkrCpPosition:
    ticker: str
    qty: float
    avg_cost: float | None
    mkt_value: float | None
    unrealized_pnl: float | None
    conid: int | None


@dataclass(frozen=True)
class IbkrCpPortfolioSnapshot:
    account_id: str
    authenticated: bool
    positions: list[IbkrCpPosition]
    summary: dict[str, float | None]


def resolve_cp_gateway_config(
    *,
    base_url: str | None = None,
    verify_ssl: bool = False,
    account_id: str = "",
    timeout_sec: int = 20,
) -> IbkrCpGatewayConfig:
    load_dotenv(override=False)
    env_url = os.getenv("IBKR_CP_GATEWAY_URL", "").strip()
    env_account = os.getenv("IBKR_CP_ACCOUNT_ID", "").strip()
    url = (base_url or env_url or "https://localhost:5000/v1/api").strip().rstrip("/") + "/"
    acct = (account_id or env_account).strip()
    return IbkrCpGatewayConfig(
        base_url=url,
        verify_ssl=verify_ssl,
        account_id=acct,
        timeout_sec=timeout_sec,
    )


class IbkrCpGatewayClient:
    def __init__(self, cfg: IbkrCpGatewayConfig) -> None:
        self.cfg = cfg
        self._session = requests.Session()

    def _url(self, path: str) -> str:
        return urljoin(self.cfg.base_url, path.lstrip("/"))

    def _get_json(self, path: str) -> Any:
        resp = self._session.get(
            self._url(path),
            timeout=self.cfg.timeout_sec,
            verify=self.cfg.verify_ssl,
        )
        resp.raise_for_status()
        if not resp.content:
            return None
        return resp.json()

    def auth_status(self) -> dict[str, Any]:
        data = self._get_json("iserver/auth/status")
        return data if isinstance(data, dict) else {}

    def is_authenticated(self) -> bool:
        return bool(self.auth_status().get("authenticated"))

    def list_accounts(self) -> list[str]:
        data = self._get_json("portfolio/accounts")
        if isinstance(data, list):
            return [str(a).strip() for a in data if str(a).strip()]
        if isinstance(data, dict):
            for key in ("accounts", "accountIds", "data"):
                raw = data.get(key)
                if isinstance(raw, list):
                    return [str(a).strip() for a in raw if str(a).strip()]
        return []

    def resolve_account_id(self) -> str:
        if self.cfg.account_id:
            return self.cfg.account_id
        accounts = self.list_accounts()
        if not accounts:
            raise RuntimeError("No IBKR accounts returned from /portfolio/accounts")
        return accounts[0]

    def fetch_positions_page(self, account_id: str, page_id: int = 0) -> list[dict[str, Any]]:
        data = self._get_json(f"portfolio/{account_id}/positions/{page_id}")
        if isinstance(data, list):
            return [p for p in data if isinstance(p, dict)]
        return []

    def fetch_summary(self, account_id: str) -> dict[str, float | None]:
        data = self._get_json(f"portfolio/{account_id}/summary")
        if not isinstance(data, dict):
            return {}
        out: dict[str, float | None] = {}
        for key, val in data.items():
            if isinstance(val, dict):
                amt = val.get("amount")
                if amt is not None:
                    try:
                        out[str(key)] = float(amt)
                    except (TypeError, ValueError):
                        out[str(key)] = None
            elif isinstance(val, (int, float)):
                out[str(key)] = float(val)
        return out


def _to_float(val: Any) -> float | None:
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _parse_position_row(row: dict[str, Any]) -> IbkrCpPosition | None:
    ticker = (
        str(row.get("ticker") or row.get("symbol") or row.get("contractDesc") or "")
        .strip()
        .upper()
    )
    if not ticker:
        return None
    qty = _to_float(row.get("position") or row.get("qty") or row.get("quantity")) or 0.0
    if abs(qty) < 1e-12:
        return None
    avg = _to_float(row.get("avgCost") or row.get("avgPrice") or row.get("averageCost"))
    mkt = _to_float(row.get("mktValue") or row.get("marketValue"))
    pnl = _to_float(row.get("unrealizedPnl") or row.get("unrealizedPNL"))
    conid_raw = row.get("conid") or row.get("conId")
    conid = int(conid_raw) if conid_raw is not None else None
    return IbkrCpPosition(
        ticker=ticker,
        qty=qty,
        avg_cost=avg,
        mkt_value=mkt,
        unrealized_pnl=pnl,
        conid=conid,
    )


def fetch_portfolio_snapshot(cfg: IbkrCpGatewayConfig) -> IbkrCpPortfolioSnapshot:
    client = IbkrCpGatewayClient(cfg)
    authenticated = client.is_authenticated()
    if not authenticated:
        raise RuntimeError(
            "Client Portal Gateway session not authenticated. "
            "Open the gateway URL in a browser and log in."
        )
    account_id = client.resolve_account_id()
    rows = client.fetch_positions_page(account_id, 0)
    positions: list[IbkrCpPosition] = []
    for row in rows:
        pos = _parse_position_row(row)
        if pos:
            positions.append(pos)
    summary = client.fetch_summary(account_id)
    return IbkrCpPortfolioSnapshot(
        account_id=account_id,
        authenticated=authenticated,
        positions=positions,
        summary=summary,
    )


def snapshot_to_holdings(
    snap: IbkrCpPortfolioSnapshot,
) -> tuple[set[str], dict[str, dict[str, Any]]]:
    holdings: set[str] = set()
    merged: dict[str, dict[str, Any]] = {}
    for p in snap.positions:
        holdings.add(p.ticker)
        merged[p.ticker] = {
            "price": p.avg_cost,
            "time": None,
            "qty": p.qty,
            "mkt_value": p.mkt_value,
            "unrealized_pnl": p.unrealized_pnl,
            "conid": p.conid,
        }
    return holdings, merged


def snapshot_to_firestore_doc(snap: IbkrCpPortfolioSnapshot) -> dict[str, Any]:
    from datetime import datetime, timezone

    return {
        "account_id": snap.account_id,
        "ts_utc": datetime.now(timezone.utc).isoformat(),
        "source": "client_portal_gateway",
        "authenticated": snap.authenticated,
        "positions": [
            {
                "ticker": p.ticker,
                "qty": p.qty,
                "avg_cost": p.avg_cost,
                "mkt_value": p.mkt_value,
                "unrealized_pnl": p.unrealized_pnl,
                "conid": p.conid,
            }
            for p in snap.positions
        ],
        "summary": snap.summary,
    }


def fetch_holdings_from_gateway(
    *,
    base_url: str | None = None,
    verify_ssl: bool = False,
    account_id: str = "",
    timeout_sec: int = 20,
) -> tuple[set[str], dict[str, dict[str, Any]]]:
    cfg = resolve_cp_gateway_config(
        base_url=base_url,
        verify_ssl=verify_ssl,
        account_id=account_id,
        timeout_sec=timeout_sec,
    )
    snap = fetch_portfolio_snapshot(cfg)
    return snapshot_to_holdings(snap)
