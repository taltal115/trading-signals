# Signal strategy research follow-up — July 2026 (profit @ default hold)

Follow-up to [`signal-strategy-research-2026-07.md`](./signal-strategy-research-2026-07.md).

**Question:** Since the last research (cohort through **2026-06-28**, analysis date 2026-07-04), how did later BUY signals perform when judged by **raw profit at the signal’s default hold** (not stop/target hits)? What does the new **AI layer** change?

**Primary metric:** close-to-close return after each signal’s `hold_days` (almost always **3** NYSE sessions). Stop/target are reported only as contrast.

**Data:** Firestore `signals` + Yahoo/Stooq forwards; SQLite feature columns joined where present; Firestore `ai_evals` for AI coverage.

**Scripts:**

```bash
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py --since 2026-06-29
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-06-28 --until 2026-06-28 \
  --out-csv docs/research/2026-07/profit_hold_cohort_2026-06-28_mature.csv \
  --out-json docs/research/2026-07/profit_hold_cohort_2026-06-28_mature_summary.json
```

Artifacts in this folder: `profit_hold_cohort_2026-07*.csv|json`, `profit_hold_cohort_2026-06-28_*.csv|json`.

**Analysis date:** 2026-07-16.

---

## Executive summary

| Cohort | n (mature) | Win% @ hold | Avg @ hold | Median | PF | Notes |
|--------|------------|-------------|------------|--------|-----|-------|
| Remeasure **2026-06-28** @ 3d hold | 53 | **66.0%** | **+2.15%** | +2.51% | **2.51** | Matches prior research; still good at full maturity |
| Same @ **+5 sessions** raw | 53 | 64.2% | +2.09% | +2.30% | 1.94 | Slightly worse than +3d |
| **New** since 2026-06-29 @ hold | 16 | **37.5%** | **−3.11%** | −2.40% | **0.69** | Regime / selection deteriorated |
| New without NVVE outlier | 15 | 33.3% | −9.05% | −2.74% | — | Edge disappears without one lottery win |

**Takeaways**

1. The strong 6/28 day was **real** (still holds when remesured). It did **not** generalize to July runs.
2. Judging by **profit at default 3-day hold** (not targets), the post-6/28 book is a **net loser**.
3. Extending to **5 sessions** made the new cohort **worse**, not better — do not lengthen hold as a fix.
4. **Confidence remains a poor predictor**; conf 100 produced the worst blow-ups (LHAI, LHSW).
5. **AI entry coverage is tiny** on mature names, but the few samples are directionally right: AI said **WAIT/filtered** on names that went on to large losses (LHAI) or were gated (NXTC). Holding-advisor traffic dominates `ai_evals` today; entry gating is underused.

---

## 1. Remeasure of 2026-06-28 (full maturity)

Prior research had only ~4 forward sessions. As of 2026-07-16 the full +3 / +5 window is available.

| Case | n | Win% | Avg | Median | PF |
|------|---|------|-----|--------|-----|
| Raw close @ signal hold (3d) | 53 | 66.0 | +2.15% | +2.51% | 2.51 |
| Raw close @ +5 sessions | 53 | 64.2 | +2.09% | +2.30% | 1.94 |

**Top winners @ 3d hold:** PRCH +15.1%, ODD +14.5%, GH +14.4%, LFST +11.2%, PUBM +9.3%.  
**Top losers @ 3d hold:** LIND −9.5%, LXRX −8.2%, MAMA −8.1%, LGIH −7.6%, GVA −6.6%.

**Confidence @ 3d hold (6/28):**

| Conf | n | Win% | Avg | PF |
|------|---|------|-----|-----|
| 80–89 | 10 | **90.0** | **+3.88%** | **6.89** |
| 90–94 | 17 | 52.9 | +1.65% | 2.35 |
| 95–99 | 13 | 69.2 | +0.37% | 1.22 |
| 100 | 13 | 61.5 | +3.25% | 2.63 |

Mid-tier setup scores again beat “max confidence.” Ranking Slack/top-N by confidence remains wrong.

---

## 2. New cohort — since 2026-06-29 (profit @ default hold)

**Universe:** unique `(asof_date, ticker)` BUYs with `asof_date ≥ 2026-06-29`, mature when ≥ `hold_days` sessions exist.  
**Hold:** every mature row used `hold_days = 3` (config default / ATR clamp).

### Headline (raw profit @ hold — ignores stop/target)

| Metric | Value |
|--------|-------|
| Mature trades | 16 |
| Wins / losses | 6 / 10 |
| Win rate | 37.5% |
| Avg return | −3.11% |
| Median | −2.40% |
| Avg win / avg loss | +18.12% / −15.84% |
| Profit factor | 0.69 |
| Sum of % PnL | −49.7 |

**+5 sessions raw (subset n=14):** win 28.6%, avg **−10.35%**, PF **0.16** — holding longer hurt.

### All winners (hold profit)

