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
    echo "Cloud Build failed (often PERMISSION_DENIED). Fix IAM or use local Docker:" >&2
    echo "  USE_LOCAL_DOCKER=1 bash scripts/deploy_nest_cloud_run.sh" >&2
    echo "See docs/deploy-api-cloud-run.md → Troubleshooting → Cloud Build permission denied." >&2
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
