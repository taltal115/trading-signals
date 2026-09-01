# Market Data Providers Architecture

Visual architecture diagrams showing how different market data providers integrate across your application.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         TRADING SIGNALS APP                         │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                │                  │                  │
                ▼                  ▼                  ▼
        ┌───────────────┐  ┌──────────────┐  ┌──────────────┐
        │  Python Bot   │  │  NestJS API  │  │   Angular    │
        │  (Signals)    │  │  (Backend)   │  │  (Frontend)  │
        └───────────────┘  └──────────────┘  └──────────────┘
                │                  │                  │
                │                  │                  │
         (Direct API calls)  (Direct API calls)  (Indirect via API)
                │                  │                  │
                ▼                  ▼                  ▼
        ┌───────────────┐  ┌──────────────┐  ┌──────────────┐
        │   Polygon     │  │   Polygon    │  │      No      │
        │   (Massive)   │  │   (Massive)  │  │    Direct    │
        │      +        │  │      +       │  │  Integration │
        │    Yahoo      │  │   Finnhub    │  │              │
        │      +        │  │      +       │  │   Calls API  │
        │    Stooq      │  │  Twelve Data │  │   Endpoints  │
        │               │  │      +       │  │              │
        │               │  │ Alpha Vantage│  │              │
        └───────────────┘  └──────────────┘  └──────────────┘
```

---

## Layer 1: Python Bot (Signal Generation)

```
┌──────────────────────────────────────────────────────────────────┐
│                         PYTHON BOT LAYER                         │
│                    src/signals_bot/main.py                       │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  Provider Pool   │
                    │  (__init__.py)   │
                    └──────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
            ▼                 ▼                 ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │   POLYGON    │  │    YAHOO     │  │    STOOQ     │
    │  (MASSIVE)   │  │   FINANCE    │  │              │
    │              │  │              │  │              │
    │  Priority: 1 │  │  Priority: 2 │  │  Priority: 3 │
    └──────────────┘  └──────────────┘  └──────────────┘
            │                 │                 │
            ▼                 ▼                 ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │   REST API   │  │ yfinance SDK │  │   CSV API    │
    │              │  │              │  │              │
    │ api.polygon. │  │  Python Pkg  │  │ stooq.com/   │
    │    io/v2     │  │              │  │    q/d/l     │
    └──────────────┘  └──────────────┘  └──────────────┘

Configuration: config.yaml
  data:
    provider_order: ["polygon", "yahoo", "stooq"]

Environment Variables:
  - POLYGON_API_KEY (or MASSIVE_API_KEY)
  - STOOQ_API_KEY (optional)
```

### Usage Flow

```
Daily Scan Workflow:
═════════════════════

1. Load ticker list (universe)
2. For each ticker:
   │
   ├─► Try Polygon (Massive)
   │   ├─ Success → Use data
   │   └─ Fail → Next provider
   │
   ├─► Try Yahoo Finance
   │   ├─ Success → Use data
   │   └─ Fail → Next provider
   │
   └─► Try Stooq
       ├─ Success → Use data
       └─ Fail → Skip ticker (log error)

3. Calculate technical indicators
4. Score & rank signals
5. Write to Firestore/SQLite/Slack
```

---

## Layer 2: NestJS Backend API (Dashboard Data)

```
┌────────────────────────────────────────────────────────────────────┐
│                        NESTJS API LAYER                            │
│                backend/src/market/market.service.ts                │
└────────────────────────────────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
 ┌─────────────┐         ┌──────────────┐        ┌──────────────┐
 │   QUOTES    │         │DAILY CANDLES │        │HOURLY CANDLES│
 │ /api/market │         │/api/market   │        │/api/market   │
 │   /quote    │         │   /candles   │        │   /candles   │
 │ /snapshot   │         │              │        │  ?interval=1h│
 └─────────────┘         └──────────────┘        └──────────────┘
        │                         │                         │
        ▼                         ▼                         ▼

┌──────────────────────────────────────────────────────────────────┐
│                     PROVIDER WATERFALL                           │
└──────────────────────────────────────────────────────────────────┘

