from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from google.cloud import firestore
from google.oauth2 import service_account

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from signals_bot.providers.ibkr_flex import fetch_open_positions_symbols

def _build_client() -> firestore.Client:
    load_dotenv(override=False)

    json_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    json_inline = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")

    if json_path:
        creds = service_account.Credentials.from_service_account_file(json_path)
        return firestore.Client(credentials=creds, project=creds.project_id)

    if json_inline:
        data = json.loads(json_inline)
        creds = service_account.Credentials.from_service_account_info(data)
        return firestore.Client(credentials=creds, project=creds.project_id)

    raise RuntimeError(
        "Missing Firestore credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service "
        "account JSON file path, or set FIREBASE_SERVICE_ACCOUNT_JSON to the JSON contents."
    )


def main() -> int:
    p = argparse.ArgumentParser(description="Fetch IBKR Flex OpenPositions and save to Firestore.")
    p.add_argument("--collection", default="ibkr", help="Collection name (default: ibkr).")
    p.add_argument("--doc", default="open_positions", help="Document id (default: open_positions).")
    p.add_argument("--timeout-sec", type=int, default=20, help="HTTP timeout for Flex API.")
    args = p.parse_args()

    try:
        db = _build_client()
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    try:
        symbols = sorted(fetch_open_positions_symbols(timeout_sec=args.timeout_sec))
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: Flex API failed: {e}", file=sys.stderr)
        return 1

    payload = {
        "symbols": symbols,
        "count": len(symbols),
        "ts_utc": datetime.now(timezone.utc).isoformat(),
    }
    doc_ref = db.collection(args.collection).document(args.doc)
    doc_ref.set(payload, merge=True)

    snap = doc_ref.get()
    if not snap.exists:
        print("ERROR: document not found after write", file=sys.stderr)
        return 1

    print("Firestore OK:", snap.to_dict())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
