import inspect
import unittest

from scripts.research_coa import build_course_of_action
from scripts.research_profit_hold_cohort import run_cohort


class ResearchCoaTests(unittest.TestCase):
    def test_empty_actionable_is_critical(self) -> None:
        summary = {
            "n_unique_buys_loaded": 0,
            "n_mature_hold": 0,
            "actionable_only": True,
            "overall_at_hold": {"n": 0},
            "by_ai_gate": [],
        }
        coa = build_course_of_action(summary, since="2026-08-04", actionable_only=True)
        self.assertTrue(coa["items"])
        self.assertEqual(coa["items"][0]["priority"], "critical")
        self.assertIn("pro_model", str(coa["items"][0]["suggested_changes"]))

    def test_lottery_vol_bucket_keeps_hard_reject(self) -> None:
        summary = {
            "n_unique_buys_loaded": 9,
            "n_mature_hold": 9,
            "actionable_only": False,
            "overall_at_hold": {
                "n": 9,
                "win_rate_pct": 88.9,
                "avg_ret_pct": 5.0,
                "profit_factor": 2.76,
            },
            "by_vol_ratio": [
                {
                    "bucket": ">=5x",
                    "n": 1,
                    "losses": 1,
                    "win_rate_pct": 0,
                    "avg_ret_pct": -25.0,
                    "profit_factor": 0.0,
                }
            ],
            "by_ai_gate": [{"bucket": "skipped", "n": 6}],
        }
        coa = build_course_of_action(summary, since="2026-08-04", actionable_only=False)
        titles = " ".join(str(i.get("title")) for i in coa["items"])
        self.assertIn("hard-reject", titles.lower())


class RunCohortLibraryTests(unittest.TestCase):
    def test_run_cohort_does_not_read_cli_args(self) -> None:
        """UI / GHA call run_cohort() without argparse — do not use args.* here."""
        src = inspect.getsource(run_cohort)
        self.assertNotIn("args.", src)
        self.assertIn("include_immature", src)


if __name__ == "__main__":
    unittest.main()
