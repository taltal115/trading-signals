# Market Data Providers Map

**Complete mapping of all market data SDKs/APIs used across the trading-signals application.**

---

## Executive Summary

Your app uses **5 primary market data providers** across **3 layers**:

1. **Python Bot** (signal scanning & research)
2. **NestJS Backend API** (dashboard data)
3. **Legacy Vanilla Web App** (deprecated)

**Massive (Polygon.io)** is your newest and **primary** provider when `POLYGON_API_KEY` is set.

---

## Provider Overview

| Provider | Type | Python Bot | Nest API | Frontend | Status |
|----------|------|------------|----------|----------|--------|
| **Massive (Polygon)** | REST API | ✅ Primary | ✅ Primary | Indirect via API | **Active** |
| **Massive (Polygon) WS** | Delayed WebSocket (AM) | ❌ | ✅ Hub | Socket.IO via Nest | **Active (Signals live price)** |
| **Yahoo Finance** | SDK (yfinance) | ✅ Fallback #1 | ❌ | ❌ | Active |
| **Stooq** | CSV API | ✅ Fallback #2 | ❌ | ❌ | Active |
| **Finnhub** | SDK (finnhub-python) | Discovery only | ✅ Fallback | Indirect via API | Active |
| **Twelve Data** | REST API | ❌ | ✅ Fallback | Indirect via API | Active |
| **Alpha Vantage** | REST API | ❌ | ✅ Fallback | Indirect via API | Active |

---

## 1. Python Bot Layer (`src/signals_bot/`)

### Provider Priority (config.yaml)
```yaml
provider_order: ["polygon", "yahoo", "stooq"]
```

### A. Massive (Polygon.io) - **PRIMARY**

**File:** `src/signals_bot/providers/polygon.py`

**Implementation:** Direct REST API calls (no SDK)

**Endpoints:**
```
https://api.polygon.io/v2/aggs/ticker/{SYMBOL}/range/1/day/{START}/{END}
```

**Data:** Daily OHLCV bars

**Usage:**
- ✅ Daily bot scans (`main.py`)
- ✅ Research scripts (profit-at-hold cohort)
- ✅ Position monitoring (`scripts/monitor_open_positions.py`)
- ✅ AI stock evaluation context

**Configuration:**
```bash
POLYGON_API_KEY=xxx
# OR
MASSIVE_API_KEY=xxx
```

**Features:**
- Caching to reduce API calls
- Rate limit handling (429)
- Auth error detection (401/403)
- Adjusted prices by default

---

### B. Yahoo Finance - **FALLBACK #1**

**File:** `src/signals_bot/providers/yahoo.py`

**Implementation:** `yfinance` SDK (PyPI package)

**Data:** Daily OHLCV bars + ticker info (sector, industry)

**Usage:**
- ✅ Fallback when Polygon fails/unavailable
- ✅ Sector/industry metadata enrichment (`get_ticker_info()`)
- ✅ Research scripts
- ✅ Position monitoring

**Configuration:** No API key required

**Known Issues:**
- Can be blocked on corporate networks
- Noisy stdout/stderr (suppressed in code)
- MultiIndex column quirks
- Uses curl_cffi internally (SSL complexity)

**Special Features:**
- SSL certificate bundle support for corporate proxies
- Auto-adjust handling (`auto_adjust=False`)

---

### C. Stooq - **FALLBACK #2**

**File:** `src/signals_bot/providers/stooq.py`

**Implementation:** Direct CSV endpoint (no SDK)

**Endpoints:**
```
https://stooq.com/q/d/l/?s={SYMBOL}.us&i=d&apikey={KEY}
```

**Data:** Daily OHLCV bars

**Usage:**
- ✅ Last fallback when Polygon and Yahoo both fail
- ✅ Research scripts
- ✅ Position monitoring

**Configuration:**
```bash
STOOQ_API_KEY=xxx  # Optional but recommended
```

**Special Features:**
- HTTP fallback if HTTPS fails (corporate MITM handling)
- Symbol normalization (e.g., `AAPL` → `aapl.us`)
- CSV parsing with error detection

---

### D. Finnhub - **DISCOVERY ONLY**

