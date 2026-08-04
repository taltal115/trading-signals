---
name: trading-dashboard
description: Build and modify the Angular trading signals dashboard and Nest API. Use when changing Signals/Positions/Monitor UI, hold charts, ledger filters, or dashboard API routes.
---

# Trading dashboard (Angular + Nest)

## Use when

- Signals / positions / monitor / universe / AI analytics pages
- Hold charts, ledger filters (`ai_gate`), table actions
- Nest endpoints that feed the SPA

## Key paths

| Area | Path |
|------|------|
| Feature pages | `frontend/src/app/features/*-page/` |
| Layout / auth | `frontend/src/app/layout/` |
| Nest API | `backend/src/` |
| Project UI rule | `.cursor/rules/frontend-dashboard.mdc` |

Do **not** extend the legacy vanilla `web/` app.

## Conventions

- Default Signals ledger: **Actionable** (`ai_gate=passed`); keep Pending / All.
- Signal-only UI — no broker order placement.
- Match existing component / service patterns (standalone components, existing stores/services).
- Prefer Nest for GitHub workflow triggers and server-side secrets; keep keys out of the SPA bundle when possible.

## Typical change flow

1. Find the feature page under `frontend/src/app/features/`.
2. Add UI in the page component template + TypeScript.
3. Call an existing frontend service or add a Nest route if data must stay server-side.
4. Preserve loading / error states consistent with neighboring controls.

## Related data

Signals and paper positions live in Firestore (via Nest or client SDK depending on existing page). Respect `ai_gate` and hard-filter fields when filtering ledgers.
