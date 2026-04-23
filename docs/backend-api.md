# NestJS API (Firebase Admin)

The Angular dashboard talks to this API over HTTP (`HttpClient`, `withCredentials: true`). The browser does **not** load the Firebase Web SDK for Firestore or Auth; the server uses **firebase-admin** and enforces allowlists.

## Layout

- Code: [`backend/`](../backend/) at repo root (Python `src/` is unchanged).
- Global route prefix: **`/api`** (e.g. `GET /api/health`).
- Auth: **Google OAuth** via Passport → **express-session** cookie (`signals.sid`, HTTP-only).

## Environment variables

| Variable | Purpose |
| -------- | ------- |
| `PORT` | Listen port (default `3000`). |
| `NODE_ENV` | `production` enables `secure` session cookies and disables local auth bypass. |
| `SESSION_SECRET` | Session HMAC secret (required in production). |
| `FRONTEND_URL` | SPA origin for CORS and post-login redirect (e.g. `http://localhost:4200`). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth app credentials. |
| `GOOGLE_CALLBACK_URL` | Optional. Defaults to `{FRONTEND_URL}/api/auth/google/callback` (works with `ng serve` + [`frontend/proxy.conf.json`](../frontend/proxy.conf.json)). |
| `ALLOWED_SIGN_IN_EMAILS` | Comma-separated allowlist (lowercased server-side). |
| `ALLOWED_AUTH_UIDS` | Comma-separated Firebase Auth UIDs allowed after Google sign-in (resolved via Admin `getUserByEmail`). |
| `AUTH_BYPASS_LOCAL` | Set `true` for local dev only; uses `DEV_OWNER_UID` for all Firestore access. **Never** in production. |
| `DEV_OWNER_UID` | Firebase Auth UID used when bypass is active. |
| `DEV_USER_EMAIL` | Optional label for logs when bypass is active. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service account JSON, **or** |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Inline JSON string for the service account. |
| `GITHUB_PERSONAL_TOKEN` | (Optional but required for **Check** / **Re-eval** buttons.) PAT with Actions workflow dispatch permission; **server-only**, never in the Angular bundle. Also accepts `GITHUB_TOKEN`. |
| `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME` | Optional; default `taltal115` / `trading-signals`. |

Align `ALLOWED_*` with [`frontend/src/environments/environment.ts`](../frontend/src/environments/environment.ts) `allowedSignInEmails` / `allowedAuthUids` for consistent UX.

## Environment file

You can keep variables in the **repo-root** [`.env`](../.env) (gitignored). `ConfigModule` loads **`backend/.env`** first, then **`../.env`**, so `cd backend && npm run start:dev` still picks up the root file.

**`GOOGLE_APPLICATION_CREDENTIALS`:** paths are resolved from **process cwd**. If the JSON lives in the repo root and you start Nest from `backend/`, use an **absolute** path or a path like **`../your-service-account.json`**. Alternatively set **`FIREBASE_SERVICE_ACCOUNT_JSON`** (inline JSON) in `.env`.

See [`.env.example`](../.env.example) for all keys.

## Local development

Terminal 1 — API (example with exports):

```bash
cd backend
npm ci
export SESSION_SECRET=local-dev-secret
export AUTH_BYPASS_LOCAL=true
export DEV_OWNER_UID=your_firebase_auth_uid
export FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
# or: export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json
export ALLOWED_SIGN_IN_EMAILS=you@example.com
export ALLOWED_AUTH_UIDS=your_uid
npm run start:dev
```

Or put the same keys in **repo-root `.env`** and run `npm run start:dev` from `backend/` (no `export` needed).

Terminal 2 — Angular (proxies `/api` → `http://localhost:3000`):

```bash
cd frontend
npm ci
npm start
```

Open `http://localhost:4200`. The shell guard skips `/login` when `environment.devAuthBypass` is true (localhost only in `environment.ts`).

For real Google sign-in locally, set `AUTH_BYPASS_LOCAL=false`, provide `GOOGLE_*`, and add the OAuth **Authorized redirect URI** in Google Cloud Console:  
`http://localhost:4200/api/auth/google/callback` (same path the SPA proxies to the API).

