# Clear recommendation schema

Primary object for entry eval. UI and Slack lead with this; raw LLM fields stay under `detail`.

```json
{
  "decision": "BUY | WAIT | AVOID",
  "headline": "One sentence anyone can understand",
  "why": "One short paragraph",
  "risk_level": "low | medium | high",
  "risk_score": 0,
  "scores": { "technical": 0, "ai": 0, "total": 0 },
  "plan": {
    "entry": { "ideal": 0, "min": 0, "max": 0 },
    "stop": 0,
    "target": 0,
    "hold_days": 1,
    "invalidation": "Price or condition that kills the trade"
  },
  "checklist": [
    { "id": "volume", "label": "Volume confirms", "pass": true },
    { "id": "rr", "label": "Risk/reward >= 2", "pass": true }
  ],
  "detail": {}
}
```

## Holding advisor output (separate)

```json
{
  "advice": "HOLD | TIGHTEN | EXTEND | EXIT",
  "headline": "One sentence",
  "why": "One short paragraph",
  "revised_hold_days": null,
  "revised_stop": null,
  "risk_level": "low | medium | high"
}
```

Hard stops from the original plan / ATR monitor are never ignored by advice alone.