QUOTES & SNAPSHOT:
─────────────────
  1. Polygon (Massive) ─────► api.polygon.io/v2/snapshot
       │  Success → Return
       │  Fail ↓
  2. Finnhub ──────────────► finnhub.io/api/v1/quote
       │  Success → Return
       │  Fail → Error

DAILY CANDLES:
─────────────
  1. Polygon (Massive) ─────► api.polygon.io/v2/aggs (daily)
       │  Success → Return
       │  Fail ↓
  2. Twelve Data ───────────► api.twelvedata.com/time_series
       │  Success → Return
       │  Fail ↓
  3. Alpha Vantage ─────────► alphavantage.co (TIME_SERIES_DAILY)
       │  Success → Return
       │  Fail ↓
  4. Finnhub ───────────────► finnhub.io (often 403 on free tier)
       │  Success → Return
       │  Fail → Error

HOURLY CANDLES:
──────────────
  1. Polygon (Massive) ─────► api.polygon.io/v2/aggs (hourly)
       │  Success → Return
       │  Fail ↓
  2. Twelve Data ───────────► api.twelvedata.com/time_series (1h)
       │  Success → Return
       │  Fail ↓
  3. Alpha Vantage ─────────► alphavantage.co (TIME_SERIES_INTRADAY)
       │  Success → Return
       │  Fail ↓
  4. Finnhub ───────────────► finnhub.io (often 403 on free tier)
       │  Success → Return
       │  Fail → Error


Environment Variables:
  - POLYGON_API_KEY (or MASSIVE_API_KEY) ← PRIMARY
  - FINNHUB_API_KEY
  - TWELVE_DATA_API_KEY
  - ALPHA_VANTAGE_API_KEY (or ALPHAVANTAGE_API_KEY)
