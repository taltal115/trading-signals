# Deploy Nest API to Cloud Run (Firebase / Firestore)

The API does **not** run “on Firestore.” It runs on **Cloud Run** and talks to **Firestore** with **firebase-admin** (same Firebase/GCP project as your Hosting site). This matches [Firebase Hosting → Cloud Run rewrites](https://firebase.google.com/docs/hosting/cloud-run).

## Before `firebase deploy --only hosting`

If [`firebase.json`](../firebase.json) rewrites `/api/**` to Cloud Run, **that service must exist first** or Hosting finalization fails with:

`Cloud Run service trading-signals-api does not exist in region us-central1`.

From the **repo root**, with `gcloud` authenticated and APIs enabled (Cloud Build, Artifact Registry, Cloud Run):

```bash
bash scripts/deploy_nest_cloud_run.sh
```

If **`gcloud builds submit` returns `PERMISSION_DENIED`**, your Google account needs permission to run Cloud Build on the project (see **Troubleshooting** below), **or** build with local Docker (Artifact Registry push still needs IAM, usually lighter than Cloud Build):

```bash
USE_LOCAL_DOCKER=1 bash scripts/deploy_nest_cloud_run.sh
```

Override defaults if needed: `GCP_PROJECT=… GCP_REGION=us-central1 CLOUD_RUN_SERVICE=trading-signals-api bash scripts/deploy_nest_cloud_run.sh`

Then set **environment variables / secrets** on the Cloud Run service (step 3 below), then run `firebase deploy --only hosting`.

## Why Hosting rewrites `/api`

Keeping `apiBaseUrl: ''` in the Angular production build means the browser calls `https://<your-site>/api/...`. Firebase Hosting forwards those requests to your Cloud Run service. You get one origin, so session cookies and Google OAuth redirects stay consistent.

## 1. Prerequisites

- Firebase project (see [`.firebaserc`](../.firebaserc)) and **Firestore** enabled.
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud`) and [Firebase CLI](https://firebase.google.com/docs/cli).
- Billing enabled on the GCP project (Cloud Run).

## 2. Build and deploy the API image

From the **repo root**, using the Dockerfile in [`backend/`](../backend/Dockerfile):

```bash
export GCP_PROJECT=trading-goals
export REGION=us-central1
export SERVICE=trading-signals-api

gcloud config set project "$GCP_PROJECT"
gcloud auth configure-docker "${REGION}-docker.pkg.dev"

IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT}/cloud-run-source-deploy/${SERVICE}:$(date +%Y%m%d-%H%M)"
docker build -t "$IMAGE" ./backend
docker push "$IMAGE"
```

Deploy to Cloud Run (adjust memory/CPU as needed):

```bash
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080
```

`--allow-unauthenticated` is normal: your app still enforces sessions on protected routes; Google’s edge handles TLS only.

## 3. Environment variables and secrets

Set production configuration on the service (example — use Secret Manager for sensitive values):

| Variable | Notes |
| -------- | ----- |
| `NODE_ENV` | `production` |
| `PORT` | `8080` (Cloud Run sets this automatically if you omit it) |
| `SESSION_SECRET` | Strong random string (Secret Manager recommended) |
| `FRONTEND_URL` | Exact SPA origin, e.g. `https://trading-goals.web.app` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth Web client |
| `GOOGLE_CALLBACK_URL` | **`{FRONTEND_URL}/api/auth/google/callback`** when using Hosting `/api` rewrite |
| `ALLOWED_SIGN_IN_EMAILS` / `ALLOWED_AUTH_UIDS` | Same allowlists as the Angular env |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Full service account JSON (Secret Manager → env), **or** rely on the Cloud Run service account with IAM roles for Firestore (see below) |
| `FINNHUB_API_KEY` | **Required** for `/api/market/quote` and `/api/market/stock-snapshot`. Same key as local `.env`. |
| `TWELVE_DATA_API_KEY` / `ALPHA_VANTAGE_API_KEY` | **Strongly recommended** for `/api/market/candles` (dashboard charts): Finnhub **free** plans usually return **403** on `stock/candle`, so the API uses Twelve Data / Alpha Vantage first when these are set. |
| `GITHUB_PERSONAL_TOKEN` | **Required** for `POST /api/github/workflows/*` (AI eval, bot scan, position monitor). Not bundled in the frontend. |

