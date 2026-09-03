"""Stock researcher using AI and Massive.com fundamental data."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from signals_bot.research.context import (
    ResearchContext,
    ResearchResult,
    build_research_context,
)
from signals_bot.research.massive_client import MassiveClient
from signals_bot.research.prompts import (
    RESEARCH_SYSTEM_PROMPT,
    build_research_user_prompt,
)

logger = logging.getLogger(__name__)


class StockResearcher:
    """AI-powered stock researcher using Massive.com data."""

    def __init__(
        self,
        massive_api_key: str | None = None,
        openai_api_key: str | None = None,
    ) -> None:
        self.massive_client = MassiveClient(api_key=massive_api_key)
        self.openai_api_key = openai_api_key or os.getenv("OPENAI_API_KEY", "")
        
        if not self.openai_api_key:
            logger.warning("OPENAI_API_KEY not set - research will use stub responses")

    def research_stock(
        self,
        ticker: str,
        technical_metrics: dict[str, float],
        *,
        model: str = "gpt-4",
        news_days_back: int = 7,
        news_limit: int = 20,
    ) -> ResearchResult:
        """Research a stock and generate AI recommendation.
        
        Args:
            ticker: Stock ticker symbol
            technical_metrics: Dict with current_price, ret_5d, ret_10d, vol_ratio, technical_score
            model: OpenAI model to use
            news_days_back: Days to look back for news
            news_limit: Max news articles
            
        Returns:
            ResearchResult with decision, confidence, and analysis
        """
        logger.info("Researching %s with AI model %s", ticker, model)
        
        context = build_research_context(
            ticker=ticker,
            massive_client=self.massive_client,
            news_days_back=news_days_back,
            news_limit=news_limit,
        )
        
        if not context.has_data():
            logger.warning("No research data collected for %s - returning WAIT", ticker)
            return self._stub_result_no_data(ticker, context, model)
        
        logger.info(
            "Research context for %s: %d news, %d risks, %d events",
            ticker,
            len(context.news),
            len(context.risk_factors),
            len(context.material_events),
        )
        
        user_prompt = build_research_user_prompt(
            ticker=ticker,
            context=context,
            technical_metrics=technical_metrics,
        )
        
        verdict, tokens, cost = self._call_openai(
            system_prompt=RESEARCH_SYSTEM_PROMPT,
            user_prompt=user_prompt,
            model=model,
        )
        
        return ResearchResult(
            ticker=ticker,
            decision=verdict.get("decision", "WAIT"),
            confidence=float(verdict.get("confidence", 50)),
            headline=verdict.get("headline", ""),
            catalysts=verdict.get("catalysts", []),
            red_flags=verdict.get("red_flags", []),
            supporting_text=verdict.get("supporting_text", ""),
            research_context=context,
            model_used=model,
            tokens_used=tokens,
            estimated_cost_usd=cost,
        )

    def _call_openai(
        self,
        system_prompt: str,
        user_prompt: str,
        model: str,
    ) -> tuple[dict[str, Any], int, float]:
        """Call OpenAI API with research prompts.
        
        Returns:
            Tuple of (verdict_dict, tokens_used, estimated_cost_usd)
        """
        if not self.openai_api_key:
            logger.warning("Using stub OpenAI response (no API key)")
            return self._stub_openai_response(), 0, 0.0
        
        try:
            import openai
            
            client = openai.OpenAI(api_key=self.openai_api_key)
            
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0.3,
            )
            
            verdict_text = response.choices[0].message.content or "{}"
            verdict = json.loads(verdict_text)
            
            tokens = response.usage.total_tokens if response.usage else 0
            cost = self._estimate_cost(model, response.usage)
            
            logger.info(
                "OpenAI research call: %s tokens, $%.4f estimated",
                tokens,
                cost,
            )
            
            return verdict, tokens, cost
            
        except ImportError:
            logger.error("openai package not installed - run: pip install openai")
            return self._stub_openai_response(), 0, 0.0
        except json.JSONDecodeError as e:
            logger.error("Failed to parse OpenAI JSON response: %s", e)
            return self._stub_openai_response(), 0, 0.0
        except Exception as e:
            logger.error("OpenAI API call failed: %s", e)
            return self._stub_openai_response(), 0, 0.0

    def _stub_openai_response(self) -> dict[str, Any]:
        """Stub response when OpenAI is unavailable."""
        return {
            "decision": "WAIT",
            "confidence": 50,
            "headline": "Research unavailable - OpenAI API not configured",
            "catalysts": [],
            "red_flags": ["Unable to perform AI analysis"],
            "supporting_text": "OpenAI API key not set or API call failed. Configure OPENAI_API_KEY to enable research.",
        }

    def _stub_result_no_data(
        self,
        ticker: str,
        context: ResearchContext,
        model: str,
    ) -> ResearchResult:
        """Stub result when no research data is available."""
        return ResearchResult(
            ticker=ticker,
            decision="WAIT",
            confidence=50.0,
            headline="Insufficient research data",
            catalysts=[],
            red_flags=["No recent news or filings available"],
            supporting_text="Unable to gather sufficient fundamental data for analysis. Massive.com API may not have data for this ticker.",
            research_context=context,
            model_used=model,
            tokens_used=0,
            estimated_cost_usd=0.0,
        )

    def _estimate_cost(self, model: str, usage: Any) -> float:
        """Estimate OpenAI API cost."""
        if not usage:
            return 0.0
        
        pricing = {
            "gpt-4": {"prompt": 0.03, "completion": 0.06},
            "gpt-4-turbo": {"prompt": 0.01, "completion": 0.03},
            "gpt-3.5-turbo": {"prompt": 0.0005, "completion": 0.0015},
            "gpt-5.4": {"prompt": 0.0025, "completion": 0.015},
            "gpt-5.4-mini": {"prompt": 0.00075, "completion": 0.0045},
        }
        
        rates = pricing.get(model, {"prompt": 0.01, "completion": 0.03})
        
        prompt_tokens = usage.prompt_tokens if hasattr(usage, "prompt_tokens") else 0
        completion_tokens = usage.completion_tokens if hasattr(usage, "completion_tokens") else 0
        
        prompt_cost = (prompt_tokens / 1000) * rates["prompt"]
        completion_cost = (completion_tokens / 1000) * rates["completion"]
        
        return prompt_cost + completion_cost


def research_stock(
    ticker: str,
    technical_metrics: dict[str, float],
    *,
    massive_api_key: str | None = None,
    openai_api_key: str | None = None,
    model: str = "gpt-4",
) -> ResearchResult:
    """Convenience function to research a stock.
    
    Args:
        ticker: Stock ticker symbol
        technical_metrics: Dict with current_price, ret_5d, ret_10d, vol_ratio, technical_score
        massive_api_key: Massive.com API key (or use MASSIVE_API_KEY env var)
        openai_api_key: OpenAI API key (or use OPENAI_API_KEY env var)
        model: OpenAI model name
        
    Returns:
        ResearchResult with AI analysis
    """
    researcher = StockResearcher(
        massive_api_key=massive_api_key,
        openai_api_key=openai_api_key,
    )
    
    return researcher.research_stock(
        ticker=ticker,
        technical_metrics=technical_metrics,
        model=model,
    )
