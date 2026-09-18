# Health Check Page — Implementation Plan

**Date**: 2026-09-18  
**Requester**: Tal  
**Goal**: Create a minimal health check page showing all platform integrations with daily connectivity checks

---

## Overview

Create a new **Health Check** page in the Angular dashboard that displays the status of all third-party integrations, API keys, and platform resources. The page will include:

1. **Frontend**: New Angular page at `/health` route
2. **Backend**: New NestJS health controller with connectivity checks
3. **Daily checks**: Automated daily health check job (optional/future)
4. **Minimal design**: Simple table grouped by categories

---

## Integration Inventory

### Category 1: Market Data (Critical — Paid)

| Provider | API Key | Cost | Usage | Check Method |
|----------|---------|------|-------|--------------|
| **Polygon** | `POLYGON_API_KEY` | 💰 **PAID** | Primary OHLCV | GET /v2/aggs/ticker/AAPL/prev |
| Yahoo Finance | None (via yfinance) | Free | Fallback OHLCV | Fetch AAPL history |
| Stooq | None (CSV API) | Free | Fallback OHLCV | GET CSV endpoint |

### Category 2: News & Research

| Provider | API Key | Cost | Usage | Check Method |
|----------|---------|------|-------|--------------|
| **Finnhub** | `FINNHUB_API_KEY` | Free tier | Company news (14d) | GET /api/v1/quote |
| NewsAPI | `NEWSAPI_API_KEY` | Free tier | Additional headlines | GET /v2/everything?q=AAPL |
| GDELT | None (free) | Free | News fallback | GET /api/v2/doc/doc |
| Massive.com | `MASSIVE_API_KEY` | Paid (optional) | Research layer | Status check API |

### Category 3: AI & ML

| Provider | API Key | Cost | Usage | Check Method |
|----------|---------|------|-------|--------------|
| **OpenAI** | `OPENAI_API_KEY` | 💰 **PAID** | Entry/holding LLM | GET /v1/models |

### Category 4: Macro & Economic Data

| Provider | API Key | Cost | Usage | Check Method |
|----------|---------|------|-------|--------------|
| FRED | `FRED_API_KEY` | Free | CPI, rates, spreads | GET /fred/series/observations |

### Category 5: Database & Storage

| Provider | API Key | Cost | Usage | Check Method |
|----------|---------|------|-------|--------------|
| Firestore | Service Account JSON | GCP billing | Signals, positions, universe | Query collection count |
| SQLite | None (local file) | Free | Local signal history | Check file exists + query |

### Category 6: Messaging & Notifications

| Provider | API Key | Cost | Usage | Check Method |
|----------|---------|------|-------|--------------|
| Slack | `SLACK_BOT_TOKEN` | Free tier | Signal notifications | GET /api/auth.test |

### Category 7: Portfolio & Broker

| Provider | API Key | Cost | Usage | Check Method |
|----------|---------|------|-------|--------------|
| IBKR Client Portal | Account credentials | Broker fees | Portfolio sync | GET /v1/api/portfolio/accounts |

---

## Implementation Plan

### Phase 1: Backend Health Controller

**File**: `backend/src/health/health.controller.ts`

#### Endpoint: `GET /api/health/status`

Returns JSON with all integration statuses:

```typescript
{
  "timestamp": "2026-09-18T07:56:00Z",
  "categories": [
    {
      "name": "Market Data",
      "critical": true,
      "integrations": [
        {
          "name": "Polygon",
          "key": "POLYGON_API_KEY",
          "status": "healthy" | "degraded" | "down" | "not_configured",
          "responseTime": 145,  // ms
          "lastChecked": "2026-09-18T07:56:00Z",
          "message": "OK",
          "isPaid": true
        },
        // ... more integrations
      ]
    },
    // ... more categories
  ]
}
```

#### Health Check Logic

Each integration check:
1. Verify API key is configured (env var exists)
2. Send lightweight test request
3. Measure response time
4. Return status + message