### Market data (`503` “FINNHUB_API_KEY is not set on the API server”)

The Nest **Market** module reads **`FINNHUB_API_KEY`** from the environment (see [`.env.example`](../.env.example)). **Local `.env` is not used on Cloud Run** unless you copy those variables onto the service.

1. Cloud Run → **trading-signals-api** (or your `CLOUD_RUN_SERVICE`) → **Edit & deploy new revision** → **Variables & secrets**.
2. Add **`FINNHUB_API_KEY`** with your Finnhub token (or use Secret Manager and reference it).
3. Prefer **`--update-env-vars`** so you do not remove existing OAuth/session vars:

```bash
gcloud run services update trading-signals-api --region us-central1 \
  --update-env-vars "FINNHUB_API_KEY=your_token_here"
```

If **`MARKET_DATA_ENABLED=false`**, all `/api/market/*` routes return 503 with a different message (feature off).

### Daily candles (`503` Finnhub plan / “Configure TWELVE_DATA…”)

**Quotes** use Finnhub; **daily OHLC candles** try **Twelve Data** first, then **Alpha Vantage**, then Finnhub. On many **free** Finnhub tiers, **`stock/candle` returns 403**; the service then opens a short cooldown and returns 503 unless Twelve Data or Alpha Vantage is configured.

Set at least one of these on **Cloud Run** (same values as local `.env`):

```bash
gcloud run services update trading-signals-api --region us-central1 \
  --update-env-vars "TWELVE_DATA_API_KEY=your_key"
# and/or
gcloud run services update trading-signals-api --region us-central1 \
  --update-env-vars "ALPHA_VANTAGE_API_KEY=your_key"
```

Nest also accepts `ALPHAVANTAGE_API_KEY` (no underscore) for compatibility with Python env files.

### GitHub workflow buttons (`503` “workflow dispatch is not configured”)

If the UI calls `https://<your-host>/api/github/workflows/ai-stock-eval` (or `bot-scan` / `position-monitor`) and the API returns **503** with a message about `GITHUB_PERSONAL_TOKEN`, the Cloud Run service does not have that variable set.

1. Create a **GitHub PAT** that can dispatch Actions on this repo:
   - **Classic:** `repo` (or scoped to this repo) + **`workflow`** scope.
   - **Fine-grained:** repository access to `trading-signals`, permissions **Actions: Read and write**.
2. On Cloud Run → your service → **Variables & secrets** → add **`GITHUB_PERSONAL_TOKEN`** (prefer **Secret Manager** reference for the value).
3. Use **`--update-env-vars`** (or the console) so you do **not** wipe existing OAuth/Firestore vars:

```bash
gcloud run services update trading-signals-api --region us-central1 \
  --update-env-vars "GITHUB_PERSONAL_TOKEN=ghp_xxxxxxxx"
```

Avoid pasting the PAT in shell history on shared machines; use the console or a secret.

Example (inline env — prefer secrets for production):

```bash
gcloud run services update "$SERVICE" --region "$REGION" \
  --set-env-vars "NODE_ENV=production,FRONTEND_URL=https://YOUR_HOSTING_ORIGIN"
```

