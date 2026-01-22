from __future__ import annotations

import argparse
from pathlib import Path
import sys

# Allow running this script without installing the package (repo uses src/ layout).
REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = REPO_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from signals_bot.config import load_config  # noqa: E402
from signals_bot.providers.ibkr_scanner import IbkrScannerClient, IbkrScannerRequest  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Test IBKR scanner connectivity and print symbols.")
    p.add_argument("--config", default="config.yaml", help="Path to config.yaml (default: config.yaml)")
    p.add_argument("--scan-code", default=None, help="Override scan code (e.g., TOP_PERC_GAIN)")
    p.add_argument("--rows", type=int, default=50, help="Number of rows to request (default: 50)")
    args = p.parse_args()

    cfg = load_config(__import__("pathlib").Path(args.config).expanduser().resolve())

    scan_codes = cfg.ibkr_scanner.scan_codes
    if args.scan_code:
        scan_codes = [args.scan_code]

    if not scan_codes:
        print("ERROR: No scan codes configured (set universe.ibkr_scanner.scan_codes).", file=sys.stderr)
        return 2

    client = IbkrScannerClient(
        host=cfg.ibkr.host,
        port=cfg.ibkr.port,
        client_id=cfg.ibkr.client_id,
        connect_timeout_sec=cfg.ibkr.connect_timeout_sec,
    )

    all_syms: set[str] = set()
    for sc in scan_codes:
        syms = client.scan(
            IbkrScannerRequest(
                scan_code=sc,
                instrument=cfg.ibkr_scanner.instrument,
                location_code=cfg.ibkr_scanner.location_code,
                number_of_rows=args.rows,
            )
        )
        print(f"{sc}: {len(syms)} symbols")
        for s in syms[: min(30, len(syms))]:
            print(f"  {s}")
        all_syms |= set(syms)

    print(f"TOTAL unique symbols: {len(all_syms)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

