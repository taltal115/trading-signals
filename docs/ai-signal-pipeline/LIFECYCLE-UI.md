# Lifecycle UI — per-signal workflow DAG

Visualize one Firestore BUY signal as a Databricks-style job graph: phases, pass/fail conditions, and a click-to-drill-down drawer.

## Open a ticker

1. Go to **Signals** (`/signals`).
2. Click **Workflow** on a row.
3. Route: `/signals/:docId/:ticker?index=N`

There is no sidebar entry — entry is from the Signals ledger only.

## Phases (left → right)

| Node | Meaning |
|------|---------|
| Universe | Snapshot `universe/{asof}/symbols/{TICKER}` when present |
| Scan / strategy | Technical BUY (row exists); momentum / volume / confidence |
| Hard filters | Lottery + continuation band (Firestore BUYs already passed) |
| Entry queue | Top-N / in-band selection; `ai_gate=skipped` fails here |
| News / context | `provider_status` from entry `ai_evals` (degraded ≠ gate fail) |
| AI entry | LLM decision, scores, checklist |
| AI gate | Actionable line: BUY + total + conviction + long-only |
| Paper | Open only when `ai_gate=passed` |
| Holding / monitor | Holding advice + recent position checks |
| Outcome | Research finalize / PnL |

Statuses: `passed`, `failed`, `skipped`, `pending`, `not_run`, `degraded`.

The first `failed` / `skipped` is the **fail point**; later nodes stay gray (`not_run`).

## Persisted vs inferred

- **Going forward:** scan writes `pipeline_trace` (thresholds + scan/hard conditions). Entry eval appends queue / news / AI / gate stages.
- **Historical rows** without `pipeline_trace`: Nest **infers** the same graph from metrics + current defaults (`config.yaml`-aligned). The page shows a blue banner when inferred.

Holding / monitor / outcome are **merged at read time** from `ai_evals`, `my_positions`, and research fields on the signal row (not rewritten on every monitor check).

## API

```http
GET /api/signals/lifecycle?docId={runDocId}&ticker={SYM}&index={optional}
```

Returns a `PipelineGraph` (header, nodes, edges, `failPoint`, `traceSource`).

Assembler: `backend/src/signals/pipeline-lifecycle.assembler.ts`.

## Scope (v1)

- Only tickers that already have a Firestore BUY row (`pending` / `passed` / `filtered` / `skipped`).
- WAIT / hard-filter rejects at scan are **not** visualized (they never hit Firestore).
- Page does **not** dispatch AI jobs.
- Signal-only — no broker order UI.

## Related

- [ARCHITECTURE.md](./ARCHITECTURE.md) — jobs and `ai_gate`
- [VERDICT_SCHEMA.md](./VERDICT_SCHEMA.md) — recommendation checklist
- [README.md](./README.md) — pipeline overview
