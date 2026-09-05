"""Prompts for AI research synthesis."""

from __future__ import annotations

from typing import Any

RESEARCH_SYSTEM_PROMPT = """You are an expert stock market analyst specializing in short-term (1-2 week) breakout momentum trading.

Your task is to analyze fundamental and news data to determine if a stock that passed technical breakout filters is a good short-term entry candidate.

Focus on:
1. Recent catalysts (news, earnings, product launches, partnerships)
2. Material events from SEC 8-K filings
3. Risk factors that could derail a short-term momentum move
4. Sector tailwinds or headwinds
5. Unusual volume or price action drivers
6. Technical breakout confirmation from fundamental perspective

Return a JSON object with:
{
  "decision": "BUY" | "WAIT" | "SELL",
  "confidence": 0-100 (integer),
  "headline": "One-line summary of the opportunity or concern",
  "catalysts": ["Bullet point", "Another catalyst"],
  "red_flags": ["Concern or risk", "Another red flag"],
  "supporting_text": "2-3 sentence synthesis of your analysis"
}

Guidelines:
- BUY: Strong positive catalysts, low immediate risk, momentum should continue
- WAIT: Mixed signals, need more data, or no clear catalyst
- SELL: Red flags outweigh catalysts, or fundamental concerns that could kill momentum
- Confidence: How certain are you? 90+ = very high conviction, 70-80 = moderate, <70 = low
"""

RESEARCH_USER_TEMPLATE = """Analyze {ticker} for short-term (1-2 week) breakout potential.

Technical Context:
- Current Price: ${current_price:.2f}
- 5-day return: {ret_5d:+.1f}%
- 10-day return: {ret_10d:+.1f}%
- Volume ratio (vs 20-day avg): {vol_ratio:.1f}x
- Technical score: {technical_score:.0f}/100

Research Data:

NEWS ({news_count} articles, last {news_days} days):
{news_summary}

RISK FACTORS ({risk_count} from recent filings):
{risk_summary}

MATERIAL EVENTS ({events_count} 8-K filings, last 30 days):
{events_summary}

BUSINESS CONTEXT:
{business_summary}

Based on this fundamental research, should we enter this breakout trade?
Focus on: recent catalysts, momentum sustainability, and short-term (1-2 week) risk/reward.

Return your analysis as a JSON object following the schema in the system prompt.
"""


def build_research_user_prompt(
    ticker: str,
    context: Any,
    technical_metrics: dict[str, float],
) -> str:
    """Build user prompt from research context and technical metrics.
    
    Args:
        ticker: Stock ticker
        context: ResearchContext object
        technical_metrics: Dict with current_price, ret_5d, ret_10d, vol_ratio, technical_score
        
    Returns:
        Formatted user prompt string
    """
    news_summary = _format_news_summary(context.news)
    risk_summary = _format_risk_summary(context.risk_factors)
    events_summary = _format_events_summary(context.material_events)
    business_summary = _format_business_summary(context.filing_sections)
    
    return RESEARCH_USER_TEMPLATE.format(
        ticker=ticker,
        current_price=technical_metrics.get("current_price", 0.0),
        ret_5d=technical_metrics.get("ret_5d", 0.0),
        ret_10d=technical_metrics.get("ret_10d", 0.0),
        vol_ratio=technical_metrics.get("vol_ratio", 0.0),
        technical_score=technical_metrics.get("technical_score", 0.0),
        news_count=len(context.news),
        news_days=7,
        news_summary=news_summary,
        risk_count=len(context.risk_factors),
        risk_summary=risk_summary,
        events_count=len(context.material_events),
        events_summary=events_summary,
        business_summary=business_summary,
    )


def _format_news_summary(news: list[Any]) -> str:
    """Format news articles for prompt."""
    if not news:
        return "(No recent news found)"
    
    lines = []
    for i, article in enumerate(news[:10], 1):
        date_str = article.published_utc.strftime("%Y-%m-%d")
        sentiment_text = ""
        if article.sentiment:
            sent_label = article.sentiment.get("sentiment")
            if sent_label:
                sentiment_text = f" [{sent_label}]"
        
        title = article.title[:150] + "..." if len(article.title) > 150 else article.title
        lines.append(f"{i}. {date_str}{sentiment_text}: {title}")
        
        if article.description:
            desc = article.description[:200] + "..." if len(article.description) > 200 else article.description
            lines.append(f"   {desc}")
    
    return "\n".join(lines)


def _format_risk_summary(risks: list[Any]) -> str:
    """Format risk factors for prompt."""
    if not risks:
        return "(No recent risk factors found)"
    
    lines = []
    for i, risk in enumerate(risks[:5], 1):
        date_str = risk.filing_date.strftime("%Y-%m-%d")
        category = f"{risk.primary_category} / {risk.secondary_category}"
        detail = risk.tertiary_category
        text = risk.supporting_text[:200] + "..." if len(risk.supporting_text) > 200 else risk.supporting_text
        
        lines.append(f"{i}. [{date_str}] {category}: {detail}")
        lines.append(f"   {text}")
    
    return "\n".join(lines)


def _format_events_summary(events: list[Any]) -> str:
    """Format material events for prompt."""
    if not events:
        return "(No recent 8-K events found)"
    
    lines = []
    for i, event in enumerate(events[:3], 1):
        date_str = event.filing_date.strftime("%Y-%m-%d")
        text = event.text[:400] + "..." if len(event.text) > 400 else event.text
        
        lines.append(f"{i}. [{date_str}] Material Event:")
        lines.append(f"   {text}")
    
    return "\n".join(lines)


def _format_business_summary(sections: list[Any]) -> str:
    """Format 10-K business section for prompt."""
    if not sections:
        return "(No recent 10-K business description available)"
    
    section = sections[0]
    text = section.text[:800] + "..." if len(section.text) > 800 else section.text
    
    return f"[From 10-K filed {section.filing_date.strftime('%Y-%m-%d')}]\n{text}"
