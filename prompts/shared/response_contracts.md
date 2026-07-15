# Response contracts

## Entry evaluator

Must return JSON including at least:

- `action` (BUY | WAIT | AVOID), `conviction` (0–1), `direction`
- `summary`, `why_now`
- `entry_zone` {min_price, max_price, ideal_price}, `stop_loss`, `targets`[{price, label}]
- `timeframe`, `risk_reward_ratio`, `position_size_suggestion`
- `risks`[], `invalidation`, `confidence_factors`[], `invalidation_conditions`[]
- Clear fields (preferred): `headline`, `why`, `risk_level` (low|medium|high), `risk_score` (0–100),
  `hold_days` (int), `checklist` [{id, label, pass}]

## Holding advisor

Must return JSON:

- `advice` (HOLD | TIGHTEN | EXTEND | EXIT)
- `headline`, `why`
- `risk_level` (low|medium|high)
- `revised_hold_days` (number or null)
- `revised_stop` (number or null)