**Status Levels**:
- `healthy` — API key configured, test request succeeded
- `degraded` — Configured but slow (>2s response)
- `down` — Configured but test failed
- `not_configured` — API key missing/empty

#### Check Methods by Provider

```typescript
// Market Data
async checkPolygon(): Promise<HealthStatus> {
  // GET https://api.polygon.io/v2/aggs/ticker/AAPL/prev?apiKey=...
}

async checkYahoo(): Promise<HealthStatus> {
  // Try fetching AAPL via yfinance library
}

async checkStooq(): Promise<HealthStatus> {
  // GET CSV endpoint for AAPL
}

// News
async checkFinnhub(): Promise<HealthStatus> {
  // GET https://finnhub.io/api/v1/quote?symbol=AAPL&token=...
}

async checkNewsAPI(): Promise<HealthStatus> {
  // GET https://newsapi.org/v2/everything?q=AAPL&pageSize=1&apiKey=...
}

async checkGDELT(): Promise<HealthStatus> {
  // GET GDELT doc API (no key)
}

// AI
async checkOpenAI(): Promise<HealthStatus> {
  // GET https://api.openai.com/v1/models (list models)
}

// Macro
async checkFRED(): Promise<HealthStatus> {
  // GET https://api.stlouisfed.org/fred/series/observations?series_id=DFF&api_key=...&limit=1
}

// Database
async checkFirestore(): Promise<HealthStatus> {
  // Try fetching count from signals collection
}

async checkSQLite(): Promise<HealthStatus> {
  // Check file exists, try SELECT 1
}

// Messaging
async checkSlack(): Promise<HealthStatus> {
  // GET https://slack.com/api/auth.test (token validation)
}

// Broker
async checkIBKR(): Promise<HealthStatus> {
  // GET https://localhost:5000/v1/api/portfolio/accounts (if enabled)
}
```

#### Files to Create/Modify

```
backend/src/health/
├── health.module.ts          # New module
├── health.controller.ts      # New controller (main endpoint)
├── health.service.ts         # New service (check logic)
└── dto/
    └── health-status.dto.ts  # Response types
```

**Update**: `backend/src/app.module.ts` — import `HealthModule`

---

### Phase 2: Frontend Health Page

**File**: `frontend/src/app/features/health-page/health-page.component.ts`

#### Page Layout

```
┌─────────────────────────────────────────────────┐
│ Health Check Dashboard                          │
│                                                 │
│ Last Updated: Sept 18, 2026 7:56 AM    [Refresh]│
├─────────────────────────────────────────────────┤
│                                                 │
│ 🟢 Market Data (3/3 healthy) 💰 Paid           │
│ ┌───────────────────────────────────────────┐  │
│ │ Provider    │ Status   │ Response │ Last  │  │
│ ├─────────────┼──────────┼──────────┼───────┤  │
│ │ Polygon 💰  │ ✅ Healthy│  145ms  │ 7:56  │  │
│ │ Yahoo       │ ✅ Healthy│  320ms  │ 7:56  │  │
│ │ Stooq       │ ✅ Healthy│  280ms  │ 7:56  │  │
│ └───────────────────────────────────────────┘  │
│                                                 │
│ 🟡 News & Research (3/4 healthy)               │
│ ┌───────────────────────────────────────────┐  │
│ │ Provider    │ Status   │ Response │ Last  │  │
│ ├─────────────┼──────────┼──────────┼───────┤  │
│ │ Finnhub     │ ⚠️ Not Cfg│    -     │  -    │  │
│ │ NewsAPI     │ ✅ Healthy│  210ms  │ 7:56  │  │
│ │ GDELT       │ ✅ Healthy│  890ms  │ 7:56  │  │
│ │ Massive 💰  │ ❌ Down   │ Timeout  │ 7:56  │  │
│ └───────────────────────────────────────────┘  │
│                                                 │
│ ... (more categories) ...                      │
└─────────────────────────────────────────────────┘
```

#### Status Icons

- ✅ `healthy` — Green checkmark
- ⚠️ `degraded` or `not_configured` — Yellow warning
- ❌ `down` — Red X

