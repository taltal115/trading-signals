# Research Module

AI-powered fundamental analysis using Massive.com financial data.

## Quick Start

```python
from signals_bot.research import research_stock

result = research_stock(
    ticker="AAPL",
    technical_metrics={
        "current_price": 175.0,
        "ret_5d": 12.0,
        "ret_10d": 18.0,
        "vol_ratio": 3.2,
        "technical_score": 82.0,
    },
)

print(f"Decision: {result.decision}")
print(f"Confidence: {result.confidence}")
print(f"Catalysts: {result.catalysts}")
```

## Components

- **massive_client.py**: Massive.com API wrapper
- **context.py**: Research data aggregation
- **prompts.py**: AI synthesis prompts
- **researcher.py**: Main orchestrator

## Environment Variables

Required:
- `MASSIVE_API_KEY` - Your Massive.com API key
- `OPENAI_API_KEY` - OpenAI API key for synthesis

## Data Sources

From Massive.com ($30/month):
- News with sentiment analysis
- SEC 10-K/10-Q/8-K filings
- Risk factors (structured)
- Material events

## See Also

- [Full Documentation](../../../docs/massive-research-layer.md)
- [Test Script](../../../scripts/run_research_smoke.py)
