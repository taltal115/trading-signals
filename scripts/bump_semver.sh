#!/usr/bin/env bash
# Patch-bump package versions for changed deploy surfaces.
# Usage (from repo root):
#   BUMP_FRONTEND=true BUMP_BACKEND=true BUMP_BOT=false bash scripts/bump_semver.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bump_patch() {
  local ver="$1"
  if [[ ! "$ver" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    echo "0.1.0"
    return
  fi
  local major="${BASH_REMATCH[1]}"
  local minor="${BASH_REMATCH[2]}"
  local patch="${BASH_REMATCH[3]}"
  echo "${major}.${minor}.$((patch + 1))"
}

changed=false

if [[ "${BUMP_FRONTEND:-false}" == "true" ]]; then
  cur="$(node -p "require('./frontend/package.json').version")"
  next="$(bump_patch "$cur")"
  node -e "
    const fs=require('fs');
    const p='frontend/package.json';
    const j=JSON.parse(fs.readFileSync(p,'utf8'));
    j.version=process.argv[1];
    fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
  " "$next"
  echo "frontend: ${cur} → ${next}"
  changed=true
fi

if [[ "${BUMP_BACKEND:-false}" == "true" ]]; then
  cur="$(node -p "require('./backend/package.json').version")"
  next="$(bump_patch "$cur")"
  node -e "
    const fs=require('fs');
    const p='backend/package.json';
    const j=JSON.parse(fs.readFileSync(p,'utf8'));
    j.version=process.argv[1];
    fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
  " "$next"
  echo "backend: ${cur} → ${next}"
  changed=true
fi

if [[ "${BUMP_BOT:-false}" == "true" ]]; then
  cur="$(python3 -c "
import re
from pathlib import Path
text = Path('pyproject.toml').read_text()
m = re.search(r'(?m)^\s*version\s*=\s*[\"\\']([^\"\\']+)[\"\\']', text)
print(m.group(1) if m else '0.1.0')
")"
  next="$(bump_patch "$cur")"
  BOT_NEXT="$next" python3 -c "
import os, re
from pathlib import Path
next_v = os.environ['BOT_NEXT']
pyproject = Path('pyproject.toml')
text = pyproject.read_text()
text2, n = re.subn(
    r'(?m)^(\s*version\s*=\s*)[\"\\'][^\"\\']+[\"\\']',
    lambda m: m.group(1) + '\"' + next_v + '\"',
    text,
    count=1,
)
if n != 1:
    raise SystemExit('failed to bump pyproject.toml version')
pyproject.write_text(text2)
init = Path('src/signals_bot/__init__.py')
init_text = init.read_text()
init2, n2 = re.subn(
    r'__version__\s*=\s*[\"\\'][^\"\\']+[\"\\']',
    \"__version__ = \\\"\" + next_v + \"\\\"\",
    init_text,
    count=1,
)
if n2 != 1:
    raise SystemExit('failed to bump signals_bot __version__')
init.write_text(init2)
emb = Path('backend/src/embedded-bot-version.ts')
emb.write_text(
    '/** Synced from pyproject.toml by the Deploy on main version-bump job. */\\n'
    + f\"export const EMBEDDED_BOT_VERSION = '{next_v}';\\n\"
)
print(f'bot: {os.environ.get(\"BOT_CUR\", \"?\")} → {next_v}')
"
  echo "bot: ${cur} → ${next}"
  changed=true
fi

if [[ "$changed" != "true" ]]; then
  echo "No version bumps requested."
  exit 0
fi

echo "Version bump complete."
