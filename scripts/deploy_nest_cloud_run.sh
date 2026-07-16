#!/usr/bin/env bash
# Deploy Nest (backend/Dockerfile) to Cloud Run.
#
# Default: build image with Cloud Build (no local Docker).
# If you get PERMISSION_DENIED on builds submit, either fix IAM (see docs/deploy-api-cloud-run.md)
# or build locally:  USE_LOCAL_DOCKER=1 bash scripts/deploy_nest_cloud_run.sh
#
# Requires: gcloud auth login, project set, billing. Run from repo root.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# gcloud 560+ needs Python 3.10+ (system macOS python3 is often 3.9 → builds module crash).
resolve_cloudsdk_python() {
  if [[ -n "${CLOUDSDK_PYTHON:-}" && -x "${CLOUDSDK_PYTHON}" ]]; then
    echo "${CLOUDSDK_PYTHON}"
    return 0
  fi
  local candidates=(
    "${ROOT}/.venv/bin/python"
    "$(command -v python3.13 2>/dev/null || true)"
    "$(command -v python3.12 2>/dev/null || true)"
    "$(command -v python3.11 2>/dev/null || true)"
    "$(command -v python3.10 2>/dev/null || true)"
    "$(command -v python3 2>/dev/null || true)"
  )
  local py ver major minor
  for py in "${candidates[@]}"; do
    [[ -n "$py" && -x "$py" ]] || continue
    ver="$("$py" -c 'import sys; print(".".join(map(str, sys.version_info[:2])))' 2>/dev/null || true)"
    [[ "$ver" =~ ^([0-9]+)\.([0-9]+)$ ]] || continue
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    if (( major > 3 || (major == 3 && minor >= 10) )); then
      echo "$py"
      return 0
    fi
  done
  return 1
}

if CLOUDSDK_PYTHON="$(resolve_cloudsdk_python)"; then
  export CLOUDSDK_PYTHON
  echo "Using CLOUDSDK_PYTHON=$CLOUDSDK_PYTHON ($("$CLOUDSDK_PYTHON" --version 2>&1 | head -1))"
else
  echo "ERROR: gcloud needs Python 3.10+. Install one (e.g. brew install python@3.11) or set CLOUDSDK_PYTHON." >&2
  echo "  export CLOUDSDK_PYTHON=/path/to/python3.11" >&2
  exit 1
fi

PROJECT="${GCP_PROJECT:-trading-goals}"
REGION="${GCP_REGION:-us-central1}"
SERVICE="${CLOUD_RUN_SERVICE:-trading-signals-api}"
TAG="$(date +%Y%m%d-%H%M%S)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/cloud-run/${SERVICE}:${TAG}"
USE_LOCAL_DOCKER="${USE_LOCAL_DOCKER:-0}"

echo "Project=$PROJECT Region=$REGION Service=$SERVICE"
gcloud config set project "$PROJECT"

if ! gcloud artifacts repositories describe cloud-run --location="${REGION}" >/dev/null 2>&1; then
  echo "Creating Artifact Registry repo 'cloud-run' in ${REGION}..."
  gcloud artifacts repositories create cloud-run \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Trading signals Nest API"
fi

if [[ "${USE_LOCAL_DOCKER}" == "1" || "${USE_LOCAL_DOCKER}" == "true" ]]; then
  echo "Building image locally with Docker..."
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not in PATH. Install Docker Desktop or use Cloud Build after IAM is fixed." >&2
    exit 1
  fi
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
  docker build -t "${IMAGE}" "${ROOT}/backend"
  docker push "${IMAGE}"
else
  echo "Building image via Cloud Build (context: backend/)..."
  if ! gcloud builds submit "${ROOT}/backend" --tag "${IMAGE}"; then
    echo "" >&2
    echo "Cloud Build failed. Common causes:" >&2
    echo "  • PERMISSION_DENIED — fix IAM (see docs/deploy-api-cloud-run.md)" >&2
    echo "  • gcloud Python 3.9 crash on 'unsupported operand type |' — script sets CLOUDSDK_PYTHON;" >&2
    echo "    if this persists: export CLOUDSDK_PYTHON=\$(which python3.11)" >&2
    echo "  • Or build locally: USE_LOCAL_DOCKER=1 bash scripts/deploy_nest_cloud_run.sh" >&2
    exit 1
  fi
fi

echo "Deploying to Cloud Run..."
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080

echo ""
echo "Service URL (set Nest env vars on this service before relying on prod auth/data):"
gcloud run services describe "${SERVICE}" --region="${REGION}" --format='value(status.url)'
echo ""
echo "Next: configure env/secrets on the service, then: firebase deploy --only hosting"
echo ""
echo "IMPORTANT: use --update-env-vars (or the console) to add keys. Plain --set-env-vars"
echo "           replaces ALL env vars and drops GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET if omitted."
echo ""
echo "POST /api/github/workflows/* returns 503 until GITHUB_PERSONAL_TOKEN is set on Cloud Run."
echo "  Google Cloud console → Cloud Run → ${SERVICE} → Edit & deploy new revision → Variables"
echo "  or: gcloud run services update ${SERVICE} --region=${REGION} --update-env-vars=GITHUB_PERSONAL_TOKEN=YOUR_PAT"
echo "  PAT: classic with 'workflow' scope, or fine-grained with Actions read/write on this repo."
echo "  See docs/deploy-api-cloud-run.md (GitHub workflow buttons)."
echo ""
echo "/api/market/* : set FINNHUB_API_KEY on Cloud Run for quotes + stock snapshot."
echo "  Finnhub free tier often blocks daily candles (403) — add TWELVE_DATA_API_KEY and/or ALPHA_VANTAGE_API_KEY for charts:"
echo "  gcloud run services update ${SERVICE} --region=${REGION} --update-env-vars=TWELVE_DATA_API_KEY=YOUR_KEY"
echo "  See docs/deploy-api-cloud-run.md (Daily candles)."