**Firestore access without pasting JSON:** Grant the Cloud Run **runtime service account** (often `PROJECT_NUMBER-compute@developer.gserviceaccount.com`) roles such as **Cloud Datastore User** (and any roles you use for Firebase Auth admin lookups). Then you can omit `FIREBASE_SERVICE_ACCOUNT_JSON` if `firebase-admin` initializes with application default credentials (the code path in [`FirestoreService`](../backend/src/firebase/firestore.service.ts) when `FIREBASE_SERVICE_ACCOUNT_JSON` is unset).

## 4. Firebase Hosting rewrite

**Order matters:** Firebase rejects a deploy if `firebase.json` points `/api/**` at a Cloud Run service that **does not exist yet** (`Cloud Run service … does not exist in region …`). The repo’s [`firebase.json`](../firebase.json) therefore ships with **SPA-only** rewrites so `firebase deploy --only hosting` works before Cloud Run exists.

**After** `gcloud run deploy trading-signals-api` (same name and region you will reference), edit `firebase.json` → `hosting.rewrites` to put the Cloud Run rule **above** the catch-all:

```json
"rewrites": [
  {
    "source": "/api/**",
    "run": {
      "serviceId": "trading-signals-api",
      "region": "us-central1"
    }
  },
  { "source": "**", "destination": "/index.html" }
],
```

Then:

```bash
cd frontend && npm ci && npx ng build --configuration=production && cd ..
firebase deploy --only hosting
```

The CLI may ask to link Hosting to Cloud Run; accept so the rewrite is allowed.

**Until you add that block,** the SPA loads but `/api/*` is not proxied—set `apiBaseUrl` in Angular to your Cloud Run `https://….run.app` URL if you need the API before enabling the rewrite (watch CORS + cookies; same-origin rewrite is preferable long-term).

## 5. OAuth console

In [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials), add **Authorized redirect URI**:

`https://<YOUR_HOSTING_DOMAIN>/api/auth/google/callback`

## 6. Verify

- `GET https://<YOUR_HOSTING_DOMAIN>/api/health`
- Sign in and confirm `GET /api/auth/me` with cookies.

## Troubleshooting

- **`PERMISSION_DENIED` on `gcloud builds submit`:** The account you use with `gcloud` (e.g. your Gmail) must be allowed to create Cloud Build jobs and upload sources. In [GCP Console → IAM](https://console.cloud.google.com/iam-admin/iam?project=trading-goals), for project **trading-goals**, grant your user one of:
  - **Cloud Build Editor** (`roles/cloudbuild.builds.editor`), plus **Storage** access to the Cloud Build staging bucket if prompted; or
  - **Editor** (`roles/editor`) on a personal dev project (broad but common for solo projects); or
  - Have a **project Owner** add you with the right roles.
  Then retry `bash scripts/deploy_nest_cloud_run.sh`.  
  **Workaround:** `USE_LOCAL_DOCKER=1 bash scripts/deploy_nest_cloud_run.sh` (requires [Docker](https://docs.docker.com/get-docker/) and usually **Artifact Registry Writer** `roles/artifactregistry.writer` or **Editor** to push the image).
- **`Cloud Run service … does not exist` on `firebase deploy`:** Create the service first with [`scripts/deploy_nest_cloud_run.sh`](../scripts/deploy_nest_cloud_run.sh) (or step 2 manually), then redeploy Hosting—or temporarily use SPA-only rewrites in `firebase.json` and set `apiBaseUrl` in [`environment.prod.ts`](../frontend/src/environments/environment.prod.ts) to the Cloud Run URL.
- **302 / OAuth loop:** `FRONTEND_URL`, `GOOGLE_CALLBACK_URL`, and Hosting URL must align; session cookie needs `Secure` in production (already set when `NODE_ENV=production`).
- **403 Firestore:** Runtime service account lacks Firestore IAM, or `FIREBASE_SERVICE_ACCOUNT_JSON` is wrong project.
- **CORS:** With Hosting rewrite, the browser should not need a separate API origin; if you call a bare `*.run.app` URL from the SPA, add that origin in `main.ts` CORS or prefer the single-hosting origin only.
