# Prompts

Loaded from markdown under `prompts/` (repo root).

| Stage | System | User template |
|-------|--------|---------------|
| Shared | `prompts/shared/system_guardrails.md` | — |
| Shared | `prompts/shared/response_contracts.md` | — |
| Entry | `prompts/entry/entry_evaluator_system.md` | `prompts/entry/entry_evaluator_user_template.md` |
| Holding | `prompts/holding/holding_advisor_system.md` | `prompts/holding/holding_advisor_user_template.md` |

Python loader: `scripts/ai_stock_eval/prompts.py` (`load_prompt`, `get_entry_prompts`).

Entry output must satisfy [VERDICT_SCHEMA.md](./VERDICT_SCHEMA.md). Holding uses the separate advice schema (not BUY/WAIT/AVOID).
