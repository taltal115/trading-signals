#!/usr/bin/env bash
# Deploy frontend (Angular → Firebase Hosting) or backend (Nest → Cloud Run).
# Run from anywhere:  bash scripts/deploy.sh fe | be
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  echo "Usage: bash scripts/deploy.sh fe|frontend | be|backend" >&2
  exit 1
}

case "${1:-}" in
  fe | frontend)
    (cd frontend && npx ng build --configuration=production)
    firebase deploy --only hosting
    ;;
  be | backend)
    bash scripts/deploy_nest_cloud_run.sh
    ;;
  *)
    usage
    ;;
esac
