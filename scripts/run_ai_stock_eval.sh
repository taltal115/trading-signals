#!/usr/bin/env bash
# Run AI stock evaluation from repo root (loads .env via Python; sets PYTHONPATH).
# Usage: scripts/run_ai_stock_eval.sh --ticker AAPL --signal-doc-id <id> [options]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PYTHONPATH="${ROOT}/src:${ROOT}"

if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/run_ai_stock_eval.sh --ticker SYMBOL --signal-doc-id DOC_ID [options]"
  echo ""
  echo "Options (see scripts/ai_stock_eval/main.py):"
  echo "  --dry-run                 Do not write Firestore"
  echo "  --stdout-json             Print full result JSON"
  echo "  --candidate-score N       Skip Firestore read for signal score (0–100)"
  echo "  --verify-only             Context checks only (no LLM / no write)"
  echo "  --debug-prompt            Print system + user prompts before LLM"
  echo "  --github-verify-annotations  With --verify-only: ::warning:: in Actions"
  echo "  --config PATH             Default: config.yaml at repo root"
  echo ""
  echo "Example (no Firestore; inspect JSON):"
  echo "  scripts/run_ai_stock_eval.sh --ticker AAPL --signal-doc-id demo \\"
  echo "    --candidate-score 72 --dry-run --stdout-json"
  exit 0
fi

PY="${PYTHON:-python3}"
exec "$PY" -m scripts.ai_stock_eval.main "$@"
