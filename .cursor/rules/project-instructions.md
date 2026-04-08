---
description: Core rules for the trading-signals project
globs: ["**/*"]
---

# Trading Signals Project Rules

## Architecture
- Signal-only system: NEVER add broker execution or auto-trading
- Python backend runs via GitHub Actions (scheduled + manual triggers)
- Static web UI hosted on Firebase Hosting
- Firestore for data persistence
- Slack for notifications

## Code Style
- Python: typed dataclasses, f-strings, pathlib, explicit errors
- JavaScript: vanilla JS, no frameworks, ES6+
- Keep modules small and focused

## Data Flow
- Universe discovery -> Signal generation -> Firestore storage -> UI display
- Monitor script evaluates open positions -> alerts via Slack

## API Keys
- Never commit secrets to git
- Use GitHub Secrets for CI/CD
- Client-side keys (Finnhub) go in firebase-config.js

## File Organization
- /src/signals_bot/ - Python bot modules
- /scripts/ - Standalone Python scripts
- /web/ - Static HTML/CSS/JS dashboard
- /docs/ - Documentation
- /.github/workflows/ - CI/CD workflows

## Python Guidelines
- Use typed dataclasses for core domain objects (Signal, Config)
- Configuration via YAML + env vars (Slack token, API keys)
- All outputs: logs, Slack messages, or Firestore/SQLite rows
- Always log clearly with BUY/WAIT/SELL tags and numeric confidence (0-100)
- Use UTC for stored timestamps; include asof_date for daily bars
- Treat market data as unreliable: handle missing data and provider errors gracefully
- Prefer deterministic scoring: no ML in v1

## JavaScript Guidelines
- All code in web/app.js (single file, IIFE pattern)
- Use Firestore onSnapshot for real-time updates
- GitHub Actions API calls use localStorage for PAT storage
- Finnhub API for live price fetching

## Workflow Triggers
- All workflows support workflow_dispatch for manual/API triggers
- Use --ticker argument for single-stock operations
- Scheduled runs process full universe
