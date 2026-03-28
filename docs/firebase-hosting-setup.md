# Firebase Hosting + dashboard + monitor

Signal-only: the **web UI** and **position monitor** do not execute trades.

## 1. Firebase Console

1. Enable **Firestore** (Native mode) if not already.
2. Enable **Authentication** → **Sign-in method** → **Google** (and add a support email if prompted).
3. **Authorized domains** must include your Hosting domain (e.g. `*.web.app`, `*.firebaseapp.com`) and any custom domain you use. **`localhost` is not required** for the Google button: the dashboard **does not start Google OAuth on localhost** (see `web/app.js`). You normally sign in on the **deployed** URL; the browser may persist that session if you later open `http://localhost`, but OAuth redirect is only used off-localhost.
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

## 4. Collections

| Collection         | Writer              | Purpose                                      |
| ------------------ | ------------------- | -------------------------------------------- |
| `universe`         | Admin (discovery)   | Daily symbol snapshot                        |
| `signals`          | Admin (signals bot) | BUY run payloads                             |
| `my_positions`     | Allowlisted user    | Manual fills / brackets; exit price + P/L    |

## 5. Position monitor (GitHub Actions)

Workflow: [`.github/workflows/position-monitor.yml`](../.github/workflows/position-monitor.yml).

**Secrets:**

- `FIREBASE_SERVICE_ACCOUNT_JSON` — service account JSON string (same as other workflows).
- `SLACK_BOT_TOKEN` / `SLACK_CHANNEL` — optional; omit to log only in Actions.
- `MONITOR_OWNER_UID` — optional; restrict to one Firebase Auth `uid` (empty = all open positions).

**Note:** Alerts use **daily** last closes from free providers; bracket triggers are **indicative**, not real-time.
