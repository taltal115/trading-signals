#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found on PATH" >&2
  exit 1
fi

if [[ ! -d ".venv" ]]; then
  echo "Creating venv at ./.venv"
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source ".venv/bin/activate"

echo "Preparing environment"
# NOTE: Many locked-down environments block PyPI access, and Python venvs may not include setuptools.
# To keep this repo runnable even without network access, we DO NOT require an editable install here.

python - <<'PY'
missing = []
for mod in ["yaml", "dotenv", "rich", "pandas", "numpy", "yfinance", "requests", "slack_sdk"]:
    try:
        __import__(mod)
    except Exception:
        missing.append(mod)
if missing:
    print("ERROR: missing Python dependencies:", ", ".join(missing))
    print("")
    print("Install with pip, then re-run. Example:")
    print("  python -m pip install -r requirements.txt")
    print("")
    print("If you're behind a proxy/corporate mirror, set PIP_INDEX_URL, e.g.:")
    print("  export PIP_INDEX_URL='https://YOUR_MIRROR/simple'")
    raise SystemExit(2)
PY

if [[ ! -f "config.yaml" ]]; then
  echo "config.yaml not found; copying config.example.yaml -> config.yaml"
  cp "config.example.yaml" "config.yaml"
fi

if [[ ! -f ".env" ]]; then
  echo "WARN: .env not found. Slack may fail unless you export SLACK_BOT_TOKEN (and SLACK_CHANNEL)." >&2
fi

# Always log to a local file (useful for cron too).
LOG_DIR="${ROOT_DIR}/logs"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/run-$(date -u +%Y%m%d).log"

# Run from source tree (no packaging / no setuptools required).
export PYTHONPATH="${ROOT_DIR}/src${PYTHONPATH:+:${PYTHONPATH}}"
if [[ "${1:-}" == "discovery" ]]; then
  shift
  if [[ "$#" -eq 0 ]]; then
    python "scripts/update_universe_finnhub.py" --max-calls 400 --limit 200 2>&1 | tee -a "${LOG_FILE}"
  else
    python "scripts/update_universe_finnhub.py" "$@" 2>&1 | tee -a "${LOG_FILE}"
  fi
  exit ${PIPESTATUS[0]}
fi

python -m signals_bot.main --config "config.yaml" "$@" 2>&1 | tee -a "${LOG_FILE}"
exit ${PIPESTATUS[0]}