#### Features

1. **Auto-refresh**: Poll `/api/health/status` every 60 seconds (optional toggle)
2. **Manual refresh**: Button to trigger immediate check
3. **Expandable sections**: Click category to expand/collapse
4. **Paid indicator**: 💰 icon for paid services (Polygon, OpenAI, Massive)
5. **Responsive**: Mobile-friendly table layout

#### Files to Create

```
frontend/src/app/features/health-page/
├── health-page.component.ts        # Component
├── health-page.component.html      # Template
└── health-page.component.css       # Styles

frontend/src/app/core/
└── health.service.ts               # HTTP service for /api/health/status
```

**Update**: `frontend/src/app/app.routes.ts` — add `/health` route

---

### Phase 3: Routing & Navigation

#### Add Route

**File**: `frontend/src/app/app.routes.ts`

```typescript
{
  path: 'health',
  component: HealthPageComponent,
  canActivate: [AuthGuard]
}
```

#### Add Navigation Link

**File**: `frontend/src/app/layout/nav-menu.component.html` (or equivalent)

Add "Health Check" link to navigation menu.

---

### Phase 4: Daily Automated Checks (Optional — Future)

**Approach**: GitHub Actions scheduled workflow

**File**: `.github/workflows/daily-health-check.yml`

```yaml
name: Daily Health Check
on:
  schedule:
    - cron: '0 12 * * *'  # Daily at 12:00 UTC
  workflow_dispatch:

jobs:
  health-check:
    runs-on: ubuntu-latest
    steps:
      - name: Call health endpoint
        run: |
          curl -f https://your-backend.run.app/api/health/status
      - name: Send Slack alert on failure
        if: failure()
        run: |
          # Slack webhook with health check failure alert
```

**Alternative**: NestJS cron job (if backend runs 24/7)

```typescript
@Cron('0 12 * * *')  // Daily at noon
async dailyHealthCheck() {
  const status = await this.healthService.runAllChecks();
  if (status.hasFailures) {
    await this.notifySlack(status);
  }
}
```

---

## File Changes Summary

### New Files (14)

**Backend** (5 files):
1. `backend/src/health/health.module.ts`
2. `backend/src/health/health.controller.ts`
3. `backend/src/health/health.service.ts`
4. `backend/src/health/dto/health-status.dto.ts`
5. `backend/src/health/health.module.spec.ts` (tests)

**Frontend** (3 files):
6. `frontend/src/app/features/health-page/health-page.component.ts`
7. `frontend/src/app/features/health-page/health-page.component.html`
8. `frontend/src/app/features/health-page/health-page.component.css`

**Core Services** (1 file):
9. `frontend/src/app/core/health.service.ts`

**Docs** (1 file):
10. `docs/health-check-page.md` (usage guide)

### Modified Files (3)

1. `backend/src/app.module.ts` — import HealthModule
2. `frontend/src/app/app.routes.ts` — add /health route
3. Navigation component (TBD based on existing nav pattern)

---

## Minimal Implementation Strategy

To keep this **as minimal as possible**:

### Backend Simplifications

1. **Synchronous checks only** — no background workers, no caching
2. **Timeout all checks at 5s** — fail fast
3. **Single endpoint** — `/api/health/status` returns everything
4. **No persistence** — ephemeral checks only (no DB storage)
5. **Reuse existing HTTP clients** — axios for API calls

### Frontend Simplifications

1. **No real-time updates** — manual refresh only (skip auto-refresh v1)
2. **No detailed drill-down** — simple table, no modals
3. **No history/trends** — current status only
4. **Minimal styling** — use existing dashboard table styles
5. **No fancy charts** — plain status indicators

### Scope Reductions

**Skip for v1**:
- Historical status tracking
- Uptime percentage calculations
- Response time charts/graphs
- Email alerts (Slack-only if needed)
- Per-user configuration
- Daily automated checks (manual only)

**Add later if needed**:
- Cache health results (5min TTL)
- Incident history log
- SLA monitoring

