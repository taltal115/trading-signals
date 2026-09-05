"""Research context aggregation and result structures."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

from signals_bot.research.massive_client import (
    FilingSection,
    MaterialEvent,
    MassiveClient,
    NewsArticle,
    RiskFactor,
)


@dataclass
class ResearchContext:
    """Aggregated research data for a stock."""
    
    ticker: str
    collected_at: datetime
    news: list[NewsArticle]
    risk_factors: list[RiskFactor]
    material_events: list[MaterialEvent]
    filing_sections: list[FilingSection]
    
    def to_dict(self) -> dict[str, Any]:
        return {
            "ticker": self.ticker,
            "collected_at": self.collected_at.isoformat(),
            "news_count": len(self.news),
            "news": [n.to_dict() for n in self.news[:10]],
            "risk_factors_count": len(self.risk_factors),
            "risk_factors": [r.to_dict() for r in self.risk_factors[:5]],
            "material_events_count": len(self.material_events),
            "material_events": [e.to_dict() for e in self.material_events[:3]],
            "filing_sections_count": len(self.filing_sections),
        }

    def has_data(self) -> bool:
        """Check if any research data was collected."""
        return bool(
            self.news or self.risk_factors or self.material_events or self.filing_sections
        )

    def summary_text(self) -> str:
        """Generate human-readable summary of research context."""
        lines = [
            f"Research Context for {self.ticker}",
            f"Collected: {self.collected_at.strftime('%Y-%m-%d %H:%M UTC')}",
            "",
            f"News Articles: {len(self.news)}",
        ]
        
        for article in self.news[:3]:
            lines.append(f"  • {article.title} ({article.published_utc.strftime('%Y-%m-%d')})")
        
        if len(self.news) > 3:
            lines.append(f"  ... and {len(self.news) - 3} more")
        
        lines.append(f"\nRisk Factors: {len(self.risk_factors)}")
        for risk in self.risk_factors[:3]:
            lines.append(f"  • {risk.primary_category}: {risk.tertiary_category}")
        
        lines.append(f"\nMaterial Events (8-K): {len(self.material_events)}")
        for event in self.material_events[:2]:
            preview = event.text[:100] + "..." if len(event.text) > 100 else event.text
            lines.append(f"  • {event.filing_date}: {preview}")
        
        return "\n".join(lines)


@dataclass
class ResearchResult:
    """AI-synthesized research result for a stock."""
    
    ticker: str
    decision: str
    confidence: float
    headline: str
    catalysts: list[str]
    red_flags: list[str]
    supporting_text: str
    research_context: ResearchContext
    model_used: str
    tokens_used: int
    estimated_cost_usd: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "ticker": self.ticker,
            "decision": self.decision,
            "confidence": self.confidence,
            "headline": self.headline,
            "catalysts": self.catalysts,
            "red_flags": self.red_flags,
            "supporting_text": self.supporting_text,
            "research_summary": self.research_context.to_dict(),
            "model_used": self.model_used,
            "tokens_used": self.tokens_used,
            "estimated_cost_usd": self.estimated_cost_usd,
        }


def build_research_context(
    ticker: str,
    massive_client: MassiveClient,
    *,
    news_days_back: int = 7,
    news_limit: int = 20,
    events_days_back: int = 30,
    risk_limit: int = 10,
) -> ResearchContext:
    """Build aggregated research context for a stock.
    
    Args:
        ticker: Stock ticker symbol
        massive_client: Initialized Massive API client
        news_days_back: Days to look back for news
        news_limit: Max news articles to fetch
        events_days_back: Days to look back for 8-K events
        risk_limit: Max risk factors to fetch
        
    Returns:
        ResearchContext with all aggregated data
    """
    news = massive_client.get_news(
        ticker=ticker,
        days_back=news_days_back,
        limit=news_limit,
    )
    
    risk_factors = massive_client.get_risk_factors(
        ticker=ticker,
        limit=risk_limit,
    )
    
    material_events = massive_client.get_material_events(
        ticker=ticker,
        days_back=events_days_back,
        limit=5,
    )
    
    filing_sections = massive_client.get_10k_sections(
        ticker=ticker,
        sections=["business"],
        limit=1,
    )
    
    return ResearchContext(
        ticker=ticker,
        collected_at=datetime.utcnow(),
        news=news,
        risk_factors=risk_factors,
        material_events=material_events,
        filing_sections=filing_sections,
    )
