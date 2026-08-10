# Signal strategy research — post-2026-08-04 follow-up

**Analysis date:** 2026-08-10  
**Prior note:** [`signal-strategy-research-2026-08.md`](./signal-strategy-research-2026-08.md) (hard filters + AI-gate product changes on 2026-08-04)

**Question:** After the Aug-4 hard filters / actionable-ledger changes, how did later BUY signals do at raw profit @ `hold_days`, and can we measure the AI-passed book?

**Primary metric:** raw close-to-close return after each signal’s `hold_days` (all mature rows here used **3** sessions).

---

## Executive summary

| Cohort | n mature | Win% @ hold | Avg | Median | PF | Sum % PnL |
|--------|----------|-------------|-----|--------|-----|-----------|
| **All technical BUYs** since 2026-08-04 | **9** | **88.9%** | **+5.00%** | +2.88% | **2.76** | +45.0 |
| **Actionable only** (`ai_gate=passed`) | **0** | — | — | — | — | — |
| Hard-reject survivors (conf&lt;98 & ret5&lt;50 & vol&lt;5) | 4 | 100% | +5.81% | +4.43% | ∞ | +23.2 |
| Continuation band (ret5∈[10,20) & vol∈[2,3)) | 5 | 100% | +3.89% | +2.88% | ∞ | +19.5 |
| `ai_gate=pending` (mature) | 3 | 100% | +3.73% | +2.51% | ∞ | +11.2 |
| `ai_gate=skipped` / rule_skip WAIT (mature) | 6 | 83.3% | +5.64% | +4.14% | 2.32 | +33.9 |

**Verdict**

1. The first mature **technical** post-fix sample is a **clear winner** vs the June–July book (was 24% win / −8.9% avg / PF 0.30). One day (2026-08-04) dominates the mature set.
2. **Actionable AI-passed edge cannot be measured yet:** **0 / 14** unique BUYs have `ai_gate=passed`. The ledger is empty by design while AI was down or rule-skipping.
3. Treat the strong full-book numbers as **biased / transitional**: Aug-4 still emitted conf≥98 / vol≥5 lottery names (pre- or mid-deploy of hard reject), and AI never green-lit anything.

---

## Caveat — AI layer unreliable in this window

Observed gate mix on **all 14** unique BUYs (incl. immature):

| `ai_gate` | n | Notes |
|-----------|---|--------|
| `skipped` | 6 | `ai_model=rule_skip`, decision WAIT — deterministic skip (lottery / hard-reject lane), not LLM |
| `pending` | 6 | No eval completed — consistent with wrong model 404s (`gpt-5.4-pro` chat-incompatible) and OpenAI 429 / budget exhaustion |
| `filtered` | 2 | 2026-08-10 GTLB, PRAA — real LLM (`gpt-5.4-2026-03-05`) → WAIT; holds immature |
| `passed` | **0** | No actionable sample |

**Implication:** comparing “actionable vs all” is one-sided. Full technical PnL **overstates** what the product would have surfaced (paper/Slack only open on `passed`). Pending winners (OWL/LIND/MHK) never became actionable; skipped names were intentionally non-actionable.

---

## Artifacts

```bash
# Full technical BUY book
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-08-04 \
  --limit-runs 200 \
  --out-csv docs/research/2026-08/profit_hold_cohort_all_buys_since_2026-08-04.csv \
  --out-json docs/research/2026-08/profit_hold_cohort_all_buys_since_2026-08-04_summary.json

# Actionable only (empty as of 2026-08-10)
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-08-04 \
  --actionable-only \
  --limit-runs 200 \
  --out-csv docs/research/2026-08/profit_hold_cohort_actionable_since_2026-08-04.csv \
  --out-json docs/research/2026-08/profit_hold_cohort_actionable_since_2026-08-04_summary.json

# Include immature (gate inventory + later dates)
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-08-04 \
  --include-immature \
  --limit-runs 200 \
  --out-csv docs/research/2026-08/profit_hold_cohort_all_buys_since_2026-08-04_incl_immature.csv \
  --out-json docs/research/2026-08/profit_hold_cohort_all_buys_since_2026-08-04_incl_immature_summary.json
```

