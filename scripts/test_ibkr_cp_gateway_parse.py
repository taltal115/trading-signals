"""Unit tests for IBKR CP gateway position parsing (no live gateway)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from signals_bot.providers.ibkr_cp_gateway import _parse_position_row  # noqa: E402


class ParsePositionTests(unittest.TestCase):
    def test_parses_standard_row(self) -> None:
        row = {
            "ticker": "aapl",
            "position": "10",
            "avgCost": "190.5",
            "mktValue": "1950",
            "unrealizedPnl": "45",
            "conid": 265598,
        }
        pos = _parse_position_row(row)
        self.assertIsNotNone(pos)
        assert pos is not None
        self.assertEqual(pos.ticker, "AAPL")
        self.assertEqual(pos.qty, 10.0)
        self.assertEqual(pos.avg_cost, 190.5)

    def test_skips_zero_qty(self) -> None:
        self.assertIsNone(_parse_position_row({"ticker": "X", "position": 0}))


if __name__ == "__main__":
    unittest.main()
