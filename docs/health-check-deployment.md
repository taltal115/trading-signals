# Health Check Page — Deployment Guide

**Date**: 2026-09-18  
**Status**: ✅ Implementation Complete | ⏸️ Deployment Pending  
**PR**: [#10](https://github.com/taltal115/trading-signals/pull/10) — Merged to `main`

---

## Implementation Summary ✅

### What Was Built

#### Backend (NestJS)
- ✅ Health module with `/api/health/status` endpoint
- ✅ 11 integration checks across 7 categories
- ✅ 5-second timeout per check
- ✅ Status levels: `healthy`, `degraded`, `down`, `not_configured`
- ✅ Response time measurement in milliseconds
- ✅ Paid service identification (Polygon 💰, OpenAI 💰, Massive 💰)

#### Frontend (Angular)
- ✅ `/health` route with categorized tables
- ✅ Visual status indicators (✅⚠️❌)
- ✅ Manual refresh button
- ✅ Mobile responsive design
- ✅ Navigation link added to sidebar

#### Files Changed
- ✅ 9 new files (backend health module + frontend page)
- ✅ 3 modified files (app.module.ts, routes, navigation)
- ✅ 1 dependency added (`axios` for HTTP checks)

#### Testing
- ✅ Backend builds successfully
- ✅ Frontend builds successfully
- ✅ TypeScript compilation passes
- ✅ PR merged to main

---

## Deployment Steps 🚀

### Prerequisites

Ensure these are installed and authenticated:
- ✅ Google Cloud SDK (`gcloud`) — authenticated with `trading-goals` project
- ✅ Firebase CLI (`firebase`) — authenticated
- ✅ Docker (if using local build method)

### 1. Deploy Backend (Cloud Run)

From repository root:

```bash
# Deploy backend to Cloud Run
bash scripts/deploy.sh be

# Or directly:
bash scripts/deploy_nest_cloud_run.sh
```

**What this does:**
- Builds Docker image from `backend/Dockerfile`
- Pushes to Artifact Registry (us-central1)
- Deploys to Cloud Run service: `trading-signals-api`

**If Cloud Build permission denied:**
```bash
# Use local Docker build instead
USE_LOCAL_DOCKER=1 bash scripts/deploy_nest_cloud_run.sh
```

### 2. Verify Backend Environment Variables

The health checks require API keys. Ensure these are set in Cloud Run:

**Required for Full Health Checks:**
```bash
POLYGON_API_KEY=...           # Market data (paid)
FINNHUB_API_KEY=...           # News (free tier)
OPENAI_API_KEY=...            # AI/ML (paid)
SLACK_BOT_TOKEN=...           # Messaging (free tier)
```

**Optional:**
```bash
NEWSAPI_API_KEY=...           # Additional news (free tier)
FRED_API_KEY=...              # Macro data (free)
MASSIVE_API_KEY=...           # Alias for POLYGON_API_KEY (same vendor; not a news provider)
GOOGLE_APPLICATION_CREDENTIALS=... # Firestore (auto-set by Cloud Run)
```

**Set via Cloud Console:**
1. Go to Cloud Run → `trading-signals-api` → Edit & Deploy New Revision
2. Add/update environment variables
3. Deploy revision

**Or via gcloud:**
```bash
gcloud run services update trading-signals-api \
  --region us-central1 \
  --update-env-vars FINNHUB_API_KEY=your_key_here
```

### 3. Deploy Frontend (Firebase Hosting)

From repository root:

```bash
# Deploy frontend to Firebase Hosting
bash scripts/deploy.sh fe

# Or directly:
cd frontend && npx ng build --configuration=production
firebase deploy --only hosting
```

**What this does:**
- Builds Angular app for production
- Deploys to Firebase Hosting
- Updates routing (includes new `/health` route)

### 4. Verify Deployment

#### Backend Health Check
```bash
# Test the health endpoint
curl -H "Cookie: your_session_cookie" \
  https://trading-goals.web.app/api/health/status

# Or via Cloud Run directly
gcloud run services proxy trading-signals-api --region us-central1
# Then: curl http://localhost:8080/api/health/status
```

#### Frontend Access
1. Navigate to: https://trading-goals.web.app/health
2. Sign in if prompted
3. Click "Refresh" to run health checks
4. Verify all integrations show status

---

## Expected Results

### After Backend Deployment

Health endpoint should return:
```json
{
  "timestamp": "2026-09-18T08:00:00.000Z",
  "categories": [
    {
      "name": "Market Data",
      "critical": true,
      "integrations": [
        {
          "name": "Polygon",
          "key": "POLYGON_API_KEY",
          "status": "healthy",
          "responseTime": 145,
          "lastChecked": "2026-09-18T08:00:00.000Z",
          "message": "OK",
          "isPaid": true
        },
        ...
      ]
    },
    ...
  ]
}
```

### After Frontend Deployment

Users should see:
- ✅ "Health Check" link in sidebar navigation
- ✅ `/health` page accessible
- ✅ Categorized tables with status indicators
- ✅ Response times displayed
- ✅ Paid services marked with 💰

---

## Monitoring Health Checks

### Missing API Keys

If an API key is not configured, the health page will show:
- Status: ⚠️ `not_configured`
- Message: "API key not configured"

**Action**: Set the missing API key in Cloud Run environment variables

### Failing Services

If a service check fails:
- Status: ❌ `down`
- Message: Error reason (e.g., "Connection failed", "Authentication failed", "Rate limited")

**Action**: Investigate the specific integration (check API key validity, service status, network)

### Degraded Performance

If a service is slow (>2s response):
- Status: ⚠️ `degraded`
- Message: Response time details

**Action**: Monitor the external service status

---

## Integration Status Guide

### Known Issues / Expected States

| Integration | Expected Status | Notes |
|-------------|----------------|-------|
| **Polygon / Massive** 💰 | ✅ `healthy` | Same vendor (Massive.io rebrand). Key: `POLYGON_API_KEY` or `MASSIVE_API_KEY` |
| Yahoo Finance | ✅ `healthy` | Free, usually works |
| Stooq | ✅ `healthy` | Free, usually works |
| **Finnhub** | ✅ `healthy` | News enrichment — already on Cloud Run |
| NewsAPI | ✅ `healthy` | Extra headlines (`NEWSAPI_API_KEY` on Cloud Run) |
| GDELT | ⚠️ `degraded` / ✅ | Optional public API; often times out or 429s. Finnhub still supplies news |
| **OpenAI** 💰 | ✅ `healthy` | Entry/holding AI (`OPENAI_API_KEY`) |
| FRED | ⚠️ `not_configured` | Free — optional macro data |
| Firestore | ✅ `healthy` | Auto-configured on Cloud Run |
| SQLite | ⚠️ `degraded` | Local only (not on Cloud Run) |
| Slack | ✅ `healthy` | Required for notifications |
| IBKR | ⚠️ `not_configured` | Local only (localhost:5000) |

### Priority: Add FINNHUB_API_KEY

Based on the SDGR analysis, **Finnhub** is critical for news enrichment:
- Get free API key: https://finnhub.io/
- Add to Cloud Run: `FINNHUB_API_KEY=your_key_here`
- This will enable news context for AI evaluations

---

## Troubleshooting

### Backend Deploy Fails

**Permission Denied (Cloud Build)**:
```bash
USE_LOCAL_DOCKER=1 bash scripts/deploy_nest_cloud_run.sh
```

**Docker Not Found**:
Install Docker and authenticate:
```bash
gcloud auth configure-docker us-central1-docker.pkg.dev
```

### Frontend Deploy Fails

**Firebase Not Authenticated**:
```bash
firebase login
```

**Wrong Project**:
```bash
firebase use trading-goals
```

### Health Checks Return 401

Backend requires authenticated session. Ensure:
1. User is signed in via Google OAuth
2. Session cookie is present
3. `SessionAuthGuard` is working

### Health Checks Timeout

All checks have 5-second timeout. If backend is slow:
1. Check Cloud Run cold start time
2. Verify external service latency
3. Consider increasing timeout in `health.service.ts`

---

## CI/CD (Future)

The repository has GitHub Actions configured for deploy-on-main:
- `.github/workflows/deploy-on-main.yml`

After manual deployment is verified, pushes to `main` will auto-deploy:
- Backend changes → Cloud Run
- Frontend changes → Firebase Hosting

See: `docs/deploy-github-actions.md`

---

## Next Steps

1. ✅ **Backend Deploy**
   ```bash
   bash scripts/deploy.sh be
   ```

2. ✅ **Add Missing API Keys** (especially `FINNHUB_API_KEY`)
   - Cloud Console: Cloud Run → trading-signals-api → Edit
   - Or via `gcloud run services update`

3. ✅ **Frontend Deploy**
   ```bash
   bash scripts/deploy.sh fe
   ```

4. ✅ **Verify Health Page**
   - Navigate to: https://trading-goals.web.app/health
   - Click Refresh
   - Check all integrations

5. ✅ **Add Missing Keys**
   - Prioritize: `FINNHUB_API_KEY` (news enrichment)
   - Optional: `NEWSAPI_API_KEY`, `FRED_API_KEY`

---

## Success Criteria ✅

After deployment:
- [ ] Health page accessible at `/health` route
- [ ] All 11 integrations displayed in tables
- [ ] Status indicators show correctly
- [ ] Paid services marked with 💰
- [ ] Manual refresh button works
- [ ] Response times displayed
- [ ] FINNHUB_API_KEY configured (for news enrichment)
- [ ] No 401/500 errors on page load

---

## Related Documentation

- Implementation Plan: `docs/health-check-page-plan.md`
- Backend Deploy: `docs/deploy-api-cloud-run.md`
- GitHub Actions: `docs/deploy-github-actions.md`
- News Enrichment: `docs/research/2026-09/news-enrichment-analysis.md`
