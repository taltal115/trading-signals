# Firebase Hosting + dashboard + monitor

Signal-only: the **web UI** and **position monitor** do not execute trades.

## 1. Firebase Console

1. Enable **Firestore** (Native mode) if not already.
2. Enable **Authentication** → **Sign-in method** → **Google** (and add a support email if prompted).
3. **Authorized domains** must include your Hosting domain (e.g. `*.web.app`, `*.firebaseapp.com`) and any custom domain you use. On **`localhost` / `127.0.0.1`**, **Google sign-in is disabled**: `/login` and `/logout` redirect to **`/dashboard`**, the Sign-in link is hidden, and the dashboard is **read-only** for Universe & Signals (`web/app.js`). **`my_positions`** needs the deployed URL with Google sign-in.
4. **`my_positions`** in [`firestore.rules`](../firestore.rules) is restricted to **Google** sign-in and a single allowlisted email (`taltal115@gmail.com`). If you change the email, update both `firestore.rules` and `allowedSignInEmails` in [`web/firebase-config.js`](../web/firebase-config.js).

## 2. Web app config

1. Project settings → Your apps → Web → register app → copy the `firebaseConfig` object.
2. Paste into [`web/firebase-config.js`](../web/firebase-config.js) (or copy from [`web/firebase-config.example.js`](../web/firebase-config.example.js)).
3. Set **`allowedSignInEmails`** to the same list you enforce in `firestore.rules` (client signs out unauthorized accounts before they rely on server errors).
4. **`authDomain`** in `firebase-config.js` should stay the value from the Firebase console (usually `YOUR_PROJECT_ID.firebaseapp.com`). That is correct even when users open the app at **`YOUR_PROJECT_ID.web.app`** — both are authorized Hosting domains by default.

**If sign-in looks “stuck” (spinner / never leaving `/login`):**

- Ensure **Authentication → Settings → Authorized domains** lists both `your-project.firebaseapp.com` and `your-project.web.app` (and any custom domain). Add missing entries, redeploy is not required for that change.
- The app uses **`signInWithRedirect`** only. Bootstrap order is **`getRedirectResult` → `authStateReady` → sync user into the shell → `onAuthStateChanged`**, so redirect completion is not racing the UI. A full-page **“Loading…”** overlay hides the fact that both the login card and main shell start hidden until auth finishes.
- Hosting sends **`Cross-Origin-Opener-Policy: same-origin-allow-popups`** (see [`firebase.json`](../firebase.json)) so strict default COOP does not break any auth-helper popups the SDK may open briefly.
- Third-party cookie / IT policies can still block auth in some browsers; try another browser or network rule.

The API key is **public**; access control is enforced with [`firestore.rules`](../firestore.rules). **`universe` and `signals` are world-readable** so the dashboard can load without sign-in; **`my_positions`** is only readable/writable by the allowlisted Google account. Tighten `universe` / `signals` rules to `request.auth != null` if you want everything behind login.

## 3. Deploy rules, indexes, and Hosting

Install the [Firebase CLI](https://firebase.google.com/docs/cli) and log in:

```bash
npm install -g firebase-tools
firebase login
```

Set the correct project in [`.firebaserc`](../.firebaserc) (`default` project id).

```bash
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only hosting
```

If the UI shows **Missing or insufficient permissions** for Universe or Signals, the rules in this repo are not deployed to the **same** project as `web/firebase-config.js` — run `firebase deploy --only firestore:rules` from this repo (check `.firebaserc` default project id).

For **My positions** (client SDK):

1. **Firestore rules** (see [`firestore.rules`](../firestore.rules)): any **signed-in** user may only read/write documents where **`owner_uid == request.auth.uid`**. Queries must filter **`owner_uid`** with the current user (the dashboard does this). There is **no email check in rules** (JWT `email` was unreliable after redirect).
2. **Who may use the app** is still limited in **`web/firebase-config.js`** via `allowedSignInEmails` / optional `allowedAuthUids` (client signs out others). Tighten **Firebase Authentication** (e.g. authorized domains / providers) for your project if you need stronger gatekeeping.
3. **`permission-denied`**: deploy rules to the **same** project as `firebase-config.js` (`firebase deploy --only firestore:rules`) and confirm **Firestore → Rules** in the console matches this repo.

On **`localhost` / `127.0.0.1`**, the web app **never shows Google login**: `/login` and `/logout` redirect to **`/dashboard`**, and the Sign-in control is hidden (read-only Universe & Signals).

Server scripts use the **Admin** SDK and **ignore** these rules.

Index builds can take a few minutes. The dashboard queries use `orderBy("ts_utc")`; if the console shows a link to create an index, open it.

**URL routes:** The dashboard uses **`/universe`**, **`/signals`**, and **`/positions`** (History API). [`firebase.json`](../firebase.json) rewrites unknown paths to `index.html` so refreshes and deep links work on Hosting. Plain `python3 -m http.server` does **not** serve those paths on reload; use **`firebase serve`** from the repo for local deep-link testing, or open the app at `/` and navigate only via in-app tabs.

## 4. Collections

| Collection         | Writer              | Purpose                                      |
| ------------------ | ------------------- | -------------------------------------------- |
| `universe`         | Admin (discovery)   | Daily symbol snapshot                        |
| `signals`          | Admin (signals bot) | BUY run payloads                             |
| `my_positions`     | Allowlisted user    | Manual fills / brackets; exit price + P/L    |

## 5. Position monitor (GitHub Actions)

Workflow: [`.github/workflows/position-monitor.yml`](../.github/workflows/position-monitor.yml).

**Secrets:**

- `GOOGLE_APPLICATION_CREDENTIALS` — same as other workflows: full service account JSON text in the GitHub secret (see README).
- `SLACK_BOT_TOKEN` / `SLACK_CHANNEL` — optional; omit to log only in Actions.
- `MONITOR_OWNER_UID` — optional; restrict to one Firebase Auth `uid` (empty = all open positions).

**Note:** Alerts use **daily** last closes from free providers; bracket triggers are **indicative**, not real-time.
