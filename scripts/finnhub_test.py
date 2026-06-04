from __future__ import annotations

import argparse
import json
import os
import sys

from datetime import date, timedelta

import finnhub
from dotenv import load_dotenv


def main() -> int:
    p = argparse.ArgumentParser(description="Test Finnhub API (requires FINNHUB_API_KEY in .env).")
    p.add_argument("--symbol", default="AAPL", help="Ticker symbol (default: AAPL).")
    p.add_argument(
        "--endpoint",
        choices=["quote", "profile", "us-stocks", "earnings-calendar"],
        default="quote",
        help="API call to test (default: quote).",
    )
    p.add_argument("--from-date", default="", help="earnings-calendar start YYYY-MM-DD (default: today UTC)")
    p.add_argument("--to-date", default="", help="earnings-calendar end YYYY-MM-DD (default: +21 days)")
    args = p.parse_args()

    load_dotenv(override=False)
    api_key = os.getenv("FINNHUB_API_KEY")
    if not api_key:
        print("ERROR: missing FINNHUB_API_KEY in environment.", file=sys.stderr)
        return 2

    client = finnhub.Client(api_key=api_key)
    symbol = args.symbol.strip().upper()

    try:
        if args.endpoint == "quote":
            data = client.quote(symbol)
        elif args.endpoint == "us-stocks":
            data = client.stock_symbols("US")
        elif args.endpoint == "earnings-calendar":
            start = (args.from_date or "").strip() or date.today().isoformat()
            end = (args.to_date or "").strip() or (date.today() + timedelta(days=21)).isoformat()
            data = client.earnings_calendar(
                _from=start,
                to=end,
                symbol=symbol if symbol else "",
                international=False,
            )
        else:
            data = client.company_profile2(symbol=symbol)
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: request failed: {e}", file=sys.stderr)
        return 1

    print(json.dumps(data, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
