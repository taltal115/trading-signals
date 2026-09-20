"""Unit tests for pipeline_trace helpers."""

from __future__ import annotations

import unittest
from types import SimpleNamespace

from signals_bot.pipeline_trace import (
    build_scan_pipeline_trace,
    merge_pipeline_trace_stage,
)


class PipelineTraceTests(unittest.TestCase):
    def test_build_scan_pipeline_trace_has_scan_and_hard(self) -> None:
        strategy = SimpleNamespace(
            continuation_ret_5d_min_pct=8.0,
            continuation_ret_5d_max_pct=25.0,
            continuation_vol_ratio_min=2.0,
            continuation_vol_ratio_max=4.0,
            hard_reject_ret_5d_min_pct=50.0,
            hard_reject_vol_ratio_min=5.0,
            hard_reject_confidence_min=0,
            require_continuation_band=True,
            ret_5d_min_pct=8.0,
            ret_10d_min_pct=12.0,
            vol_ratio_min=2.0,
            min_buy_confidence=70,
        )
        ai = SimpleNamespace(entry_min_total=70.0, entry_min_conviction=0.7)
        trace = build_scan_pipeline_trace(
            confidence=82,
            metrics={"ret_5d_pct": 12.0, "ret_10d_pct": 15.0, "vol_ratio": 2.5},
            notes="breakout + momentum + volume",
            strategy=strategy,
            ai=ai,
            at_utc="2026-09-20T00:00:00+00:00",
        )
        self.assertEqual(trace["version"], 1)
        self.assertIn("thresholds", trace)
        self.assertEqual(trace["thresholds"]["entry_min_total"], 70.0)
        self.assertIn("scan", trace["stages"])
        self.assertIn("hard_filters", trace["stages"])
        scan_conds = trace["stages"]["scan"]["conditions"]
        self.assertTrue(any(c["id"] == "momentum_5d" and c["pass"] for c in scan_conds))
        hard = trace["stages"]["hard_filters"]["conditions"]
        self.assertTrue(all(c["pass"] for c in hard))

    def test_merge_appends_ai_gate_stage(self) -> None:
        base = {"version": 1, "thresholds": {}, "stages": {}}
        merged = merge_pipeline_trace_stage(
            base,
            stage_id="ai_gate",
            status="failed",
            job="ai-entry-batch",
            conditions=[{"id": "total", "label": "total", "pass": False, "actual": 55}],
            detail={"ai_gate": "filtered"},
            thresholds_patch={"entry_min_total": 70},
        )
        self.assertEqual(merged["stages"]["ai_gate"]["status"], "failed")
        self.assertEqual(merged["thresholds"]["entry_min_total"], 70)


if __name__ == "__main__":
    unittest.main()