**File:** `scripts/update_universe_finnhub.py`

**Implementation:** `finnhub-python` SDK (PyPI package)

**Data:** US stock symbols, company profiles

**Usage:**
- ✅ Universe discovery (symbol list building)
- ✅ Company metadata (sector, market cap)
- ✅ Enrichment scripts (`scripts/backfill_universe_latest_symbol_details.py`)

**Configuration:**
```bash
FINNHUB_API_KEY=xxx
```

**NOT used for:**
- ❌ Price data in Python bot
- ❌ Daily scans

---

## 2. NestJS Backend API Layer (`backend/`)

### Provider Priority (Hard-coded waterfall)

**Quote/Snapshot:**
1. **Polygon** (primary)
2. Finnhub (fallback)

**Daily Candles:**
1. **Polygon** (primary)
2. Twelve Data
3. Alpha Vantage
4. Finnhub

**Hourly Candles:**
1. **Polygon** (primary)
2. Twelve Data
3. Alpha Vantage
4. Finnhub

---

### A. Massive (Polygon.io) - **PRIMARY**

**File:** `backend/src/market/market.service.ts`

**Implementation:** Direct `fetch()` API calls (no SDK)

**Endpoints:**

1. **Stock Snapshot** (lines 298-415)
   ```
   https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/{SYMBOL}
   https://api.polygon.io/v3/reference/tickers/{SYMBOL}
   ```

2. **Daily Candles** (lines 418-455)
   ```
   https://api.polygon.io/v2/aggs/ticker/{SYMBOL}/range/1/day/{FROM}/{TO}
   ```

3. **Hourly Candles** (lines 457-500)
   ```
   https://api.polygon.io/v2/aggs/ticker/{SYMBOL}/range/1/hour/{FROM_MS}/{TO_MS}
   ```

**API Routes:**
- `GET /api/market/quote?symbol=AAPL`
- `GET /api/market/snapshot?symbol=AAPL`
- `GET /api/market/candles?symbol=AAPL&days=30`
- `GET /api/market/candles?symbol=AAPL&interval=1h&from=X&to=Y`

**Configuration:**
```bash
POLYGON_API_KEY=xxx
# OR
MASSIVE_API_KEY=xxx
```

**Features:**
- Real-time quotes
- Company profiles (name, market cap, industry, IPO date)
- Daily + intraday data
- Adjusted prices

---

### B. Finnhub - **FALLBACK**

**File:** `backend/src/market/market.service.ts`

**Implementation:** Direct `fetch()` API calls (no SDK)

**Endpoints:**
```
https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={KEY}
https://finnhub.io/api/v1/stock/profile2?symbol={SYMBOL}&token={KEY}
https://finnhub.io/api/v1/stock/candle?symbol={SYMBOL}&resolution=D&from={FROM}&to={TO}&token={KEY}
```

**Usage:**
- ✅ Quote fallback when Polygon unavailable
- ✅ Company profile fallback
- ⚠️ Daily/hourly candles (often **blocked on free tier** - 403)

**Configuration:**
```bash
FINNHUB_API_KEY=xxx
```

**Special Features:**
- Request serialization (1200ms min gap)
- Circuit breaker on 403 (30min cooldown)
- Rate limit handling (429)

---

### C. Twelve Data - **FALLBACK**

**File:** `backend/src/market/market.service.ts`

**Implementation:** Direct `fetch()` API calls (no SDK)

**Endpoints:**
```
https://api.twelvedata.com/time_series?symbol={SYMBOL}&interval=1day&outputsize={N}&apikey={KEY}
https://api.twelvedata.com/time_series?symbol={SYMBOL}&interval=1h&start_date={START}&end_date={END}&timezone=UTC&apikey={KEY}
```

**Usage:**
- ✅ Daily candles fallback
- ✅ Hourly candles fallback

**Configuration:**
```bash
TWELVE_DATA_API_KEY=xxx
```

---

### D. Alpha Vantage - **FALLBACK**

**File:** `backend/src/market/market.service.ts`

**Implementation:** Direct `fetch()` API calls (no SDK)

**Endpoints:**
```
https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol={SYMBOL}&outputsize={SIZE}&apikey={KEY}
https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol={SYMBOL}&interval=60min&outputsize=full&apikey={KEY}
```