## Main HTTP routes

- `GET /api/health` — liveness.
- `GET /api/auth/me` — `{ user: { uid, email?, ... } | null }`.
- `GET /api/auth/google` — start OAuth.
- `GET /api/auth/google/callback` — OAuth callback; sets session; redirects to `FRONTEND_URL/dashboard`.
- `POST /api/auth/logout` — clears session.
- `GET /api/universe`, `GET /api/signals` — public reads (mirrors previous client limits).
- `GET|POST|PATCH /api/positions...`, `GET /api/monitor/checks` — session required (or bypass user).
- `POST /api/github/workflows/position-monitor` — body `{ "ticker": "AAPL" }`; dispatches `position-monitor.yml` (dashboard **Check**).
- `POST /api/github/workflows/bot-scan` — body `{ "ticker": "AAPL" }`; dispatches `trading-bot-scan.yml` (**Re-eval**). Both require session + `GITHUB_PERSONAL_TOKEN` on the server.

## Google OAuth troubleshooting (`401 invalid_client` / “OAuth client was not found”)

Google returns this when **`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on the Nest process do not match** a valid **OAuth 2.0 Client ID** (type **Web application**) in [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials) for the **same GCP project** you use for Firebase (`trading-goals`).

Checklist:

1. **Cloud Run / server env:** Open the Cloud Run service → **Variables & secrets** and confirm `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set (no extra spaces/quotes; secret must be the client’s **secret**, not the JSON file).
2. **Client exists:** In Credentials, open that client — it must not be deleted. If unsure, create a new **Web client** and paste the new ID + secret into Cloud Run, then redeploy.
3. **Authorized redirect URIs** (must match how users reach `/api/auth/google/callback`):
   - **Hosting + `/api` rewrite to Cloud Run:** `https://trading-goals.web.app/api/auth/google/callback` (and `https://trading-goals.firebaseapp.com/...` if you use that host), plus any custom domain.
   - **Local dev with proxy:** `http://localhost:4200/api/auth/google/callback`
4. **`GOOGLE_CALLBACK_URL` on Nest** must be exactly that same URI (scheme + host + path). If unset, it defaults to `{FRONTEND_URL}/api/auth/google/callback` — so **`FRONTEND_URL` must be the SPA origin** (e.g. `https://trading-goals.web.app`), not the Cloud Run `run.app` URL, when using Hosting rewrites.
5. **OAuth consent screen:** For accounts outside a test user list, the app may need to be **In production** or the signing-in user added as a **test user** (while in Testing).
6. **`.env` formatting:** Do not wrap `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in quotes unless the whole value is quoted; stray characters break Google’s client lookup (`invalid_client`). Nest loads **`backend/.env` first**, then **repo-root `.env`** (later file wins on duplicate keys). After `cd backend`, run the API so both paths resolve; check startup log: `Google OAuth client_id loaded` vs `GOOGLE_CLIENT_ID is empty`.
7. **`GET /api/positions` returns 500:** Often **Firestore composite index** missing. Deploy [`firestore.indexes.json`](../firestore.indexes.json): `firebase deploy --only firestore:indexes`, wait until indexes show **Enabled** in console, retry.

## Production deployment

**Recommended (Firebase + Firestore in one project):** deploy the API to **Cloud Run** and use **Firebase Hosting** rewrites so `/api/**` hits Cloud Run while the SPA stays on the same origin. Step-by-step: [`docs/deploy-api-cloud-run.md`](deploy-api-cloud-run.md).

Alternatively host Nest on a VM or another Node platform and either:

- Put a reverse proxy in front of both (same site → cookie `SameSite=Lax` works well), or
- Run the API on a dedicated subdomain and configure CORS + cookies (`secure: true`, correct `FRONTEND_URL`).

After all reads/writes go through the API, consider tightening [`firestore.rules`](../firestore.rules) so clients cannot access Firestore directly (optional follow-up).