| asof | ticker | hold ret | conf | AI |
|------|--------|----------|------|-----|
| 2026-07-09 | NVVE | **+86.10%** | 100 | none |
| 2026-07-02 | NGNE | +12.87% | 94 | none |
| 2026-07-08 | NGNE | +4.13% | 88 | none |
| 2026-07-08 | KFRC | +3.00% | 91 | none |
| 2026-07-02 | GRND | +2.10% | 93 | none |
| 2026-07-07 | OFIX | +0.52% | 95 | none |

### All losers (hold profit)

| asof | ticker | hold ret | conf | AI | Finalized managed (contrast) |
|------|--------|----------|------|-----|------------------------------|
| 2026-07-07 | LHSW | **−49.26%** | 100 | none | stop −15.1% |
| 2026-07-02 | LHAI | **−46.72%** | 100 | WAIT (eval) | stop −12.7% |
| 2026-07-09 | PRME | −24.89% | 99 | none | stop −12.1% |
| 2026-07-06 | RXST | −9.45% | 87 | none | stop −9.2% |
| 2026-07-08 | KURA | −9.01% | 84 | none | stop −6.7% |
| 2026-07-07 | RMD | −6.65% | 85 | none | stop −4.3% |
| 2026-07-06 | GPC | −6.26% | 96 | none | stop −5.1% |
| 2026-07-06 | RIVN | −2.74% | 88 | none | stop −8.5% |
| 2026-07-06 | SLDE | −2.07% | 96 | none | time −3.7% |
| 2026-07-06 | REAX | −1.38% | 94 | none | time +1.4% |

**Managed stops** cut the LHAI/LHSW disasters roughly in half vs raw hold — stops still matter for risk, but this research’s scorecard is **profit at hold**, where those names are catastrophic.

**NVVE** is a single +86% lottery ticket (extreme prior momentum in SQLite: ret_5d ≫ 50%, vol ≫ 5×). Excluding it, the book is clearly negative.

### By asof_date (hold profit)

| Day | n | Win% | Avg | Comment |
|-----|---|------|-----|---------|
| 2026-07-02 | 3 | 66.7 | −10.6% | NGNE/GRND wins wiped by LHAI |
| 2026-07-06 | 5 | **0.0** | −4.4% | Full wipeout day |
| 2026-07-07 | 3 | 33.3 | −18.5% | LHSW blow-up |
| 2026-07-08 | 3 | 66.7 | −0.6% | Flat/slightly red |
| 2026-07-09 | 2 | 50.0 | +30.6% | Only NVVE vs PRME |

### Entry features (SQLite join) vs hold profit

Firestore signal rows **do not store** `ret_5d` / `atr_pct` / `vol_ratio` (metrics are null). Features below are from **SQLite** for the same `(asof_date, ticker)`.

| Entry ret_5d | n | Win% | Avg | PF |
|--------------|---|------|-----|-----|
| **10–20%** | 7 | **71.4** | **+2.04%** | **2.71** |
| &lt;10% | 3 | 0.0 | −8.37% | 0.00 |
| 20–30% | 3 | 0.0 | −9.67% | 0.00 |
| ≥50% | 3 | 33.3 | −3.29% | 0.90 |

| Vol ratio | n | Win% | Avg |
|-----------|---|------|-----|
| 2–3× | 13 | 38.5 | −3.06% |
| ≥5× | 3 | 33.3 | −3.29% | (LHAI, LHSW, NVVE — binary lottery)

| Confidence | n | Win% | Avg |
|------------|---|------|-----|
| 90–94 | 4 | **75.0** | **+4.15%** |
| 80–89 | 5 | 20.0 | −4.74% |
| 95–99 | 4 | 25.0 | −8.18% |
| 100 | 3 | 33.3 | −3.29% |

**Pattern:** the only robust positive bucket in this small July sample is **entry ret_5d in 10–20%**. Overextended / ignition-style names (ret_5d ≥50% or vol ≥5×) dominate both the biggest win (NVVE) and the biggest losses (LHAI, LHSW).

---

## 3. AI layer (new since prior research)

### Coverage reality

| Source | What we see (as of 2026-07-16) |
|--------|--------------------------------|
| `ai_evals` | ~34 docs scanned recently: **~30 holding**, **~4 entry** |
| Entry evals | All four were **NXTC** → `ai_gate=filtered`, decision **WAIT** |
| Mature post-6/29 BUYs with entry AI | **1** (LHAI): decision **WAIT**, blended total ~87 — still appeared as a rule BUY; raw hold **−46.7%** |
| Recent (immature) | 2026-07-15 **NXTC** filtered WAIT (good — not treated as actionable) |
| Most July BUYs | `ai_gate` absent / no `recommendation` — **rules-only** |

So the AI stack is live, but **entry gating is not systematically applied** to the BUY stream. Holding-advisor noise (repeated NXTC holding jobs) outweighs entry screening.

### What the sparse AI evidence suggests