**Usage:**
- ✅ Daily candles fallback
- ✅ Hourly candles fallback

**Configuration:**
```bash
ALPHA_VANTAGE_API_KEY=xxx
# OR (Python compat)
ALPHAVANTAGE_API_KEY=xxx
```

**Special Features:**
- Request serialization (1300ms min gap)
- Low rate limits (25 req/day free tier)

---

## 3. Angular Frontend (`frontend/`)

**File:** `frontend/src/app/core/market-data.service.ts`

**Implementation:** Calls backend `/api/market/*` endpoints

**No direct provider integration** - all data flows through NestJS backend

**Provider Label Mapping:**
```typescript
'polygon' → 'Massive'
'twelve_data' → 'Twelve Data'
'alpha_vantage' → 'Alpha Vantage'
'finnhub' → 'Finnhub'
```

---

## 4. Legacy Vanilla Web App (DEPRECATED)

**Files:**
- `web/legacy-vanilla/app.js`
- `web/firebase-config.js`

**Providers:**
- Finnhub (quotes)
- Alpha Vantage (charts)
- Twelve Data (charts)

**Status:** Superseded by Angular frontend + Nest API

---

## Comparison: Massive vs Other Providers

### Massive (Polygon.io) Advantages

| Feature | Massive | Yahoo | Stooq | Finnhub | Twelve | Alpha |
|---------|---------|-------|-------|---------|--------|-------|
| **Real-time quotes** | ✅ | ❌ | ❌ | ✅ | ✅ | ⚠️ Delayed |
| **Intraday data** | ✅ Hourly | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Company profiles** | ✅ Rich | ⚠️ Basic | ❌ | ✅ | ❌ | ❌ |
| **Reliability** | ✅ High | ⚠️ Variable | ⚠️ Variable | ✅ | ✅ | ⚠️ Low rate limits |
| **Rate limits** | ✅ Generous | ✅ None | ✅ Generous | ⚠️ Moderate | ⚠️ Moderate | ❌ 25/day free |
| **Adjusted prices** | ✅ Default | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Auth required** | ✅ API key | ❌ | ⚠️ Optional | ✅ API key | ✅ API key | ✅ API key |
| **Corporate proxy** | ✅ Works | ⚠️ Often blocked | ⚠️ Can fail | ✅ Works | ✅ Works | ✅ Works |
| **SDK available** | ❌ (REST) | ✅ Python | ❌ (CSV) | ✅ Python | ❌ (REST) | ❌ (REST) |

### Why Massive is Primary

1. **Comprehensive data** - quotes, profiles, daily, hourly all in one provider
2. **High reliability** - no blocking on corporate networks
3. **Better rate limits** - compared to free tiers
4. **Single authentication** - one key for bot + API
5. **Consistent data quality** - institutional-grade source

### Why Keep Fallbacks

1. **Redundancy** - graceful degradation if Massive has issues
2. **Cost optimization** - free tiers for overflow/testing
3. **Yahoo Finance** - no auth required, good for development
4. **Geographic diversity** - different network paths

---

## Integration Patterns

### Python Bot Pattern
```python
# providers/__init__.py
providers = {
    "polygon": PolygonProvider(api_key=config.polygon_api_key),  # Massive
    "yahoo": YahooProvider(),
    "stooq": StooqProvider(api_key=config.stooq_api_key),
}

# Waterfall through provider_order
for provider_name in config.provider_order:
    try:
        df = providers[provider_name].get_history(symbol, lookback_days=60)
        break
    except Exception:
        continue
```

### NestJS Backend Pattern
```typescript
// market.service.ts
async getQuote(symbol: string): Promise<number> {
  // Try Polygon (Massive) first
  if (this.polygonKey) {
    try {
      const snap = await this.polygonStockSnapshot(symbol);
      if (snap.quote.current > 0) return snap.quote.current;
    } catch (e) {
      this.logger.warn(`Polygon quote failed: ${e.message}`);
    }
  }
  
  // Fallback to Finnhub
  return this.finnhubFetchQuoteJson(symbol);
}
```

---

## Configuration Summary

### Environment Variables

