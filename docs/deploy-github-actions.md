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

This repo’s `GOOGLE_APPLICATION_CREDENTIALS` is **`firebase-adminsdk-fbsvc@trading-goals.iam.gserviceaccount.com`**. That key is enough for scans and AI jobs. For **Deploy on main** it also needs (already granted on `trading-goals` if you used the setup below):

| Role | Why |
|------|-----|
| `roles/cloudbuild.builds.editor` | `gcloud builds submit` |
| `roles/storage.objectAdmin` | Upload source tarball to `gs://trading-goals_cloudbuild` |
| `roles/artifactregistry.writer` | Cloud Build / push image to `cloud-run` |
| `roles/run.admin` | `gcloud run deploy` |
| `roles/iam.serviceAccountUser` | Act as the Cloud Run runtime SA (`703616057199-compute@…`) |
| `roles/firebasehosting.admin` | `firebase deploy --only hosting` |
| `roles/run.viewer` | Hosting finalize `run.services.get` on `/api/**` rewrite |

If `gcloud builds.submit` still says `PERMISSION_DENIED` as `firebase-adminsdk-fbsvc`, those roles are missing or not propagated yet. Prefer a dedicated deploy SA in `GCP_SA_KEY` if you do not want the Firestore admin key to have Cloud Run / Hosting admin.

```bash
export DEPLOY_SA="firebase-adminsdk-fbsvc@trading-goals.iam.gserviceaccount.com"
export PROJECT="trading-goals"
export COMPUTE_SA="703616057199-compute@developer.gserviceaccount.com"

for role in \
  roles/cloudbuild.builds.editor \
  roles/storage.objectAdmin \
  roles/artifactregistry.writer \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/firebasehosting.admin \
  roles/run.viewer
do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="$role"
done

gcloud iam service-accounts add-iam-policy-binding "$COMPUTE_SA" \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role="roles/iam.serviceAccountUser"
```

### Hosting + Cloud Run rewrite IAM (FE 403)

[`firebase.json`](../firebase.json) rewrites `/api/**` to Cloud Run `trading-signals-api`. When Hosting **finalizes** a version it calls `run.services.get` on that service. Upload can succeed and finalize still fail with:

```text
403 Permission 'run.services.get' denied on resource
'namespaces/<PROJECT_NUMBER>/services/trading-signals-api'
```

Grant **Cloud Run Viewer** (or Admin) to the same SA GitHub uses. This repo’s fallback SA is already `firebase-adminsdk-fbsvc` (see the table above). The dedicated Hosting agent `service-703616057199@gcp-sa-firebasehosting.iam.gserviceaccount.com` is **not created** in this project; Hosting finalize uses the deploy SA instead, so that SA must be able to `run.services.get`.

Then re-run **Deploy on main** with `fe` (or `both`). Do not rely on `FIREBASE_TOKEN` for this deploy: a `firebase login:ci` token is a user identity and often cannot call `run.services.get`. The workflow uses Application Default Credentials from the deploy SA.

### Optional secret

| Secret | Purpose |
|--------|---------|
| `FIREBASE_TOKEN` | From `firebase login:ci`. **Not used** for Hosting on `main` (Cloud Run rewrite IAM). Kept as an unused optional secret so existing repos do not break. |

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