---

## Testing Strategy

### Backend Tests

```bash
cd backend
npm test -- health.service.spec.ts
```

Test cases:
- Each provider check method (mock responses)
- Timeout handling (slow APIs)
- Missing API key handling
- Error response formatting

### Frontend Tests

```bash
cd frontend
npm test -- health-page.component.spec.ts
```

Test cases:
- Page renders with mock data
- Status icons display correctly
- Refresh button triggers API call
- Error state displays

### Manual Testing

1. **All providers healthy**: All API keys configured
2. **Some missing**: Remove FINNHUB_API_KEY, verify warning
3. **Some down**: Mock API failure, verify error display
4. **Timeout**: Mock slow API (>5s), verify timeout handling

---

## Deployment Plan

### 1. Backend Deployment

```bash
cd backend
npm run build
gcloud run deploy trading-signals-api \
  --source . \
  --region us-central1
```

### 2. Frontend Deployment

```bash
cd frontend
npm run build
firebase deploy --only hosting
```

### 3. Environment Variables

Ensure these are set in Cloud Run (backend):
- `POLYGON_API_KEY`
- `FINNHUB_API_KEY`
- `NEWSAPI_API_KEY`
- `OPENAI_API_KEY`
- `SLACK_BOT_TOKEN`
- `FRED_API_KEY`
- `MASSIVE_API_KEY` (if used)
- `GOOGLE_APPLICATION_CREDENTIALS` (Firestore)

---

## Success Criteria

✅ Health check page accessible at `/health` route  
✅ All 11 integrations displayed in categorized tables  
✅ Status indicators (✅⚠️❌) display correctly  
✅ Paid services (Polygon, OpenAI) marked with 💰  
✅ Manual refresh button works  
✅ Response times displayed in milliseconds  
✅ Page loads in <3s (with all checks)  
✅ Mobile responsive  

---

## Timeline Estimate

**Implementation**: 3-4 hours
- Backend health service: 1.5 hours
- Frontend page + service: 1.5 hours
- Testing + fixes: 0.5-1 hour

**Deployment**: 15-30 minutes
- Backend deploy + env vars check
- Frontend deploy
- Verification

**Total**: ~4-5 hours for complete implementation and deployment

---

## Questions for Approval

1. **Daily automated checks**: Include in v1 or defer? (Recommend: defer to v2)
2. **Auto-refresh interval**: 60s? Or manual-only? (Recommend: manual-only v1)
3. **Navigation placement**: Where to add "Health Check" link in nav menu?
4. **Access control**: Admin-only or all authenticated users? (Recommend: all users)
5. **Slack alerts**: On health check failures? (Recommend: manual monitoring v1)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| API rate limits (GDELT) | Health check fails | Skip GDELT if recently rate-limited |
| Slow external APIs | Page timeout | 5s timeout per check |
| Missing API keys | Confusing errors | Clear "Not Configured" status |
| Firestore quota exceeded | Check fails | Graceful fallback, show warning |
| IBKR localhost SSL | Can't check | Mark as "Local Only" if remote |

---

## Future Enhancements (v2)

1. **Status history**: Store check results in Firestore
2. **Uptime tracking**: Calculate 7d/30d uptime percentages
3. **Response time trends**: Chart API performance over time
4. **Alert rules**: Slack notification on degradation
5. **Daily automated checks**: GitHub Actions or NestJS cron
6. **Per-provider drill-down**: Detailed error logs, recent requests
7. **Cost tracking**: Estimate monthly API costs (Polygon, OpenAI)

---

## Ready to Proceed?

Please review and approve:
- ✅ Integration inventory complete?
- ✅ Minimal scope acceptable?
- ✅ Deployment plan clear?
- ✅ Answer questions above

Once approved, I will:
1. Create feature branch `cursor/health-check-page-44ba`
2. Implement backend (health module)
3. Implement frontend (health page)
4. Test locally
5. Create pull request
6. Merge to main
7. Deploy backend + frontend

**Estimated time**: 4-5 hours total