| File | Role |
|------|------|
| `profit_hold_cohort_all_buys_since_2026-08-04.csv` | Mature+near-mature technical detail |
| `profit_hold_cohort_all_buys_since_2026-08-04_summary.json` | Headline + slices |
| `profit_hold_cohort_all_buys_since_2026-08-04_incl_immature.csv` | Full 14-row inventory incl. Aug 6–10 |
| `profit_hold_cohort_actionable_since_2026-08-04_summary.json` | Documents **n_passed=0** (no CSV; script exits empty) |

---

## 1. Full technical book (mature)

| Metric | Value |
|--------|-------|
| Unique BUYs loaded | 14 |
| Rows evaluated (mature filter) | 11 |
| Mature @ hold | 9 (all `asof_date=2026-08-04`) |
| Wins / losses | 8 / 1 |
| Win rate | 88.9% |
| Avg / median | +5.00% / +2.88% |
| Avg win / avg loss | +8.83% / **−25.58%** |
| Profit factor | 2.76 |
| Sum % PnL | +45.0 |

**+5 sessions:** n=0 yet (only ~4 forward sessions available on Aug-4 names).

**Immature / later dates (not in headline):**  
2026-08-06 GENI, SN (`pending`); 2026-08-07 NSIT (`pending`); 2026-08-10 GTLB, PRAA (`filtered` WAIT via gpt-5.4).

### Mature book

```
asof       ticker  hold%    conf  gate     model        ret5    vol
2026-08-04 LIFE   +38.46    100   skipped  rule_skip    17.2    3.6
2026-08-04 LBRX   +12.04     96   skipped  rule_skip    23.2    2.5
2026-08-04 OWL     +6.36     94   pending  —            15.3    2.3
2026-08-04 STGW    +5.40     98   skipped  rule_skip    12.5    2.8
2026-08-04 OCTV    +2.88    100   skipped  rule_skip    12.6    3.0
2026-08-04 LIND    +2.51     95   pending  —            17.9    2.4
2026-08-04 MHK     +2.31     93   pending  —            15.0    2.2
2026-08-04 ITGR    +0.66    100   skipped  rule_skip    25.2   11.0
2026-08-04 HYFM   -25.58    100   skipped  rule_skip   220.9   19.9
```

### What worked

- **Continuation-shaped names** (ret5 ~10–20%, vol ~2–3×): OWL, LIND, MHK, OCTV, STGW — all green; quiet +2–6% holds.
- **Mid-confidence** (90–96) pending names that look like the July “good” profile — again green.
- Excluding the single lottery loser HYFM → **8/8 wins**, avg **+8.83%**.

### What did not

- **HYFM** — classic lottery (conf 100, ret5 221%, vol 20×): **−25.6%** raw / managed stop **−17.4%**. Same failure mode as July LHSW/LHAI.
- **Conf ≥ 98 / vol ≥ 5** still present on Aug-4 scan (LIFE/ITGR/HYFM/OCTV/STGW) — transitional vs hard-reject config; do not read as “hard filters failed forever.”
- **AI as a green-light gate** — produced **zero** `passed` rows; cannot claim AI improved selection yet. Rule-skip WAIT correctly kept HYFM non-actionable; it also skipped winners (LIFE, LBRX).

---

## 2. Actionable-only

**n = 0.** No CSV written by the cohort script when the filter empties the set.

Until chat-compatible models + budget are stable and produce `ai_gate=passed`, the product’s actionable stream has **no hold-PnL evidence** for the post-fix regime. Immature Aug-10 filtered WAITs show the LLM path is alive again — watch for the first `passed` cohort.

---

## 3. Comparison to prior research

| Claim from 2026-08-04 note | This window |
|----------------------------|-------------|
| Full book was a loser (PF 0.30) | **Reversed on n=9 technical** (PF 2.76) — small, one-day mature sample |
| Lottery / ≥5× vol toxic | **Confirmed** — HYFM sole mature loss |
| Prefer ret5 10–20% / vol 2–3× | **Confirmed** — 5/5 winners in band |
| Prefer conf 90–94 | Supportive (pending OWL/MHK); n tiny |
| AI WAIT should stay non-actionable | **Still correct for risk** (HYFM); but WAIT/skip also blocked winners |
| Remeasure actionable since 2026-08-04 | **Blocked** — n_passed=0 |