**Bot (Python):**
```bash
# Massive/Polygon - PRIMARY
POLYGON_API_KEY=xxx          # or MASSIVE_API_KEY

# Fallbacks
STOOQ_API_KEY=xxx            # Optional

# Discovery only
FINNHUB_API_KEY=xxx
```

**API (Nest):**
```bash
# Massive/Polygon - PRIMARY
POLYGON_API_KEY=xxx          # or MASSIVE_API_KEY

# Fallbacks
FINNHUB_API_KEY=xxx
TWELVE_DATA_API_KEY=xxx
ALPHA_VANTAGE_API_KEY=xxx    # or ALPHAVANTAGE_API_KEY
```

### Config Files

**Python:** `config.yaml`
```yaml
data:
  provider_order: ["polygon", "yahoo", "stooq"]
  polygon_api_key: null  # Use env POLYGON_API_KEY
  stooq_api_key: null    # Use env STOOQ_API_KEY
```

**Nest:** `backend/src/config/configuration.ts`
```typescript
polygonApiKey: (
  process.env.POLYGON_API_KEY ||
  process.env.MASSIVE_API_KEY ||
  ''
).trim()
```

---

## Migration Path to Massive

### Current State (Before Full Migration)
```
Bot Scans: Polygon → Yahoo → Stooq
Dashboard API: Polygon → Finnhub/Twelve/Alpha
```

### Future State (Massive-first)
```
Bot Scans: Massive (Polygon) → Yahoo → Stooq
Dashboard API: Massive (Polygon) → Twelve → Alpha → Finnhub
```

### Already Completed ✅
1. ✅ Polygon provider implemented in Python bot
2. ✅ Polygon integration in Nest API
3. ✅ Polygon set as primary in config
4. ✅ Fallback chains preserved
5. ✅ MASSIVE_API_KEY alias added

### Recommended Next Steps
1. Monitor Polygon API usage vs rate limits
2. Consider removing Finnhub from candles chain (frequent 403s)
3. Document Massive-specific features (market cap normalization, timestamp formats)
4. Add Polygon health check to monitoring dashboard

---

## Key Files Reference

### Python Bot
| File | Purpose |
|------|---------|
| `src/signals_bot/providers/polygon.py` | Massive/Polygon implementation |
| `src/signals_bot/providers/yahoo.py` | Yahoo Finance SDK wrapper |
| `src/signals_bot/providers/stooq.py` | Stooq CSV parser |
| `src/signals_bot/providers/base.py` | Provider interface |
| `src/signals_bot/providers/__init__.py` | Provider factory |

### NestJS API
| File | Purpose |
|------|---------|
| `backend/src/market/market.service.ts` | All providers (Polygon, Finnhub, Twelve, Alpha) |
| `backend/src/config/configuration.ts` | API key loading |

### Frontend
| File | Purpose |
|------|---------|
| `frontend/src/app/core/market-data.service.ts` | API client, caching, provider labels |

### Scripts
| File | Purpose |
|------|---------|
| `scripts/update_universe_finnhub.py` | Finnhub universe discovery |
| `scripts/monitor_open_positions.py` | Uses bot providers (Polygon→Yahoo→Stooq) |
| `scripts/research_profit_hold_cohort.py` | Uses bot providers |

---

## Testing Each Provider

### Test Polygon (Massive)
```bash
# Python
export POLYGON_API_KEY=xxx
PYTHONPATH=./src python scripts/test_polygon_provider.py

# API
curl "http://localhost:3000/api/market/quote?symbol=AAPL"
```

### Test Yahoo
```bash
# Python (unset POLYGON_API_KEY to force Yahoo)
unset POLYGON_API_KEY
./run.sh --ticker AAPL --dry-run
```

### Test Stooq
```bash
# Python (unset both Polygon and rely on Yahoo/Stooq fallback)
export STOOQ_API_KEY=xxx
./run.sh --ticker AAPL --dry-run
```

### Test Finnhub
```bash
# Discovery
export FINNHUB_API_KEY=xxx
python scripts/update_universe_finnhub.py --discovery-mode scan
```

---

**Generated:** 2026-09-01  
**Author:** Trading Signals Bot Documentation
