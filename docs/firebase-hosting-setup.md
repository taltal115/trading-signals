# Firebase Hosting + dashboard + monitor

Signal-only: the **web UI** and **position monitor** do not execute trades.

## Architecture

- **Angular** (static): Universe, Signals, Positions, Monitor, About — all data via **`HttpClient`** to the **Nest API** ([`backend/`](../backend/)). See [`docs/backend-api.md`](backend-api.md).
- **Nest** uses **firebase-admin**; the browser does **not** bundle the Firebase Web SDK for Auth/Firestore.
- **Firestore** still stores `universe`, **`signals`** (canonical bot runs), optional **`signals_old`** (legacy archive), and `my_positions`; Python jobs and the API write with Admin credentials.

Firestore has no bulk “rename collection” API. To align with that layout, copy or export/import documents (e.g. archive the former auto-id `signals` rows into `signals_old`, then copy deterministic canonical run documents into `signals`, and remove empty superseded collections). Deploy [`firestore.rules`](../firestore.rules) after the data move. Step-by-step scripts: [`docs/firestore-collection-migration.md`](firestore-collection-migration.md). One-off copy from `signals_old` → `signals` with regenerated deterministic ids (not same doc ids): [`scripts/migrate_signals_old_to_signals.py`](../scripts/migrate_signals_old_to_signals.py).

## 1. Firebase Console

1. Enable **Firestore** (Native mode) if not already.
2. **Authentication** with Google is still used **on the server** (OAuth): the Nest app validates Google accounts and resolves Firebase UIDs with Admin. You still need a Google OAuth client and (for production sign-in) consistent allowlists.
3. **Authorized domains** in Firebase remain relevant if you use other Firebase features; for the dashboard, also configure the **Google Cloud OAuth consent screen** and redirect URIs (see backend doc).
4. **`my_positions`** in [`firestore.rules`](../firestore.rules) may still reflect legacy client access. Once traffic is API-only, you can deny direct client reads/writes and rely on Admin SDK from Nest/Python.

## 2. Angular environment

Edit [`frontend/src/environments/environment.ts`](../frontend/src/environments/environment.ts) for local dev. **Production** builds use [`environment.prod.ts`](../frontend/src/environments/environment.prod.ts) via `fileReplacements` in [`angular.json`](../frontend/angular.json) (`devAuthBypass: false`, same `apiBaseUrl` rules):

- **`apiBaseUrl`**: `''` when the SPA is served from the same origin as `/api`, or the full API origin if cross-origin.
- **`devAuthBypass`**: `true` only on localhost in the default `environment.ts` — skips shell redirect to `/login` while you use `AUTH_BYPASS_LOCAL` on the API.
- **`allowedSignInEmails`** / **`allowedAuthUids`**: should match the Nest env vars `ALLOWED_SIGN_IN_EMAILS` and `ALLOWED_AUTH_UIDS` for consistent gating in the UI.

There is **no** `firebase` web config object in the Angular bundle for runtime.

**If sign-in looks “stuck”:**

- Confirm `GET /api/auth/me` returns a user after OAuth (cookie `signals.sid`, `withCredentials: true`).
- Check CORS: `FRONTEND_URL` on the server must match the SPA origin; in dev, `ng serve` uses [`proxy.conf.json`](../frontend/proxy.conf.json) so the browser only talks to `:4200`.
- Google OAuth redirect URI must match how you load the app (e.g. `http://localhost:4200/api/auth/google/callback` with the dev proxy).

## 3. Build the Angular app, deploy rules, indexes, and Hosting

Install the [Firebase CLI](https://firebase.google.com/docs/cli) and log in:

```bash
npm install -g firebase-tools
firebase login
```

Set the correct project in [`.firebaserc`](../.firebaserc) (`default` project id).

Build the dashboard (from repo root):

```bash
cd frontend
npm ci
npx ng build
cd ..
```

`frontend/.npmrc` sets **`cache=.npm-cache`** so installs use a repo-local cache. That avoids **`EACCES`** on `~/.npm` when an old npm run left **root-owned** files there.

[`firebase.json`](../firebase.json) **`hosting.public`** points at **`frontend/dist/trading-signals-web/browser`** (Angular application builder output).

```bash
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only hosting
```

Deploy or run the **Nest API** separately and point your reverse proxy or `apiBaseUrl` at it ([`docs/backend-api.md`](backend-api.md)). For **Cloud Run + Hosting** (same-origin `/api`), follow [`docs/deploy-api-cloud-run.md`](deploy-api-cloud-run.md).

If the UI shows permission errors against Firestore **from the browser**, ensure you are not still using a legacy client SDK build; current builds only call `/api/...`.

## 4. Collections

| Collection     | Writer            | Purpose                                   |
| -------------- | ----------------- | ----------------------------------------- |
| `universe`     | Admin (discovery) | Daily symbol snapshot                     |
| `signals`      | Admin (signals bot) | BUY run payloads                        |
| `my_positions` | API + allowlisted user context | Manual fills; exit price + P/L |

## 5. Position monitor (GitHub Actions)

Workflow: [`.github/workflows/position-monitor.yml`](../.github/workflows/position-monitor.yml).

**Secrets:**

- `GOOGLE_APPLICATION_CREDENTIALS` — same as other workflows: full service account JSON text in the GitHub secret (see README).
- `SLACK_BOT_TOKEN` / `SLACK_CHANNEL` — optional; omit to log only in Actions.
- `MONITOR_OWNER_UID` — optional; restrict to one Firebase Auth `uid` (empty = all open positions).

**Note:** Alerts use **daily** last closes from free providers; bracket triggers are **indicative**, not real-time.
