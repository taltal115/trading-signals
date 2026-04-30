# Multi-user `my_positions`

The app keeps a single Firestore collection `my_positions`. Each document has `owner_uid` (enforced server-side); **new opens** also store **`owner_email`** and **`owner_display_name`** snapshots from the signed-in session (clients cannot spoof `owner_*` fields).

## Production (2–3 Gmail accounts)

- **Nest:** set `ALLOWED_SIGN_IN_EMAILS` and/or `ALLOWED_AUTH_UIDS` to your real teammates (comma-separated).
- **Angular production build:** uncomment or extend the same emails / UIDs in `frontend/src/environments/environment.prod.ts` so sidebar “allowlisted” UX matches the API.
- **Slack monitor:** omit or delete the **`MONITOR_OWNER_UID`** repo secret when you want the scheduled job to walk **every** user’s open rows. Keep the secret populated only when you intentionally monitor a single Firebase uid (`scripts/monitor_open_positions.py --owner-uid` / env). Slack attachments and stdout lines include an **Owner:** tag when profile fields exist.

## Local personas (`DEV_LOCAL_USERS`)

When `AUTH_BYPASS_LOCAL=true` and `NODE_ENV` is not `production`:

1. Set **`DEV_LOCAL_USERS`** to a JSON array, e.g.  
   `[{"uid":"<firebaseUid>","email":"alice@localhost","displayName":"Alice"},{"uid":"...","email":"bob@localhost","displayName":"Bob"}]`  
   Use Firebase Auth uids that match data you write to Firestore (or `ALLOWED_AUTH_UIDS`) if those rows must be visible under rules.
2. Optional legacy single user: **`DEV_OWNER_UID`** + **`DEV_USER_EMAIL`** when **`DEV_LOCAL_USERS`** is empty.
3. Start the Nest API + Angular (`devAuthBypass: true`): the sidebar shows a **Dev user** select when **`GET /api/auth/dev-users`** succeeds. Choices call **`POST /api/auth/dev/persona`** with `{ "uid": "..." }` (sets httpOnly **`dev_persona`** cookie).

## Optional backfill

Legacy rows missing `owner_email` / `owner_display_name`:

```bash
pip install firebase-admin
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  python scripts/backfill_my_positions_owner_profiles.py
```

Use `--dry-run` first. Requires the service account can read `my_positions` and use Firebase Auth Admin (`auth.get_user`).
