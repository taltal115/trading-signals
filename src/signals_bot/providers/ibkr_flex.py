from __future__ import annotations

import os
from datetime import datetime
import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from dotenv import load_dotenv


SEND_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest"
GET_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement"

DEFAULT_QUERY_ID = 1404030
DEFAULT_VERSION = "3"


def _fetch_xml(url: str, *, params: dict[str, Any], timeout_sec: int) -> str:
    qs = urlencode(params)
    req = Request(f"{url}?{qs}", headers={"User-Agent": "signals-bot/1.0"})
    with urlopen(req, timeout=timeout_sec) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _get_reference_code(xml_text: str) -> str:
    root = ET.fromstring(xml_text)
    status = root.findtext("Status", default="").strip()
    if status.lower() != "success":
        raise RuntimeError(f"Flex SendRequest failed. Status={status or 'unknown'}")
    ref = root.findtext("ReferenceCode", default="").strip()
    if not ref:
        raise RuntimeError("Flex SendRequest succeeded but ReferenceCode missing.")
    return ref


def _extract_open_positions(xml_text: str) -> dict[str, dict[str, Any]]:
    root = ET.fromstring(xml_text)
    positions: dict[str, dict[str, Any]] = {}
    for open_pos in root.findall(".//OpenPositions/OpenPosition"):
        sym = open_pos.attrib.get("symbol")
        if not sym:
            continue
        sym_u = sym.strip().upper()
        price = _to_float(open_pos.attrib.get("openPrice")) or _to_float(open_pos.attrib.get("costBasisPrice"))
        time = (
            (open_pos.attrib.get("holdingPeriodDateTime") or "").strip()
            or (open_pos.attrib.get("openDateTime") or "").strip()
            or None
        )
        current = positions.get(sym_u)
        if not current:
            positions[sym_u] = {"price": price, "time": time}
        else:
            if current.get("price") is None and price is not None:
                current["price"] = price
            if (not current.get("time")) and time:
                current["time"] = time
    return positions


def _parse_flex_datetime(value: str) -> datetime | None:
    value = value.strip()
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d;%H:%M:%S")
    except ValueError:
        return None


def _to_float(value: str | None) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _extract_latest_buy_trades(xml_text: str) -> dict[str, dict[str, Any]]:
    root = ET.fromstring(xml_text)
    latest: dict[str, dict[str, Any]] = {}

    for trade in root.findall(".//Trades/Trade"):
        if trade.attrib.get("buySell", "").upper() != "BUY":
            continue
        sym = trade.attrib.get("symbol", "").strip().upper()
        if not sym:
            continue
        price_val = _to_float(trade.attrib.get("closePrice"))

        time_raw = trade.attrib.get("orderTime") or trade.attrib.get("openDateTime") or ""
        ts = _parse_flex_datetime(time_raw)

        if sym not in latest or (ts and latest[sym].get("ts") and ts > latest[sym]["ts"]):
            latest[sym] = {
                "price": price_val,
                "time": time_raw or None,
                "ts": ts,
            }

    for sym in list(latest.keys()):
        latest[sym].pop("ts", None)

    return latest


def _fetch_statement_xml(*, timeout_sec: int = 20) -> str:
    load_dotenv(override=False)
    token = os.getenv("FLEX_API_KEY")
    if not token:
        raise ValueError("Missing FLEX_API_KEY in environment/.env")

    send_xml = _fetch_xml(
        SEND_URL,
        params={"t": token, "q": DEFAULT_QUERY_ID, "v": DEFAULT_VERSION},
        timeout_sec=timeout_sec,
    )
    ref = _get_reference_code(send_xml)

    statement_xml = _fetch_xml(
        GET_URL,
        params={"t": token, "q": ref, "v": DEFAULT_VERSION},
        timeout_sec=timeout_sec,
    )
    return statement_xml


def fetch_open_positions_symbols(*, timeout_sec: int = 20) -> set[str]:
    statement_xml = _fetch_statement_xml(timeout_sec=timeout_sec)
    return set(_extract_open_positions(statement_xml).keys())


def fetch_holdings_and_latest_buys(
    *, timeout_sec: int = 20
) -> tuple[set[str], dict[str, dict[str, Any]]]:
    statement_xml = _fetch_statement_xml(timeout_sec=timeout_sec)
    positions = _extract_open_positions(statement_xml)
    buys = _extract_latest_buy_trades(statement_xml)
    holdings = set(positions.keys())

    merged: dict[str, dict[str, Any]] = {}
    for sym in holdings:
        info = positions.get(sym, {})
        merged[sym] = {
            "price": info.get("price"),
            "time": info.get("time"),
        }

    for sym, info in buys.items():
        if sym not in merged:
            merged[sym] = {"price": info.get("price"), "time": info.get("time")}
        else:
            if merged[sym].get("price") is None and info.get("price") is not None:
                merged[sym]["price"] = info.get("price")
            if not merged[sym].get("time") and info.get("time"):
                merged[sym]["time"] = info.get("time")

    return holdings, merged
