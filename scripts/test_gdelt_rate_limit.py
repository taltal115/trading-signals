import unittest
from unittest.mock import MagicMock, patch

from scripts.ai_stock_eval.extra_providers import (
    fetch_gdelt_headlines,
    merge_headline_titles,
    reset_gdelt_rate_limit_state_for_tests,
)


class GdeltRateLimitTests(unittest.TestCase):
    def setUp(self) -> None:
        reset_gdelt_rate_limit_state_for_tests()

    @patch.dict(
        "os.environ",
        {
            "USE_GDELT": "true",
            "GDELT_MAX_RETRIES": "1",
            "GDELT_RETRY_SECONDS": "0.01",
            "GDELT_COOLDOWN_SECONDS": "30",
            "GDELT_MIN_INTERVAL_SECONDS": "0",
        },
        clear=False,
    )
    @patch("scripts.ai_stock_eval.extra_providers.time.sleep")
    @patch("scripts.ai_stock_eval.extra_providers.requests.get")
    def test_retries_then_cools_down(self, get: MagicMock, sleep: MagicMock) -> None:
        limited = MagicMock()
        limited.status_code = 429
        limited.text = "Please limit requests to one every 5 seconds"
        get.return_value = limited

        first = fetch_gdelt_headlines("GTLB", limit=3)
        self.assertEqual(first, [])
        self.assertEqual(get.call_count, 2)
        self.assertTrue(sleep.called)

        get.reset_mock()
        second = fetch_gdelt_headlines("PRAA", limit=3)
        self.assertEqual(second, [])
        get.assert_not_called()  # cooldown skip

    @patch.dict(
        "os.environ",
        {
            "USE_GDELT": "true",
            "USE_NEWSAPI": "false",
            "GDELT_SKIP_IF_HEADLINES_GE": "5",
        },
        clear=False,
    )
    @patch("scripts.ai_stock_eval.extra_providers.fetch_gdelt_headlines")
    def test_skips_gdelt_when_finnhub_enough(self, gdelt: MagicMock) -> None:
        titles = [f"Headline {i}" for i in range(5)]
        out, status = merge_headline_titles(finnhub_titles=titles, ticker="GTLB", max_total=10)
        self.assertEqual(len(out), 5)
        self.assertTrue(status["finnhub_news_ok"])
        gdelt.assert_not_called()


if __name__ == "__main__":
    unittest.main()
