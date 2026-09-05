"""Massive.com API client wrapper for financial data research."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class NewsArticle:
    """Financial news article with sentiment."""
    
    title: str
    url: str
    published_utc: datetime
    description: str
    sentiment: dict[str, Any] | None
    tickers: list[str]
    publisher: dict[str, str] | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "url": self.url,
            "published": self.published_utc.isoformat(),
            "description": self.description[:300] if self.description else "",
            "sentiment": self.sentiment,
        }


@dataclass
class FilingSection:
    """SEC filing section text."""
    
    ticker: str
    filing_type: str
    filing_date: date
    period_end: date | None
    section: str
    text: str
    filing_url: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "filing_type": self.filing_type,
            "filing_date": self.filing_date.isoformat(),
            "period_end": self.period_end.isoformat() if self.period_end else None,
            "section": self.section,
            "text": self.text[:1000] if self.text else "",
            "url": self.filing_url,
        }


@dataclass
class RiskFactor:
    """Structured risk factor from SEC filings."""
    
    ticker: str
    filing_date: date
    primary_category: str
    secondary_category: str
    tertiary_category: str
    supporting_text: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "filing_date": self.filing_date.isoformat(),
            "category": f"{self.primary_category} / {self.secondary_category}",
            "detail": self.tertiary_category,
            "text": self.supporting_text[:300] if self.supporting_text else "",
        }


@dataclass
class MaterialEvent:
    """8-K material event disclosure."""
    
    ticker: str
    filing_date: date
    accession_number: str
    text: str
    filing_url: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "filing_date": self.filing_date.isoformat(),
            "text": self.text[:500] if self.text else "",
            "url": self.filing_url,
        }


class MassiveClient:
    """Client for Massive.com financial data API.
    
    Provides access to:
    - News articles with sentiment analysis
    - SEC filings (10-K, 10-Q, 8-K)
    - Risk factors
    - Financial statements
    """

    def __init__(self, api_key: str | None = None) -> None:
        self.api_key = api_key or os.getenv("MASSIVE_API_KEY", "")
        if not self.api_key:
            logger.warning("MASSIVE_API_KEY not set - research features will be limited")
        
        self._client = None
        self._init_client()

    def _init_client(self) -> None:
        """Initialize Massive SDK client."""
        if not self.api_key:
            return
        
        try:
            from massive import RESTClient
            self._client = RESTClient(self.api_key)
            logger.info("Massive client initialized successfully")
        except ImportError:
            logger.error("massive-py not installed - run: pip install massive-py")
        except Exception as e:
            logger.error("Failed to initialize Massive client: %s", e)

    def get_news(
        self,
        ticker: str,
        days_back: int = 7,
        limit: int = 20,
    ) -> list[NewsArticle]:
        """Fetch recent news articles with sentiment for a ticker.
        
        Args:
            ticker: Stock ticker symbol
            days_back: Number of days to look back
            limit: Maximum articles to return
            
        Returns:
            List of NewsArticle objects
        """
        if not self._client:
            logger.warning("Massive client not initialized - returning empty news")
            return []

        try:
            cutoff = (datetime.now() - timedelta(days=days_back)).isoformat() + "Z"
            
            response = self._client.reference.get_news(
                ticker=ticker,
                published_utc_gte=cutoff,
                limit=limit,
                sort="published_utc",
                order="desc",
            )
            
            articles = []
            for item in response.get("results", []):
                try:
                    pub_str = item.get("published_utc", "")
                    pub_dt = datetime.fromisoformat(pub_str.replace("Z", "+00:00"))
                    
                    articles.append(
                        NewsArticle(
                            title=item.get("title", ""),
                            url=item.get("article_url", ""),
                            published_utc=pub_dt,
                            description=item.get("description", ""),
                            sentiment=item.get("insights"),
                            tickers=item.get("tickers", []),
                            publisher=item.get("publisher"),
                        )
                    )
                except (ValueError, KeyError, TypeError) as e:
                    logger.warning("Skipping malformed news item: %s", e)
                    continue
            
            logger.info("Fetched %d news articles for %s", len(articles), ticker)
            return articles
            
        except Exception as e:
            logger.error("Failed to fetch news for %s: %s", ticker, e)
            return []

    def get_risk_factors(
        self,
        ticker: str,
        limit: int = 10,
    ) -> list[RiskFactor]:
        """Fetch structured risk factors from recent SEC filings.
        
        Args:
            ticker: Stock ticker symbol
            limit: Maximum risk factors to return
            
        Returns:
            List of RiskFactor objects
        """
        if not self._client:
            logger.warning("Massive client not initialized - returning empty risks")
            return []

        try:
            response = self._client.stocks.filings.get_risk_factors(
                ticker=ticker,
                limit=limit,
                sort="filing_date",
                order="desc",
            )
            
            risks = []
            for item in response.get("results", []):
                try:
                    filing_date_str = item.get("filing_date", "")
                    filing_dt = datetime.strptime(filing_date_str, "%Y-%m-%d").date()
                    
                    risks.append(
                        RiskFactor(
                            ticker=ticker,
                            filing_date=filing_dt,
                            primary_category=item.get("primary_category", ""),
                            secondary_category=item.get("secondary_category", ""),
                            tertiary_category=item.get("tertiary_category", ""),
                            supporting_text=item.get("supporting_text", ""),
                        )
                    )
                except (ValueError, KeyError, TypeError) as e:
                    logger.warning("Skipping malformed risk factor: %s", e)
                    continue
            
            logger.info("Fetched %d risk factors for %s", len(risks), ticker)
            return risks
            
        except Exception as e:
            logger.error("Failed to fetch risk factors for %s: %s", ticker, e)
            return []

    def get_material_events(
        self,
        ticker: str,
        days_back: int = 30,
        limit: int = 5,
    ) -> list[MaterialEvent]:
        """Fetch recent 8-K material event disclosures.
        
        Args:
            ticker: Stock ticker symbol
            days_back: Number of days to look back
            limit: Maximum events to return
            
        Returns:
            List of MaterialEvent objects
        """
        if not self._client:
            logger.warning("Massive client not initialized - returning empty events")
            return []

        try:
            cutoff = (datetime.now() - timedelta(days=days_back)).date()
            
            response = self._client.stocks.filings.get_8k_text(
                ticker=ticker,
                filing_date_gte=cutoff.isoformat(),
                limit=limit,
            )
            
            events = []
            for item in response.get("results", []):
                try:
                    filing_date_str = item.get("filing_date", "")
                    filing_dt = datetime.strptime(filing_date_str, "%Y-%m-%d").date()
                    
                    events.append(
                        MaterialEvent(
                            ticker=ticker,
                            filing_date=filing_dt,
                            accession_number=item.get("accession_number", ""),
                            text=item.get("text", ""),
                            filing_url=item.get("filing_url", ""),
                        )
                    )
                except (ValueError, KeyError, TypeError) as e:
                    logger.warning("Skipping malformed 8-K event: %s", e)
                    continue
            
            logger.info("Fetched %d material events for %s", len(events), ticker)
            return events
            
        except Exception as e:
            logger.error("Failed to fetch material events for %s: %s", ticker, e)
            return []

    def get_10k_sections(
        self,
        ticker: str,
        sections: list[str] | None = None,
        limit: int = 1,
    ) -> list[FilingSection]:
        """Fetch specific sections from recent 10-K filings.
        
        Args:
            ticker: Stock ticker symbol
            sections: List of section names (e.g., ['business', 'risk_factors'])
            limit: Maximum filings to fetch
            
        Returns:
            List of FilingSection objects
        """
        if not self._client:
            logger.warning("Massive client not initialized - returning empty 10-K sections")
            return []

        if sections is None:
            sections = ["business", "risk_factors"]

        try:
            all_sections = []
            for section in sections:
                response = self._client.stocks.filings.get_10k_sections(
                    ticker=ticker,
                    section=section,
                    limit=limit,
                    sort="filing_date",
                    order="desc",
                )
                
                for item in response.get("results", []):
                    try:
                        filing_date_str = item.get("filing_date", "")
                        filing_dt = datetime.strptime(filing_date_str, "%Y-%m-%d").date()
                        
                        period_end_str = item.get("period_end")
                        period_end_dt = None
                        if period_end_str:
                            period_end_dt = datetime.strptime(period_end_str, "%Y-%m-%d").date()
                        
                        all_sections.append(
                            FilingSection(
                                ticker=ticker,
                                filing_type="10-K",
                                filing_date=filing_dt,
                                period_end=period_end_dt,
                                section=item.get("section", ""),
                                text=item.get("text", ""),
                                filing_url=item.get("filing_url", ""),
                            )
                        )
                    except (ValueError, KeyError, TypeError) as e:
                        logger.warning("Skipping malformed 10-K section: %s", e)
                        continue
            
            logger.info("Fetched %d 10-K sections for %s", len(all_sections), ticker)
            return all_sections
            
        except Exception as e:
            logger.error("Failed to fetch 10-K sections for %s: %s", ticker, e)
            return []