```

---

## Layer 3: Angular Frontend (User Interface)

```
┌──────────────────────────────────────────────────────────────────┐
│                     ANGULAR FRONTEND LAYER                       │
│           frontend/src/app/core/market-data.service.ts           │
└──────────────────────────────────────────────────────────────────┘
                              │
                              │ (HTTP calls)
                              ▼
                    ┌──────────────────┐
                    │   NestJS API     │
                    │  /api/market/*   │
                    └──────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
    ┌─────────┐         ┌──────────┐       ┌──────────┐
    │  Quote  │         │  Daily   │       │  Hourly  │
    │  Price  │         │ Candles  │       │ Candles  │
    └─────────┘         └──────────┘       └──────────┘

Features:
  - Client-side caching (5-10 min TTL)
  - Provider label mapping (polygon → "Massive")
  - Circuit breakers for quota errors
  - Request serialization (no spam)

NO DIRECT PROVIDER INTEGRATION
All data flows through backend API
```

---

## Provider Comparison Matrix

```
┌──────────────┬────────────┬───────────┬──────────┬──────────┬──────────┬────────────┐
│   Provider   │  Massive   │   Yahoo   │  Stooq   │ Finnhub  │  Twelve  │   Alpha    │
│              │ (Polygon)  │  Finance  │          │          │   Data   │  Vantage   │
├──────────────┼────────────┼───────────┼──────────┼──────────┼──────────┼────────────┤
│ Python Bot   │    ✅ #1   │   ✅ #2   │  ✅ #3   │    ❌    │    ❌    │     ❌     │
├──────────────┼────────────┼───────────┼──────────┼──────────┼──────────┼────────────┤
│ Nest Quote   │    ✅ #1   │    ❌     │    ❌    │  ✅ #2   │    ❌    │     ❌     │
├──────────────┼────────────┼───────────┼──────────┼──────────┼──────────┼────────────┤
│ Nest Daily   │    ✅ #1   │    ❌     │    ❌    │  ✅ #4   │  ✅ #2   │   ✅ #3    │
├──────────────┼────────────┼───────────┼──────────┼──────────┼──────────┼────────────┤
│ Nest Hourly  │    ✅ #1   │    ❌     │    ❌    │  ✅ #4   │  ✅ #2   │   ✅ #3    │
├──────────────┼────────────┼───────────┼──────────┼──────────┼──────────┼────────────┤
│ API Key      │     ✅     │    ❌     │  ⚠️ Opt  │    ✅    │    ✅    │     ✅     │
├──────────────┼────────────┼───────────┼──────────┼──────────┼──────────┼────────────┤
│ SDK Type     │  REST API  │Python SDK │CSV API   │Python SDK│ REST API │  REST API  │
├──────────────┼────────────┼───────────┼──────────┼──────────┼──────────┼────────────┤
│ Rate Limits  │  Generous  │   None    │ Generous │ Moderate │ Moderate │  25/day ⚠️  │
├──────────────┼────────────┼───────────┼──────────┼──────────┼──────────┼────────────┤
│ Intraday     │     ✅     │    ❌     │    ❌    │    ✅    │    ✅    │     ✅     │
├──────────────┼────────────┼───────────┼──────────┼──────────┼──────────┼────────────┤
│ Profiles     │     ✅     │  ⚠️ Basic │    ❌    │    ✅    │    ❌    │     ❌     │
├──────────────┼────────────┼───────────┼──────────┼──────────┼──────────┼────────────┤
│ Reliability  │    High    │  Variable │ Variable │   High   │   High   │   Medium   │
└──────────────┴────────────┴───────────┴──────────┴──────────┴──────────┴────────────┘

Legend:
  ✅ = Supported / Yes
  ❌ = Not used / No
  ⚠️ = Optional / Limited
  #N = Priority order
```

---

## Data Flow: End-to-End Example

### Scenario: User views signal detail page

```
USER OPENS SIGNAL DETAIL PAGE (AAPL)
════════════════════════════════════

Step 1: Angular Component Loads
────────────────────────────────
 Component: signal-detail.component.ts
    │
    ├─► Request: Firestore signal document
    │   Source: Firebase SDK
    │   Data: BUY signal metadata
    │
    └─► Request: market-data.service.getDailyCandles('AAPL', 30)


Step 2: Frontend Service Call
──────────────────────────────
 Service: market-data.service.ts
    │
    ├─► Check cache (5min TTL)
    │   ├─ Hit → Return cached data
    │   └─ Miss ↓
    │
    └─► HTTP GET: http://localhost:3000/api/market/candles?symbol=AAPL&days=30


Step 3: NestJS API Routing
───────────────────────────
 Controller: market.controller.ts
    │
    └─► Call: marketService.getDailyCandles('AAPL', 30)


Step 4: Backend Provider Waterfall
───────────────────────────────────
 Service: market.service.ts

 Try #1: Polygon (Massive)
 ─────────────────────────
    Request: https://api.polygon.io/v2/aggs/ticker/AAPL/range/1/day/...
    Headers: apiKey=xxx
    │
    ├─ Success (200 OK)
    │  └─► Parse JSON → Return { t: [...], c: [...], o: [...] }
    │                    Status: provider='polygon'
    │                    Exit waterfall ✓
    │
    └─ Failure (429 Rate Limit / 401 Auth / Network Error)
       └─► Log warning → Continue to Try #2


 Try #2: Twelve Data
 ───────────────────
    Request: https://api.twelvedata.com/time_series?symbol=AAPL&...
    │
    ├─ Success → Return data (provider='twelve_data') ✓
    │
    └─ Failure → Continue to Try #3


 Try #3: Alpha Vantage
 ─────────────────────
    Request: https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&...
    │
    ├─ Success → Return data (provider='alpha_vantage') ✓
    │
    └─ Failure → Continue to Try #4


 Try #4: Finnhub
 ───────────────
    Request: https://finnhub.io/api/v1/stock/candle?symbol=AAPL&...
    │
    ├─ Success → Return data (provider='finnhub') ✓
    │
    └─ Failure → Throw ServiceUnavailableException (503)


Step 5: Response Flow
─────────────────────
 NestJS → Angular:
    Response: { t: [timestamps...], c: [closes...], o: [opens...], provider: 'polygon' }
    Status: 200 OK

 Angular Service:
    │
    ├─► Cache response (5min)
    └─► Return to component

 Component:
    │
    └─► Render chart with Polygon data
        Footer: "Data source: Massive"


═══════════════════════════════════════════════════════════════
TOTAL TIME: ~100-500ms
PRIMARY PROVIDER: Massive (Polygon) ✅
FALLBACKS AVAILABLE: 3 (Twelve, Alpha, Finnhub)
═══════════════════════════════════════════════════════════════
```

---

## Special Case: Python Bot Daily Scan

```
DAILY BOT SCAN WORKFLOW
═══════════════════════

Time: 4:00 PM ET (market close)
Trigger: GitHub Action / Cron / Manual ./run.sh

Step 1: Load Universe
─────────────────────
 Source: Firestore collection `universe/{asof_date}`
 Count: ~500-2000 symbols
 Filter: US equities, price $2-$80, volume > $5M

Step 2: Fetch Historical Data (per ticker)
───────────────────────────────────────────
 Lookback: 60 days OHLCV

 Provider Loop (config.provider_order):
 ──────────────────────────────────────
   Ticker: AAPL
      │
      ├─► Try: Polygon (Massive)
      │   Request: https://api.polygon.io/v2/aggs/ticker/AAPL/range/1/day/...
      │   Timeout: 20 sec
      │   │
      │   ├─ Success → Cache & use data ✓
      │   │   Data: 60 days OHLCV
      │   │   Quality: Adjusted, clean
      │   │   Exit loop
      │   │
      │   └─ Failure (network / auth / 429)
      │      └─► Log & continue

      ├─► Try: Yahoo Finance
      │   Library: yfinance Python SDK
      │   │
      │   ├─ Success → Cache & use data ✓
      │   │   Exit loop
      │   │
      │   └─ Failure (blocked / error)
      │      └─► Log & continue

      └─► Try: Stooq
          Request: https://stooq.com/q/d/l/?s=aapl.us&i=d
          │
          ├─ Success → Cache & use data ✓
          │   Exit loop
          │
          └─ Failure → Skip ticker entirely
             Log: ERROR - All providers failed for AAPL

Step 3: Calculate Indicators
─────────────────────────────
 Per ticker with valid data:
   - ATR (14-day)
   - Breakout distance (20-day high)
   - Returns (5d, 10d)
   - Volume ratio (20d avg)
   - RSI, MACD, etc.

Step 4: Score & Rank
────────────────────
 Strategy weights:
   - Breakout: 40%
   - Momentum: 35%
   - Volume: 25%
 
 Hard filters:
   - ATR 3-18%
   - Breakout < 1% from high
   - Price $2-$80
   - Volume > $5M/day

Step 5: Output
──────────────
 BUY signals → Firestore `signals` collection
 Metadata includes:
   - data_provider_used: "polygon" | "yahoo" | "stooq"
   - features calculated from that provider
   - asof_date (UTC)

═══════════════════════════════════════════════════════════════
TYPICAL OUTCOME:
  - 1500 tickers processed
  - 1480 used Polygon (98.7%)
  - 15 fell back to Yahoo (1.0%)
  - 5 fell back to Stooq (0.3%)
  - 10-30 BUY signals generated
═══════════════════════════════════════════════════════════════
```

---

## Error Handling & Circuit Breakers

### Python Bot

```
Exception Types:
───────────────
  ValueError: "empty dataframe", "missing close column", etc.
  → Logged, try next provider

  requests.RequestException: Network errors, timeouts
  → Logged, try next provider

  HTTP 429 (Rate Limit):
  → Logged, try next provider immediately

  HTTP 401/403 (Auth):
  → Logged, try next provider immediately

No Circuit Breaker:
  Bot retries all providers for each ticker in sequence
```

### NestJS API

```
Rate Limit Handling:
───────────────────
  Finnhub: 1200ms minimum gap between calls (serialized)
  Alpha Vantage: 1300ms minimum gap (serialized)

Circuit Breakers:
────────────────
  Finnhub Candles 403:
    - Open circuit for 30 minutes
    - Skip Finnhub candles during cooldown
    - Log warning on first 403
    - Return ServiceUnavailableException upstream

Frontend:
────────
  Candles API errors (any provider quota):
    - Backoff for 30 minutes
    - Skip HTTP calls during backoff
    - Use cached data if available
```

---

## Configuration Hierarchy

```
PRIORITY: Environment Variables > Config Files > Defaults

Python Bot
══════════
  1. Environment (.env loaded by python-dotenv)
     POLYGON_API_KEY
     MASSIVE_API_KEY (alias)
     STOOQ_API_KEY
     FINNHUB_API_KEY (discovery only)

  2. config.yaml
     data:
       polygon_api_key: null
       stooq_api_key: null
       provider_order: ["polygon", "yahoo", "stooq"]

  3. Defaults
     provider_order: ["polygon", "yahoo", "stooq"]


NestJS API
══════════
  1. Environment (.env loaded by @nestjs/config)
     POLYGON_API_KEY
     MASSIVE_API_KEY (alias)
     FINNHUB_API_KEY
     TWELVE_DATA_API_KEY
     ALPHA_VANTAGE_API_KEY
     ALPHAVANTAGE_API_KEY (alias)

  2. configuration.ts
     Hard-coded waterfall logic (no config file)

  3. Defaults
     Empty strings (providers skipped if no key)
```

---

## Monitoring & Observability

### Logs to Watch

**Python Bot:**
```
INFO  - Using data provider: polygon (AAPL)
WARN  - Polygon failed for TSLA: HTTP 429 rate limited
INFO  - Fallback to yahoo for TSLA
ERROR - All providers failed for XYZ: skipping
```

**NestJS API:**
```
[MarketService] Candle/quote keys loaded: polygon=yes finnhub=yes twelve=no alpha=no
[MarketService] Polygon daily candles failed for GME: HTTP 429
[MarketService] Twelve Data candles failed for GME: error
[MarketService] Finnhub stock/candle returned 403 (no access on this plan).
                Cooling down 30m; set TWELVE_DATA_API_KEY for daily candles.
```

### Metrics to Track

```
┌─────────────────────────┬──────────────┬──────────────┐
│       Metric            │  Python Bot  │   Nest API   │
├─────────────────────────┼──────────────┼──────────────┤
│ Polygon success rate    │    ~98%      │    ~95%      │
│ Yahoo fallback rate     │    ~1%       │    N/A       │
│ Stooq fallback rate     │    ~0.3%     │    N/A       │
│ Finnhub usage           │    0% (data) │    ~5% quote │
│ Twelve/Alpha usage      │    0%        │    ~5% chart │
│ Total failures          │    <1%       │    <1%       │
└─────────────────────────┴──────────────┴──────────────┘
```

---

## Quick Reference

### Provider Endpoints

**Polygon (Massive):**
```
Daily:    https://api.polygon.io/v2/aggs/ticker/{SYM}/range/1/day/{FROM}/{TO}
Hourly:   https://api.polygon.io/v2/aggs/ticker/{SYM}/range/1/hour/{FROM_MS}/{TO_MS}
Snapshot: https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/{SYM}
Ticker:   https://api.polygon.io/v3/reference/tickers/{SYM}
```

**Yahoo Finance:**
```
SDK:      yfinance.download(ticker, start, end, interval='1d')
Info:     yfinance.Ticker(symbol).info
```

**Stooq:**
```
CSV:      https://stooq.com/q/d/l/?s={SYM}.us&i=d&apikey={KEY}
```

**Finnhub:**
```
Quote:    https://finnhub.io/api/v1/quote?symbol={SYM}&token={KEY}
Profile:  https://finnhub.io/api/v1/stock/profile2?symbol={SYM}&token={KEY}
Candles:  https://finnhub.io/api/v1/stock/candle?symbol={SYM}&resolution=D&...
```

**Twelve Data:**
```
Daily:    https://api.twelvedata.com/time_series?symbol={SYM}&interval=1day&...
Hourly:   https://api.twelvedata.com/time_series?symbol={SYM}&interval=1h&...
```

**Alpha Vantage:**
```
Daily:    https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol={SYM}&...
Hourly:   https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol={SYM}&interval=60min&...
```

---

**Document Version:** 1.0  
**Last Updated:** 2026-09-01  
**See Also:** `docs/market-data-providers-map.md`
