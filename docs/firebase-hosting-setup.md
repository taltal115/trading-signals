# Firebase Hosting + dashboard + monitor

Signal-only: the **web UI** and **position monitor** do not execute trades.

## 1. Firebase Console

1. Enable **Firestore** (Native mode) if not already.
2. Enable **Authentication** → **Sign-in method** → **Google** (and add a support email if prompted).
3. **Authorized domains** must include your Hosting domain (e.g. `*.web.app`, `*.firebaseapp.com`) and any custom domain you use. On **`localhost` / `127.0.0.1`**, **Google Auth is disabled**: the app opens the dashboard **without** a login screen, **read-only** for Universe & Signals (`web/app.js`). **`my_positions`** still requires the deployed URL and Google sign-in.
4. **`my_positions`** in [`firestore.rules`](../firestore.rules) is restricted to **Google** sign-in and a single allowlisted email (`taltal115@gmail.com`). If you change the email, update both `firestore.rules` and `allowedSignInEmails` in [`web/firebase-config.js`](../web/firebase-config.js).

## 2. Web app config

1. Project settings → Your apps → Web → register app → copy the `firebaseConfig` object.
2. Paste into [`web/firebase-config.js`](../web/firebase-config.js) (or copy from [`web/firebase-config.example.js`](../web/firebase-config.example.js)).
3. Set **`allowedSignInEmails`** to the same list you enforce in `firestore.rules` (client signs out unauthorized accounts before they rely on server errors).

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
