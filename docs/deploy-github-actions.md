# Deploy from GitHub Actions (merge to main)

On every push to **`main`**, GitHub Actions:

1. Runs the **Quality gate** (backend build, frontend production build, Python unit tests).
2. **Detects** whether the change needs **frontend**, **backend**, **both**, or **neither**.
3. Deploys only what is needed (backend first when both, so Hosting rewrites keep working).

Local deploys are unchanged:

```bash
./scripts/deploy.sh be   # Nest → Cloud Run
./scripts/deploy.sh fe   # Angular → Firebase Hosting
```

## Path → deploy target

| Paths changed | Deploy |
|---------------|--------|
| `backend/**`, `scripts/deploy_nest_cloud_run.sh` | **backend** (Cloud Run) |
| `frontend/**`, `firebase.json`, `.firebaserc`, `web/legacy-vanilla/**` | **frontend** (Hosting) |
| Both sets | **both** (Cloud Run, then Hosting) |
| Docs / Python bot / workflows / research only | **none** (quality still runs) |

Manual override: Actions → **Deploy on main** → Run workflow → choose `fe` / `be` / `both` / `none` / `auto`.

## Required secrets & vars

### Repository secrets (deploy)

| Secret | Purpose |
|--------|---------|
| `GCP_SA_KEY` | **Preferred** — JSON key for a deploy-capable GCP SA (Cloud Run + Hosting) |
| `GOOGLE_APPLICATION_CREDENTIALS` | **Fallback** — same JSON format; already used by bot workflows for Firestore. OK for deploy **only if** that SA also has Cloud Run / Hosting / Artifact Registry (or Cloud Build) roles |

Most projects’ `GOOGLE_APPLICATION_CREDENTIALS` is a **Firebase Admin / Firestore** key. That is enough for scans and AI jobs, but **often fails** Cloud Run / Hosting deploy with `PERMISSION_DENIED`.

Check the SA email inside the JSON (`client_email`), then in GCP IAM confirm it has roughly:

- Cloud Run Admin  
- Service Account User  
- Artifact Registry Writer (and/or Cloud Build Editor)  
- Firebase Hosting Admin  

If those roles are missing, either grant them on that SA or create a dedicated deploy SA and store it as `GCP_SA_KEY`.

### Optional secret

| Secret | Purpose |
|--------|---------|
| `FIREBASE_TOKEN` | From `firebase login:ci`. Used if set; otherwise Hosting uses ADC from `GCP_SA_KEY` / `GOOGLE_APPLICATION_CREDENTIALS`. |

### Optional repository variables

| Variable | Default |
|----------|---------|
| `GCP_PROJECT` | `trading-goals` |
| `GCP_REGION` | `us-central1` |
| `CLOUD_RUN_SERVICE` | `trading-signals-api` |

## Workflows

| File | When |
|------|------|
| [`.github/workflows/quality-gate.yml`](../.github/workflows/quality-gate.yml) | Every PR; also called by deploy |
| [`.github/workflows/deploy-on-main.yml`](../.github/workflows/deploy-on-main.yml) | Push to `main` / manual |

## Notes

- Cloud Run **env vars/secrets are not replaced** by this pipeline (same as `scripts/deploy_nest_cloud_run.sh`). Configure `POLYGON_API_KEY`, OAuth, etc. on the service once.
- First-time setup: create the SA key, add `GCP_SA_KEY`, merge a tiny `backend/` or `frontend/` change (or run workflow_dispatch with `both`) to verify.
- Quality gate failures **block** deploy.
