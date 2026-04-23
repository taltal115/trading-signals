# Deploy Nest API to Cloud Run (Firebase / Firestore)

The API does **not** run “on Firestore.” It runs on **Cloud Run** and talks to **Firestore** with **firebase-admin** (same Firebase/GCP project as your Hosting site). This matches [Firebase Hosting → Cloud Run rewrites](https://firebase.google.com/docs/hosting/cloud-run).

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
| `FINNHUB_API_KEY` / others | As in [`.env.example`](../.env.example) |
| `GITHUB_PERSONAL_TOKEN` | For workflow dispatch buttons |

Example (inline env — prefer secrets for production):

```bash
gcloud run services update "$SERVICE" --region "$REGION" \
  --set-env-vars "NODE_ENV=production,FRONTEND_URL=https://YOUR_HOSTING_ORIGIN"
```

**Firestore access without pasting JSON:** Grant the Cloud Run **runtime service account** (often `PROJECT_NUMBER-compute@developer.gserviceaccount.com`) roles such as **Cloud Datastore User** (and any roles you use for Firebase Auth admin lookups). Then you can omit `FIREBASE_SERVICE_ACCOUNT_JSON` if `firebase-admin` initializes with application default credentials (the code path in [`FirestoreService`](../backend/src/firebase/firestore.service.ts) when `FIREBASE_SERVICE_ACCOUNT_JSON` is unset).

## 4. Firebase Hosting rewrite

[`firebase.json`](../firebase.json) includes a rewrite of `/api/**` to Cloud Run service `trading-signals-api` in `us-central1`. The `serviceId` must match the Cloud Run **service name** you deployed.

After the service exists:

```bash
cd frontend && npm ci && npx ng build --configuration=production && cd ..
firebase deploy --only hosting
```

First deploy of Hosting with a Cloud Run rewrite may prompt to link the service to Firebase; follow the CLI instructions.

## 5. OAuth console

In [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials), add **Authorized redirect URI**:

`https://<YOUR_HOSTING_DOMAIN>/api/auth/google/callback`

## 6. Verify

- `GET https://<YOUR_HOSTING_DOMAIN>/api/health`
- Sign in and confirm `GET /api/auth/me` with cookies.

## Troubleshooting

- **302 / OAuth loop:** `FRONTEND_URL`, `GOOGLE_CALLBACK_URL`, and Hosting URL must align; session cookie needs `Secure` in production (already set when `NODE_ENV=production`).
- **403 Firestore:** Runtime service account lacks Firestore IAM, or `FIREBASE_SERVICE_ACCOUNT_JSON` is wrong project.
- **CORS:** With Hosting rewrite, the browser should not need a separate API origin; if you call a bare `*.run.app` URL from the SPA, add that origin in `main.ts` CORS or prefer the single-hosting origin only.
