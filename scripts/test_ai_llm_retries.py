import unittest
from unittest.mock import MagicMock, patch

from scripts.ai_stock_eval.llm import call_openai_json


def _response(status: int, payload: dict, *, headers: dict | None = None) -> MagicMock:
    response = MagicMock()
    response.status_code = status
    response.headers = headers or {}
    response.json.return_value = payload
    response.raise_for_status.side_effect = (
        None if status < 400 else RuntimeError(f"HTTP {status}")
    )
    if status < 400:
        response.text = '{"action":"WAIT"}'
    return response


class OpenAiRetryTests(unittest.TestCase):
    @patch.dict(
        "os.environ",
        {
            "OPENAI_API_KEY": "test-key",
            "OPENAI_MAX_RETRIES": "2",
            "OPENAI_RETRY_BASE_SECONDS": "7",
        },
        clear=False,
    )
    @patch("scripts.ai_stock_eval.llm.time.sleep")
    @patch("scripts.ai_stock_eval.llm.requests.post")
    def test_retries_rate_limit_and_honors_retry_after(
        self, post: MagicMock, sleep: MagicMock
    ) -> None:
        post.side_effect = [
            _response(
                429,
                {"error": {"type": "rate_limit_error"}},
                headers={"Retry-After": "3"},
            ),
            _response(
                200,
                {
                    "model": "gpt-5.4",
                    "choices": [{"message": {"content": '{"action":"WAIT"}'}}],
                    "usage": {},
                },
            ),
        ]

        verdict, _usage, _raw = call_openai_json(system="system", user="user")

        self.assertEqual(verdict["action"], "WAIT")
        self.assertEqual(post.call_count, 2)
        sleep.assert_called_once_with(3.0)

    @patch.dict(
        "os.environ",
        {
            "OPENAI_API_KEY": "test-key",
            "OPENAI_MAX_RETRIES": "2",
        },
        clear=False,
    )
    @patch("scripts.ai_stock_eval.llm.time.sleep")
    @patch("scripts.ai_stock_eval.llm.requests.post")
    def test_does_not_retry_insufficient_quota(
        self, post: MagicMock, sleep: MagicMock
    ) -> None:
        post.return_value = _response(
            429,
            {"error": {"type": "insufficient_quota"}},
        )

        with self.assertRaises(RuntimeError):
            call_openai_json(system="system", user="user")

        self.assertEqual(post.call_count, 1)
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