| Case | Rules | AI | Hold PnL | Lesson |
|------|-------|-----|----------|--------|
| LHAI 2026-07-02 | BUY conf 100 | WAIT / high score | −46.7% | AI veto would have avoided a blow-up |
| NXTC 2026-07-15 | BUY conf 100 | filtered WAIT | (immature) | Gate working when batch/entry job runs |
| Almost all other July BUYs | BUY | *no entry AI* | mostly red | Pipeline gap, not model failure |

**Conclusion:** AI is not yet a measured edge on a large sample, but early cases support using entry AI as a **hard filter** (especially on conf≈100 / extreme momentum), not as an optional decoration.

---

## 4. Winners vs losers — synthesis

### Shared traits of large losers (hold profit)

- High **rule confidence** (99–100) more often than not.
- Extreme **prior momentum** (ret_5d ≫ 30–50%) and/or **volume spikes** (≥5×).
- No effective AI entry veto (except LHAI, where AI said WAIT but the UI/stream still treated it as a technical BUY historically).
- Stops limited damage in finalized managed PnL, but **default-hold profit** still failed hard.

### Shared traits of reliable small winners

- Conf often **88–94**, not 100.
- Entry ret_5d in **~10–20%** (SQLite).
- Moderate volume (≈2–3×), not ignition extremes.
- Examples: GRND, KFRC, NGNE (second print).

### Regime note

6/28 looked like a friendly continuation day for breakouts. Early July produced more **blow-up breakouts**. A strategy that only “worked” on 6/28 is not proven; the follow-up sample is small but clearly weaker.

---

## 5. Recommended program updates (rules + AI)

Priority order for maximizing **predictive quality of surfaced signals** (signal-only; no broker execution).

### Implemented (2026-07-16)

| # | Change | Where |
|---|--------|--------|
| 1 | Prefer ret_5d ∈ [8, 20]% in ranking; demote outside band | `signal_quality.py`, `main.py`, `config.yaml` |
| 2 | `lottery_flag` when vol ≥ 5× or ret_5d ≥ 50%; Slack only after AI pass | same + `slack.require_ai_passed` |
| 3 | Confidence is filter floor / tiebreaker only | ranking already; Slack deferred to AI |
| 5 | Persist ret_5d / ret_10d / atr / vol / breakout / flags on Firestore BUY rows | `write_buy_signals` |
| 6–7 | Scan defers Slack; entry batch LLM on **top N** by signal_quality only; rest `skipped`; UI treats skipped/filtered as non-actionable | `ai_stock_eval`, Signals page |
| 8 | Lottery → pro model + stricter min_total/conviction | `ai.lottery_*` config |
| 9 | Holding cap 10 + 12h cooldown; skip `ai_gate=filtered` paper | `ai_holding_advisor` |
| — | Research artifacts moved under `docs/research/2026-07/` | this folder |

### Still open / next research

4. Keep default hold at 3 (no code change needed; trailing stays optional).  
10. Next cohort note should join AI gate vs hold PnL with n≫1 (`research_profit_hold_cohort.py` already emits `ai_gate`).  
11–12. Weekly re-run into a new month folder when starting the next research cycle.

### C. Research hygiene

```bash
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-06-29 \
  --out-csv docs/research/2026-07/profit_hold_cohort_2026-07.csv \
  --out-json docs/research/2026-07/profit_hold_cohort_2026-07_summary.json
```

Track **two ledgers**: (a) raw hold profit (this note), (b) managed stop/target (existing finalizer). Do not conflate them when claiming “win rate.”

---

## 6. What not to do (based on this sample)

- Do **not** treat conf=100 as best ideas.  
- Do **not** stretch default hold to 5 days to “give winners room” — July data moved the other way.  
- Do **not** assume the AI layer is already improving live BUYs — coverage is too low; fix the flow first.  
- Do **not** celebrate NVVE-style ignition wins without a matching filter for LHAI/LHSW clones.

---

## Appendix: mature July book (compact)

```
asof       ticker  hold%    conf  AI
2026-07-02 GRND    +2.10     93   —
2026-07-02 LHAI   -46.72    100   WAIT
2026-07-02 NGNE   +12.87     94   —
2026-07-06 GPC     -6.26     96   —
2026-07-06 REAX    -1.38     94   —
2026-07-06 RIVN    -2.74     88   —
2026-07-06 RXST    -9.45     87   —
2026-07-06 SLDE    -2.07     96   —
2026-07-07 LHSW   -49.26    100   —
2026-07-07 OFIX    +0.52     95   —
2026-07-07 RMD     -6.65     85   —
2026-07-08 KFRC    +3.00     91   —
2026-07-08 KURA    -9.01     84   —
2026-07-08 NGNE    +4.13     88   —
2026-07-09 NVVE   +86.10    100   —
2026-07-09 PRME   -24.89     99   —
```

**Related:** prior note [`signal-strategy-research-2026-07.md`](./signal-strategy-research-2026-07.md), AI pipeline [`docs/ai-signal-pipeline/`](../ai-signal-pipeline/), bot logic [`docs/bot-logic-and-strategy.md`](../bot-logic-and-strategy.md).
