# AGENTS.md — trading-signals

Context for AI coding agents working in this repository.

## What this repo is

Signal-only US equities research bot: daily breakout-momentum scans → SQLite / Firestore → Slack + Angular dashboard. **No broker order execution.**

Stack:
- Python bot: `src/signals_bot/`, scripts in `scripts/`
- NestJS API: `backend/`
- Angular SPA: `frontend/`
- Docs: `docs/` (keep new markdown under `docs/`)
- Config: `config.yaml` + `.env` (never commit secrets)

## Non-negotiables

- Be personal and address me with my name in your responses - Tal
- Never add broker execution / auto-trading.
- Prefer simple, typed dataclasses for domain objects (`Signal`, `Config`).
- Deterministic scoring for v1 strategy (no ML unless explicitly requested).
- Secrets only via env / GitHub Secrets / Cloud Run env — not git.
- UTC timestamps; include `asof_date` for daily bars.
- Handle missing market data and provider errors gracefully.
- Log BUY/WAIT/SELL with numeric confidence 0–100.
- Actionable signals = hard rule filters **and** `ai_gate=passed` (see Aug 2026 research).

## Common commands

```bash
# Bot (venv)
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
./run.sh                          # daily scan
./run.sh discovery --max-calls 50 # universe discovery

# Research (profit @ default hold)
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-08-04 --actionable-only \
  --out-csv docs/research/2026-08/out.csv \
  --out-json docs/research/2026-08/out_summary.json

# Frontend / API (see package.json in each package)
cd frontend && npm ci && npm start
cd backend && npm ci && npm run start:dev
```

## Where to look

| Concern | Path |
|---------|------|
| Strategy / ranking / hard filters | `src/signals_bot/strategy/`, `config.yaml` |
| Scan entrypoint | `src/signals_bot/main.py` |
| AI entry + holding | `scripts/ai_stock_eval/`, `scripts/ai_holding_advisor/`, `docs/ai-signal-pipeline/` |
| Research notes | `docs/research/YYYY-MM/` |
| Research UI (cohort runs) | `frontend/.../research-page/`, `scripts/run_ui_profit_hold_research.py`, Firestore `research_runs` |
| Bot strategy docs | `docs/bot-logic-and-strategy.md` |
| Deploy (local) | `./scripts/deploy.sh fe` / `be` — see `docs/deploy-api-cloud-run.md` |
| Deploy (CI on main) | `.github/workflows/deploy-on-main.yml` + quality gate — see `docs/deploy-github-actions.md` |

## Cursor primitives in this repo

| Primitive | Path |
|-----------|------|
| Instructions (this file) | `AGENTS.md` |
| Cursor rules | `.cursor/rules/*.mdc` |
| Skills | `.cursor/skills/*/SKILL.md` |
| Subagents | `.cursor/agents/*.md` |

Legacy `.cursorrules` is superseded by `AGENTS.md` + `.cursor/rules/`.
