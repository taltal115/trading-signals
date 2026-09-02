# Massive.com AI Research Layer

## Overview

The Massive.com AI Research Layer enhances the trading signals bot with fundamental analysis powered by real-time financial data and AI synthesis. Instead of relying solely on technical breakout/momentum indicators, the system now researches stocks using:

- **News articles** with sentiment analysis
- **SEC filings** (10-K, 10-Q, 8-K) in AI-ready format
- **Risk factors** with structured categorization
- **Material events** from 8-K disclosures

This data is synthesized by an LLM to determine if a technical breakout setup has fundamental support for a 1-2 week momentum trade.

## Architecture

```
Signal Scanner (Technical)
         ↓
   Hard Filters
         ↓
   Top-N BUYs
         ↓
┌────────────────────────┐
│  Research Layer        │
│  (Massive.com data)    │
│                        │
│  1. Fetch news         │
│  2. Fetch SEC filings  │
│  3. Fetch risk factors │
│  4. AI synthesis       │
└────────────────────────┘
         ↓
   Existing AI Gate
         ↓
  Actionable Signals
```

## Configuration

The research layer is configured in `config.yaml` under the `research:` section:

```yaml
research:
  enabled: false  # Set to true to enable (requires MASSIVE_API_KEY)
  max_research_per_run: 5  # Max signals to research per scan
  model: gpt-5.4  # OpenAI model for research synthesis
  news_days_back: 7  # News lookback period
  news_limit: 20  # Max news articles per ticker
  events_days_back: 30  # 8-K events lookback
  risk_limit: 10  # Max risk factors to fetch
  cache_hours: 24  # Cache research results
  research_weight: 0.3  # Weight in final decision (0.0-1.0)
  min_research_confidence: 70  # Min confidence to affect AI gate
  fallback_on_failure: true  # Continue without research if API fails
```

## Environment Variables

Required:
- `MASSIVE_API_KEY` - Your Massive.com API key ($30/month plan)
- `OPENAI_API_KEY` - OpenAI API key for AI synthesis

Optional:
- `MASSIVE_BASE_URL` - Custom Massive API endpoint (default: https://api.massive.com)

Add to `.env`:
```bash
MASSIVE_API_KEY=your_massive_key_here
OPENAI_API_KEY=your_openai_key_here
```

## Usage

### 1. Enable Research Layer

Edit `config.yaml`:
```yaml
research:
  enabled: true
  max_research_per_run: 5
```

### 2. Run Normal Scan

The research layer automatically enriches top BUY signals:

```bash
./run.sh
```

The scan will:
1. Generate technical BUY signals as usual
2. Research top 5 BUYs using Massive.com data
3. Synthesize research with AI
4. Adjust AI gate based on fundamental findings
5. Post actionable signals to Slack/Firestore

### 3. Standalone Research Testing

Test research on a specific ticker:

```bash
# Basic usage
python scripts/test_research.py AAPL

# With custom parameters
python scripts/test_research.py TSLA \
  --model gpt-5.4 \
  --news-days 14 \
  --price 250.0 \
  --ret-5d 15.0 \
  --vol-ratio 4.2

# Fetch data only (no AI)
python scripts/test_research.py NVDA --no-ai --json

# Verbose logging
python scripts/test_research.py MSFT -v
```

## Module Structure

```
src/signals_bot/research/
├── __init__.py              # Public API exports
├── massive_client.py        # Massive.com API wrapper
├── context.py               # Research data aggregation
├── prompts.py               # AI synthesis prompts
└── researcher.py            # Main research orchestrator

scripts/ai_stock_eval/
└── research_integration.py  # Integration with AI eval pipeline
```

## How It Works

### Step 1: Data Collection

For each top-ranked BUY signal, the system fetches:

**News (last 7 days)**
- Title, description, URL
- Published date
- Sentiment analysis (positive/negative/neutral)
- Source publisher

**SEC Filings**
- 10-K business description (latest annual)
- 8-K material events (last 30 days)
- Structured risk factors with categories

**Example Data**:
```python
{
  "news": [
    {
      "title": "Company X Announces Q3 Beat",
      "sentiment": "positive",
      "published": "2026-09-01",
    }
  ],
  "risk_factors": [
    {
      "category": "Market & Competition / Regulatory",
      "text": "Subject to FDA approval delays..."
    }
  ],
  "material_events": [
    {
      "filing_date": "2026-08-28",
      "text": "Item 5.02: Departure of CEO..."
    }
  ]
}
```

### Step 2: AI Synthesis

The research data + technical context is sent to an LLM with this prompt structure:

**System Prompt**:
> You are an expert stock analyst for short-term (1-2 week) breakout momentum trading.
> Analyze fundamental data to determine if a technical breakout has catalyst support.

**User Prompt**:
> Ticker: AAPL
> Technical: +15% 5d, 3.5x volume, score 85/100
> 
> News: [recent articles]
> Risks: [SEC risk factors]
> Events: [8-K material events]
> 
> Should we enter this breakout trade?

**AI Response**:
```json
{
  "decision": "BUY",
  "confidence": 85,
  "headline": "Strong earnings beat + product launch catalyst",
  "catalysts": [
    "Q3 EPS beat by 12%",
    "New iPhone pre-orders up 40% YoY"
  ],
  "red_flags": [
    "Supply chain concerns in 8-K"
  ],
  "supporting_text": "Fundamental momentum aligns with technical breakout..."
}
```

### Step 3: AI Gate Adjustment

The research result adjusts the final AI gate decision:

| Research Decision | Research Confidence | AI Gate | Action |
|-------------------|---------------------|---------|--------|
| SELL | ≥80 | passed | Downgrade to filtered |
| BUY | ≥80 | filtered | Consider upgrade |
| WAIT | Any | Any | No change |
| Any | <70 | Any | No change (low confidence) |

## Data Sources

### Massive.com Endpoints Used

1. **News API** (`/v2/reference/news`)
   - Financial news from major sources
   - Sentiment analysis included
   - Free tier: limited requests/day

2. **SEC Filings** (`/stocks/filings/*`)
   - 10-K sections (business, risks)
   - 8-K material events
   - AI-ready plain text (no XBRL parsing needed)

3. **Risk Factors** (`/stocks/filings/vX/risk-factors`)
   - Structured taxonomy
   - Primary/secondary/tertiary categories
   - Supporting text snippets

### Cost Estimate

**Massive.com**: $30/month (includes all data used)

**OpenAI**: Variable per research
- gpt-4: ~$0.10-0.30 per ticker
- gpt-5.4: ~$0.05-0.15 per ticker
- gpt-5.4-mini: ~$0.02-0.05 per ticker

**Daily scan** (5 researched tickers):
- Massive: $1/day (included in monthly $30)
- OpenAI (gpt-5.4): $0.25-0.75/day
- **Total**: ~$30/month for data + $15-25/month for AI

**Compare to Bloomberg**: $24,000/year → Save $23,640/year!

## Performance Considerations

### Rate Limiting

- Massive.com: Standard API rate limits apply
- OpenAI: Tier-based (tier 1 = 500 RPM)
- Built-in 15s pacing between research calls

### Caching

Research results are cached for 24 hours (configurable):
- Prevents duplicate API calls for same ticker
- Cache key: `{ticker}_{date}`
- Stored in Firestore or memory (implementation TBD)

### Graceful Degradation

If Massive.com API fails:
- `fallback_on_failure: true` → Continue without research
- `fallback_on_failure: false` → Abort and log error

## Integration Points

### 1. Main Scan Flow

In `src/signals_bot/main.py`:
```python
# No changes needed - research is called by AI eval
```

### 2. AI Evaluation

In `scripts/ai_stock_eval/main.py`:
```python
# Automatic enrichment when research.enabled = true
research_data = enrich_context_with_research(ticker, ctx, cfg)
ai_gate, recommendation = adjust_ai_gate_with_research(
    ai_gate, recommendation, research_data, cfg
)
```

### 3. Custom Research

In your own scripts:
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
    model="gpt-5.4",
)