---

## 4. Recommended next steps (minimal)

### Ops / AI reliability (blocks measurement)

1. Keep entry model on a **chat-compatible** id (e.g. `gpt-5.4-…`, not `gpt-5.4-pro` Responses/pro-only).
2. Ensure OpenAI budget / rate limits so `pending` does not dominate; optionally backfill eval for pending continuation-band names for research (not for rewriting historical paper).
3. Do **not** treat `pending` as actionable in UI/paper (current design is correct).

### Strategy (already largely done — validate, don’t loosen)

4. Keep hard reject conf≥98 / ret5≥50 / vol≥5 and continuation band — Aug-4 HYFM proves the lottery channel still hurts when admitted.
5. No config loosen based on LIFE (+38%): conf 100 + vol 3.6× is still the binary channel; one win does not overturn July.

### Remeasure (when ≥5–10 mature `passed` holds exist)

```bash
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-08-04 \
  --actionable-only \
  --out-csv docs/research/2026-08/profit_hold_cohort_actionable_since_2026-08-04.csv \
  --out-json docs/research/2026-08/profit_hold_cohort_actionable_since_2026-08-04_summary.json

PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-08-04 \
  --out-csv docs/research/2026-08/profit_hold_cohort_all_buys_since_2026-08-04.csv \
  --out-json docs/research/2026-08/profit_hold_cohort_all_buys_since_2026-08-04_summary.json
```

Also re-run with `--include-immature` after GENI/SN/NSIT mature (~3 sessions) to refresh gate-sliced PF.

**Still open (P2 from prior note):** market-breadth / day circuit breaker — not informed by this tiny sample.

---

## 5. Implementation log (2026-08-10 follow-up tweaks)

Applied the section-4 recommendations (no strategy loosen; AI reliability + research tooling).

| Tweak | Status | Where |
|-------|--------|--------|
| Chat-compatible entry model only (`gpt-5.4`); `pro_model` empty | Done | `config.yaml` `ai.entry_model` / `ai.pro_model: ""`; blocklist + fallback in `scripts/ai_stock_eval/main.py` |
| Do not route `gpt-5.4-pro` via chat/completions | Done | `_CHAT_UNSUPPORTED_MODELS` + fallback on “not a chat model” |
| Keep hard reject + continuation band (no LIFE loosen) | Locked | `config.yaml` strategy comments + knobs unchanged |
| `pending` stays non-actionable (paper/Slack/UI) | Confirmed | paper opens only on `ai_gate=passed`; Slack `require_ai_passed`; Signals ledger default Actionable |
| OpenAI pacing / soft rate-limit exit for entry batch | Done (prior) | `.github/workflows/ai-entry-batch.yml` retry/pace env; batch exit 0 on rate-limit-only |
| Research backfill pending continuation-band names **without** rewriting paper | Done | `scripts/research_backfill_pending_entry_ai.py` + `--skip-paper` on entry eval / `write_entry_evaluation` |

### Research backfill (optional; does not open paper)

List targets:

```bash
PYTHONPATH=./src:. python scripts/research_backfill_pending_entry_ai.py \
  --since 2026-08-04 --dry-run
```

Eval up to N pending continuation-band rows (writes `ai_gate` / recommendation only):

```bash
PYTHONPATH=./src:. python scripts/research_backfill_pending_entry_ai.py \
  --since 2026-08-04 --max-evals 10
```

Then remeasure cohorts (actionable may still be empty until live `passed` holds mature — backfill is for gate labels / analytics, not historical paper PnL).

**Note:** Backfilled `passed` on mature historical rows must **not** be treated as live ledger performance; paper was intentionally skipped.

---

## Summary

Post-fix **technical** BUYs look healthy on a tiny Aug-4 mature set (88.9% / +5% / PF 2.76), driven by continuation names and hurt only by HYFM-style lottery. The **actionable** book is empty because AI stayed at `pending` / `skipped` / `filtered` — so we still have **no** measured edge for the product ledger Tal actually sees. Tweaks above lock chat-compatible entry + hard filters and add a skip-paper research backfill; remeasure `--actionable-only` once live `passed` holds mature.
