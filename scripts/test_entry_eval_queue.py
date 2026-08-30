"""Unit tests for entry-eval queue partition (continuation-band never rule-skipped)."""

from __future__ import annotations

import unittest

from scripts.ai_stock_eval.firestore_write import (
    in_continuation_band,
    partition_entry_eval_queue,
)


class ContinuationBandTests(unittest.TestCase):
    def test_in_band(self) -> None:
        self.assertTrue(
            in_continuation_band(
                {"ret_5d_pct": 12.0, "vol_ratio": 2.5},
                ret_min=10.0,
                ret_max=20.0,
                vol_min=2.0,
                vol_max=3.0,
            )
        )
        self.assertFalse(
            in_continuation_band(
                {"ret_5d_pct": 12.0, "vol_ratio": 3.0},
                ret_min=10.0,
                ret_max=20.0,
                vol_min=2.0,
                vol_max=3.0,
            )
        )

    def test_partition_never_skips_in_band(self) -> None:
        targets = [
            {"signal_doc_id": "a", "ticker": "AAA", "in_band": True},
            {"signal_doc_id": "a", "ticker": "BBB", "in_band": True},
            {"signal_doc_id": "a", "ticker": "CCC", "in_band": False},
            {"signal_doc_id": "a", "ticker": "DDD", "in_band": False},
            {"signal_doc_id": "a", "ticker": "EEE", "in_band": True},
        ]
        for_llm, for_skip, leave = partition_entry_eval_queue(targets, top_n=2)
        self.assertEqual([t["ticker"] for t in for_llm], ["AAA", "BBB"])
        self.assertEqual([t["ticker"] for t in leave], ["EEE"])
        self.assertEqual({t["ticker"] for t in for_skip}, {"CCC", "DDD"})
        self.assertTrue(all(not t["in_band"] for t in for_skip))


if __name__ == "__main__":
    unittest.main()
