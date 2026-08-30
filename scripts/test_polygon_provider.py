"""Unit tests for Massive/Polygon daily aggs parsing."""

from __future__ import annotations

import unittest

from signals_bot.providers.polygon import aggs_results_to_ohlcv_df


class PolygonAggsParseTests(unittest.TestCase):
    def test_parses_bars_ascending(self) -> None:
        # Two sessions: 2024-01-02 and 2024-01-03 UTC midnight-ish ms
        results = [
            {"t": 1_704_153_600_000, "o": 10.0, "h": 11.0, "l": 9.5, "c": 10.5, "v": 1000},
            {"t": 1_704_240_000_000, "o": 10.5, "h": 12.0, "l": 10.0, "c": 11.5, "v": 2000},
        ]
        df = aggs_results_to_ohlcv_df(results)
        self.assertEqual(list(df.columns), ["open", "high", "low", "close", "volume"])
        self.assertEqual(len(df), 2)
        self.assertAlmostEqual(float(df["close"].iloc[0]), 10.5)
        self.assertAlmostEqual(float(df["close"].iloc[-1]), 11.5)
        self.assertTrue(df.index.is_monotonic_increasing)

    def test_empty_raises(self) -> None:
        with self.assertRaises(ValueError):
            aggs_results_to_ohlcv_df([])
        with self.assertRaises(ValueError):
            aggs_results_to_ohlcv_df(None)


if __name__ == "__main__":
    unittest.main()
