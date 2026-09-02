"""Integration of Massive.com research layer into AI stock evaluation."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def research_enabled(cfg: Any) -> bool:
    """Check if research is enabled in config."""
    research_cfg = getattr(cfg, "research", None)
    if research_cfg is None:
        return False
    return bool(getattr(research_cfg, "enabled", False))


def enrich_context_with_research(
    ticker: str,
    context: Any,
    cfg: Any,
) -> dict[str, Any]:
    """Enrich AI evaluation context with Massive.com research data.
    
    Args:
        ticker: Stock ticker symbol
        context: Existing evaluation context
        cfg: AppConfig with research settings
        
    Returns:
        Dict with research_result and enriched context
    """
    if not research_enabled(cfg):
        return {"research_available": False}
    
    research_cfg = cfg.research
    
    try:
        from signals_bot.research import StockResearcher
        
        logger.info("Running Massive.com research for %s", ticker)
        
        technical_metrics = extract_technical_metrics(context)
        
        researcher = StockResearcher()
        result = researcher.research_stock(
            ticker=ticker,
            technical_metrics=technical_metrics,
            model=research_cfg.model,
            news_days_back=research_cfg.news_days_back,
            news_limit=research_cfg.news_limit,
        )
        
        logger.info(
            "Research for %s: decision=%s confidence=%.0f catalysts=%d flags=%d",
            ticker,
            result.decision,
            result.confidence,
            len(result.catalysts),
            len(result.red_flags),
        )
        
        return {
            "research_available": True,
            "research_result": result.to_dict(),
            "research_decision": result.decision,
            "research_confidence": result.confidence,
            "research_headline": result.headline,
        }
        
    except ImportError as e:
        logger.warning("Research module not available: %s", e)
        if not research_cfg.fallback_on_failure:
            raise
        return {"research_available": False, "research_error": "Module not installed"}
    except Exception as e:
        logger.error("Research failed for %s: %s", ticker, e)
        if not research_cfg.fallback_on_failure:
            raise
        return {"research_available": False, "research_error": str(e)}


def extract_technical_metrics(context: Any) -> dict[str, float]:
    """Extract technical metrics from evaluation context for research.
    
    Args:
        context: Evaluation context with hist, signal_row, etc.
        
    Returns:
        Dict with current_price, ret_5d, ret_10d, vol_ratio, technical_score
    """
    metrics = {}
    
    if hasattr(context, "hist") and context.hist is not None and not context.hist.empty:
        hist = context.hist
        metrics["current_price"] = float(hist["close"].iloc[-1])
        
        if len(hist) >= 5:
            ret_5d = float(hist["close"].pct_change(5).iloc[-1] * 100.0)
            metrics["ret_5d"] = ret_5d
        
        if len(hist) >= 10:
            ret_10d = float(hist["close"].pct_change(10).iloc[-1] * 100.0)
            metrics["ret_10d"] = ret_10d
        
        if "volume" in hist.columns and len(hist) >= 20:
            vol = float(hist["volume"].iloc[-1])
            avg20_vol = float(hist["volume"].rolling(20).mean().iloc[-1])
            if avg20_vol > 0:
                metrics["vol_ratio"] = vol / avg20_vol
    
    if hasattr(context, "signal_row") and context.signal_row:
        row = context.signal_row
        if isinstance(row, dict):
            metrics["technical_score"] = float(row.get("score", 0.0))
    
    return metrics


def adjust_ai_gate_with_research(
    ai_gate: str,
    recommendation: dict[str, Any],
    research_data: dict[str, Any],
    cfg: Any,
) -> tuple[str, dict[str, Any]]:
    """Adjust AI gate decision based on research findings.
    
    Args:
        ai_gate: Original AI gate decision (passed/filtered/pending)
        recommendation: Original AI recommendation
        research_data: Research enrichment data
        cfg: AppConfig with research settings
        
    Returns:
        Tuple of (adjusted_ai_gate, enriched_recommendation)
    """
    if not research_data.get("research_available"):
        return ai_gate, recommendation
    
    research_cfg = cfg.research
    research_decision = research_data.get("research_decision", "WAIT")
    research_confidence = research_data.get("research_confidence", 50.0)
    
    enriched = dict(recommendation)
    enriched["research"] = {
        "decision": research_decision,
        "confidence": research_confidence,
        "headline": research_data.get("research_headline", ""),
    }
    
    if research_confidence < research_cfg.min_research_confidence:
        logger.info(
            "Research confidence %.0f < threshold %.0f - not adjusting AI gate",
            research_confidence,
            research_cfg.min_research_confidence,
        )
        return ai_gate, enriched
    
    weight = research_cfg.research_weight
    
    if research_decision == "SELL" and research_confidence >= 80:
        if ai_gate == "passed":
            logger.warning(
                "Research flagged SELL with high confidence (%.0f) - downgrading to filtered",
                research_confidence,
            )
            return "filtered", enriched
    
    if research_decision == "BUY" and research_confidence >= 80:
        if ai_gate == "filtered":
            logger.info(
                "Research flagged BUY with high confidence (%.0f) - considering upgrade",
                research_confidence,
            )
    
    return ai_gate, enriched