print(f"Decision: {result.decision}")
print(f"Confidence: {result.confidence}")
print(f"Headline: {result.headline}")
```

## Monitoring

### Logs

Research activity is logged at INFO level:
```
INFO [signals_bot.research] Researching AAPL with AI model gpt-5.4
INFO [signals_bot.research.massive_client] Fetched 15 news articles for AAPL
INFO [signals_bot.research.massive_client] Fetched 8 risk factors for AAPL
INFO [signals_bot.research.researcher] Research for AAPL: decision=BUY confidence=85 catalysts=3 flags=1
INFO [scripts.ai_stock_eval.research_integration] Research confidence 85.0 >= threshold 70.0
```

### Firestore

Research results are stored in Firestore under `ai_evals/{eval_id}`:
```json
{
  "ticker": "AAPL",
  "ai_gate": "passed",
  "recommendation": {
    "decision": "BUY",
    "research": {
      "decision": "BUY",
      "confidence": 85,
      "headline": "Strong earnings catalyst"
    }
  },
  "detail": {
    "research_context": { ... }
  }
}
```

## Troubleshooting

### "MASSIVE_API_KEY not set"

```bash
# Add to .env
echo "MASSIVE_API_KEY=your_key_here" >> .env
```

### "massive-py not installed"

```bash
pip install -r requirements.txt
# Or directly:
pip install massive-py
```

### "Research module not available"

The research module requires Python 3.10+. Check your version:
```bash
python --version
```

### "Massive client initialization failed"

Check if the API key is valid:
```bash
python scripts/test_research.py AAPL --no-ai
```

### "OpenAI rate limit"

Research calls are paced 15s apart. If still hitting limits:
1. Reduce `max_research_per_run` in config
2. Use `gpt-5.4-mini` instead of `gpt-5.4`
3. Upgrade OpenAI tier

## Roadmap

### Phase 1 (Current)
- ✅ Massive.com data integration
- ✅ AI research synthesis
- ✅ AI gate adjustment
- ✅ Standalone testing script

### Phase 2 (Next)
- [ ] Research result caching (Firestore)
- [ ] Research history dashboard (frontend)
- [ ] A/B testing framework (with/without research)
- [ ] Performance metrics (win rate by research decision)

### Phase 3 (Future)
- [ ] Benzinga premium news integration ($99/mo)
- [ ] Twitter/X sentiment analysis
- [ ] Reddit WallStreetBets sentiment
- [ ] Custom research prompts per strategy

## References

- [Massive.com API Docs](https://massive.com/docs)
- [OpenAI API Docs](https://platform.openai.com/docs)
- [SEC EDGAR Database](https://www.sec.gov/edgar)
- [Project AGENTS.md](../AGENTS.md)

## Support

For issues or questions:
1. Check logs: `tail -f logs/signals_bot.log`
2. Test standalone: `python scripts/test_research.py AAPL -v`
3. Review config: `cat config.yaml | grep -A 20 research:`

---

**Last Updated**: 2026-09-02
**Version**: 1.0.0
**Status**: Ready for testing
