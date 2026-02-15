from __future__ import annotations

import argparse
import json
import os
import sys
import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from dotenv import load_dotenv


SEND_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest"
GET_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement"


def _xml_to_dict(elem: ET.Element) -> dict[str, Any]:
    node: dict[str, Any] = {}

    if elem.attrib:
        node["@attrs"] = dict(elem.attrib)

    children = list(elem)
    if children:
        grouped: dict[str, list[Any]] = {}
        for child in children:
            grouped.setdefault(child.tag, []).append(_xml_to_dict(child))

        for tag, items in grouped.items():
            if len(items) == 1:
                node[tag] = items[0]
            else:
                node[tag] = items

    text = (elem.text or "").strip()
    if text:
        node["#text"] = text

    return node


def _fetch_xml(url: str, *, params: dict[str, Any], timeout_sec: int) -> str:
    qs = urlencode(params)
    req = Request(f"{url}?{qs}", headers={"User-Agent": "signals-bot/1.0"})
    with urlopen(req, timeout=timeout_sec) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _get_reference_code(xml_text: str) -> str:
    root = ET.fromstring(xml_text)
    status = root.findtext("Status", default="").strip()
    if status.lower() != "success":
        raise RuntimeError(f"SendRequest failed. Status={status or 'unknown'}")
    ref = root.findtext("ReferenceCode", default="").strip()
    if not ref:
        raise RuntimeError("SendRequest succeeded but ReferenceCode missing.")
    return ref


def _clean_payload(payload: dict[str, Any]) -> dict[str, Any]:
    root = payload.get("FlexQueryResponse")
    if not isinstance(root, dict):
        return payload

    flex_statements = root.get("FlexStatements")
    if not isinstance(flex_statements, dict):
        return payload

    flex_statement = flex_statements.get("FlexStatement")
    if not isinstance(flex_statement, dict):
        return payload

    cleaned_statement = {}
    if "@attrs" in flex_statement:
        cleaned_statement["@attrs"] = flex_statement["@attrs"]

    if "OpenPositions" in flex_statement:
        cleaned_statement["OpenPositions"] = flex_statement["OpenPositions"]

    if "Trades" in flex_statement:
        trades = flex_statement["Trades"]
        if isinstance(trades, dict) and "Trade" in trades:
            cleaned_statement["Trades"] = {"Trade": trades.get("Trade")}

    cleaned = {
        "FlexQueryResponse": {
            "@attrs": root.get("@attrs", {}),
            "FlexStatements": {
                "@attrs": flex_statements.get("@attrs", {}),
                "FlexStatement": cleaned_statement,
            },
        }
    }
    return cleaned


def main() -> int:
    p = argparse.ArgumentParser(description="IBKR Flex API test (XML -> JSON).")
    p.add_argument("--query-id", type=int, default=1404030, help="Flex Query ID.")
    p.add_argument("--version", default="3", help="Flex API version.")
    p.add_argument("--timeout-sec", type=int, default=20, help="HTTP timeout.")
    p.add_argument("--output", default=None, help="Optional JSON output file path.")
    p.add_argument("--clean", action="store_true", help="Output only OpenPositions and Trades.")
    args = p.parse_args()

    load_dotenv(override=False)
    token = os.getenv("FLEX_API_KEY")
    if not token:
        print("ERROR: missing FLEX_API_KEY in environment/.env", file=sys.stderr)
        return 2

    send_xml = _fetch_xml(
        SEND_URL,
        params={"t": token, "q": args.query_id, "v": args.version},
        timeout_sec=args.timeout_sec,
    )
    ref = _get_reference_code(send_xml)

    statement_xml = _fetch_xml(
        GET_URL,
        params={"t": token, "q": ref, "v": args.version},
        timeout_sec=args.timeout_sec,
    )

    root = ET.fromstring(statement_xml)
    payload = {root.tag: _xml_to_dict(root)}
    if args.clean:
        payload = _clean_payload(payload)
    output_json = json.dumps(payload, indent=2, sort_keys=True)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output_json)
        print(f"Wrote JSON to {args.output}")
    else:
        print(output_json)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
