import unittest
from unittest.mock import MagicMock, patch

from scripts.ai_stock_eval.llm import OpenAIHttpError, call_openai_json


def _response(status: int, payload: dict, *, headers: dict | None = None) -> MagicMock:
    response = MagicMock()
    response.status_code = status
    response.headers = headers or {}
    response.url = "https://api.openai.com/v1/chat/completions"
    response.json.return_value = payload
    response.text = str(payload)
    response.raise_for_status.side_effect = (
        None if status < 400 else RuntimeError(f"HTTP {status}")
    )
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
    @patch("scripts.ai_stock_eval.llm.random.uniform", return_value=0.0)
    @patch("scripts.ai_stock_eval.llm.time.sleep")
    @patch("scripts.ai_stock_eval.llm.requests.post")
    def test_retries_rate_limit_and_honors_retry_after(
        self, post: MagicMock, sleep: MagicMock, _uniform: MagicMock
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
            "OPENAI_RETRY_BASE_SECONDS": "7",
        },
        clear=False,
    )
    @patch("scripts.ai_stock_eval.llm.random.uniform", return_value=0.0)
    @patch("scripts.ai_stock_eval.llm.time.sleep")
    @patch("scripts.ai_stock_eval.llm.requests.post")
    def test_retries_using_message_try_again_in(
        self, post: MagicMock, sleep: MagicMock, _uniform: MagicMock
    ) -> None:
        post.side_effect = [
            _response(
                429,
                {
                    "error": {
                        "type": "rate_limit_error",
                        "message": "Rate limit reached. Please try again in 12.5s.",
                    }
                },
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

        call_openai_json(system="system", user="user")
        sleep.assert_called_once_with(12.5)

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
            {"error": {"type": "insufficient_quota", "message": "You exceeded your current quota"}},
        )

        with self.assertRaises(OpenAIHttpError) as ctx:
            call_openai_json(system="system", user="user")

        self.assertEqual(post.call_count, 1)
        sleep.assert_not_called()
        self.assertTrue(ctx.exception.is_insufficient_quota)
        self.assertFalse(ctx.exception.is_rate_limit)

    @patch.dict(
        "os.environ",
        {
            "OPENAI_API_KEY": "test-key",
            "OPENAI_MAX_RETRIES": "0",
        },
        clear=False,
    )
    @patch("scripts.ai_stock_eval.llm.requests.post")
    def test_exhausted_rate_limit_raises_typed_error(self, post: MagicMock) -> None:
        post.return_value = _response(
            429,
            {"error": {"type": "rate_limit_error", "message": "Too many requests"}},
        )

        with self.assertRaises(OpenAIHttpError) as ctx:
            call_openai_json(system="system", user="user")

        self.assertTrue(ctx.exception.is_rate_limit)


if __name__ == "__main__":
    unittest.main()
