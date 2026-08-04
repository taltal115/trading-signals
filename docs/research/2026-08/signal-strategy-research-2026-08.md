# Signal strategy research — August 2026 (why recent BUYs lost money)

**Analysis date:** 2026-08-04  
**Prior notes:** [`../2026-07/signal-strategy-research-2026-07-followup-2.md`](../2026-07/signal-strategy-research-2026-07-followup-2.md) (2026-07-20)

**Question:** Since the July research + confidence-band / overextension fixes, how did later BUY signals perform on a **3 trading-day hold**, and **why did most lose money**?

**Primary metric:** raw close-to-close return after each signal’s `hold_days` (almost always **3** NYSE sessions). Managed stop/target is contrast only.

**Data:** Firestore `signals` + Yahoo/Stooq forwards; SQLite feature join for `ret_5d` / `vol_ratio` / `atr_pct` where Firestore metrics were null.

**Scripts / artifacts:**

```bash
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-06-29 \
  --out-csv docs/research/2026-08/profit_hold_cohort_since_2026-06-29.csv \
  --out-json docs/research/2026-08/profit_hold_cohort_since_2026-06-29_summary.json

PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-07-20 \
  --out-csv docs/research/2026-08/profit_hold_cohort_post_fix_2026-07-20.csv \
  --out-json docs/research/2026-08/profit_hold_cohort_post_fix_2026-07-20_summary.json
```

Also: `failure_analysis_enriched.json`, `profit_hold_cohort_since_2026-06-29_enriched.csv`.

---

## Executive summary

| Cohort | n mature | Win% @ 3d | Avg @ hold | Median | PF | Sum % PnL |
|--------|----------|-----------|------------|--------|-----|-----------|
| Full book since 2026-06-29 | 29 | **24.1%** | **−8.92%** | −6.65% | **0.30** | −258.7 |
| Same excl. NVVE Jul-9 lottery | 28 | 21.4% | −12.31% | −7.83% | 0.06 | −344.8 |
| Pre Jul-20 ranking fix | 21 | 28.6% | −8.62% | −6.65% | 0.38 | −181.1 |
| **Post Jul-20 fix** | 8 | **12.5%** | **−9.70%** | −7.55% | **0.01** | −77.6 |
| Conf ≥ 98 only | 10 | 10.0% | −17.71% | −27.25% | 0.33 | **−177.1** |
| Conf 90–94 only | 9 | **44.4%** | −0.43% | −0.79% | 0.83 | −3.8 |
| AI said WAIT / filtered | 9 | 11.1% | −14.31% | −10.56% | 0.01 | −128.8 |
| If hard-drop AI WAIT | 20 | 30.0% | −6.49% | −6.46% | 0.46 | −129.9 |
| Managed finalized (contrast) | 29 | 27.6% | −1.67% | — | — | — |

**Verdict**

1. The post-6/28 breakout book is still a **clear loser** at a fixed 3-day hold.
2. Most of the damage is **not random noise**: it concentrates in **conf ≥ 98**, **ret_5d ≥ 50%**, and **vol ≥ 5×** ignition / lottery names.
3. The Jul-20 ranking / cap changes **did not restore edge** on the next mature sample (n=8). Those names were mostly AI-`filtered` WAIT — AI was directionally right, but the technical stream still produced red paper.
4. Reliable small winners look different from blow-ups: mid confidence (~90–94), ret_5d in **10–20%**, vol mostly **2–3×**.
5. Stops help (managed avg −1.67% vs raw −8.92%), but they do not create a winning strategy if entry selection stays weak.

---

## 1. Full mature book (asof ≥ 2026-06-29)

### Headline (raw @ hold)

| Metric | Value |
|--------|-------|
| Mature trades | 29 |
| Wins / losses | 7 / 22 |
| Win rate | 24.1% |
| Avg / median | −8.92% / −6.65% |
| Avg win / avg loss | +15.66% / −16.74% |
| Profit factor | 0.30 |
| Sum of % PnL | −258.7 |

**+5 sessions (n=26):** win 23.1%, avg **−14.2%**, PF **0.07** — holding longer still hurts.

### All winners

| asof | ticker | hold% | conf | AI | entry ret_5d | vol |
|------|--------|-------|------|-----|--------------|-----|
| 2026-07-09 | NVVE | **+86.10** | 100 | none | ≫50% | ≥5× |
| 2026-07-02 | NGNE | +12.87 | 94 | none | 12.7% | 2.9× |
| 2026-07-08 | NGNE | +4.13 | 88 | none | 14.0% | 2.4× |
| 2026-07-08 | KFRC | +3.00 | 91 | none | 10.1% | 2.6× |
| 2026-07-02 | GRND | +2.10 | 93 | none | 19.0% | 2.2× |
| 2026-07-30 | MORN | +0.92 | 94 | filtered WAIT | 19.1% | 2.4× |
| 2026-07-07 | OFIX | +0.52 | 95 | none | 18.3% | 2.4× |

Excluding NVVE, winners averaged about **+3.9%** — small continuation, not ignition.

### Blow-ups (hold ≤ −20%)

| asof | ticker | hold% | conf | AI | ret_5d | vol | managed |
|------|--------|-------|------|-----|--------|-----|---------|
| 07-07 | LHSW | −49.3 | 100 | none | 363% | 17× | stop −15% |
| 07-02 | LHAI | −46.7 | 100 | WAIT | 285% | 20× | stop −13% |
| 07-13 | NVVE | −38.7 | 100 | none | 137% | 6× | target +44%* |
| 07-13 | SUNE | −32.1 | 100 | none | 71% | 13× | stop −16% |
| 07-14 | QTTB | −29.6 | 100 | none | 66% | 15× | stop −16% |
| 07-09 | PRME | −24.9 | 99 | none | 25% | 2.9× | stop −12% |
| 07-27 | NVCR | −23.8 | 95 | WAIT | 22% | 4.9× | stop −8% |
| 07-30 | SAH | −22.4 | 83 | WAIT | 12% | 2.1× | stop −6% |

\*NVVE Jul-13 hit target early in the managed walk, then collapsed by day-3 close — another reason not to judge only on target hits.

---

## 2. Why most signals failed

### Cause A — Confidence inversion still dominates PnL

| Conf bucket | n | Win% | Avg | Sum % PnL |
|-------------|---|------|-----|-----------|
| **100** | 9 | **11.1** | **−16.91** | **−152.2** |
| 98–99 | 1 | 0.0 | −24.89 | −24.9 |
| 95–97 | 4 | 25.0 | −7.91 | −31.6 |
| **90–94** | 9 | **44.4** | −0.43 | −3.8 |
| 80–89 | 6 | 16.7 | −7.69 | −46.1 |

**Conf ≥ 98** accounts for **−177** of the book’s **−259** sum PnL (~68% of total damage).

These names look “perfect” to the rules engine (breakout + momentum + volume), which is exactly when late buyers get trapped.

### Cause B — Extreme prior momentum / volume (lottery channel)

SQLite-joined entry features:

| Entry ret_5d | n | Win% | Avg | Sum |
|--------------|---|------|-----|-----|
| **10–20%** | 14 | **42.9** | −2.79 | −39 |
| <10% | 3 | 0.0 | −8.37 | −25 |
| 20–30% | 5 | **0.0** | −13.25 | −66 |
| **≥50%** | 7 | **14.3** | **−18.32** | **−128** |

| Vol ratio | n | Win% | Avg | Sum |
|-----------|---|------|-----|-----|
| 2–3× | 18 | 33.3 | −4.34 | −78 |
| 3–5× | 3 | 0.0 | −12.97 | −39 |
| **≥5×** | 8 | **12.5** | **−17.71** | **−142** |

The overextension **bypass** (`vol ≥ 5×`) and ignition path still admit the names that produce binary outcomes. One NVVE win (+86%) does not pay for LHSW/LHAI/SUNE/QTTB clones.

### Cause C — Regime: clustered wipeout days

Zero-win days in the mature sample:

| Day | n | Avg | Comment |
|-----|---|-----|---------|
| 2026-07-06 | 5 | −4.4% | Full wipeout |
| 2026-07-13 | 3 | −27.9% | NVVE chase + SUNE/PHAT |
| 2026-07-14 | 1 | −29.6% | QTTB |
| 2026-07-15 | 1 | −17.9% | NXTC (AI filtered) |
| 2026-07-20 | 1 | −10.6% | GPRE (AI filtered) |
| 2026-07-24 | 1 | −3.0% | OII (AI filtered) |
| 2026-07-27 | 3 | −9.7% | All AI filtered WAIT |

There is **no market-breadth / day circuit breaker**. When breakouts are failing broadly, the scanner keeps emitting BUYs.

### Cause D — AI veto is usually correct, but not a hard product filter

AI WAIT / filtered mature rows (n=9): win **11.1%**, avg **−14.3%**.

Examples AI correctly disliked: LHAI (−46.7%), NXTC (−17.9%), GPRE (−10.6%), NVCR (−23.8%), SAH (−22.4%).

Counterfactual hard-drop of AI WAIT leaves n=20 at −6.5% avg / PF 0.46 — **better, still not profitable**. AI reduces damage; it does not create edge by itself.

Post Jul-20, **7 of 8** mature technical BUYs were `ai_gate=filtered` WAIT. Research still scores them as rule BUYs. If the dashboard / paper book treats filtered rows as actionable, users see “signals that lost” even when AI already said no.

### Cause E — Jul-20 ranking fix did not restore profitability yet

| Window | n | Win% | Avg | PF |
|--------|---|------|-----|-----|
| Pre 2026-07-20 | 21 | 28.6 | −8.62 | 0.38 |
| Post 2026-07-20 | 8 | 12.5 | −9.70 | 0.01 |

What changed in code (conf-band demotion, caps 25/50) mainly affects **ranking / Slack top-N**. It does **not** hard-reject conf=100 or vol-bypass lottery names from becoming Firestore BUYs. Post-fix sample is small and almost entirely AI-rejected — ranking alone cannot fix a broken entry universe.

### Cause F — Winner profile ≠ loser profile

| Feature (avg) | Winners (n=7) | Losers (n=22) |
|---------------|---------------|---------------|
| Confidence | 93.6 | 94.3 |
| Vol ratio | 4.7* | 6.1 |
| ATR% | 6.1 | 6.6 |
| Hold return | +15.7 | −16.7 |

\*Winner vol mean is skewed by NVVE. Non-lottery winners sit near **2.2–2.9×** volume and **10–19%** ret_5d.

**Successful pattern:** moderate breakout continuation.  
**Failing pattern:** max-confidence ignition after a huge prior run.

---

## 3. Managed exits vs raw 3-day hold

| Ledger | Win% | Avg |
|--------|------|-----|
| Raw hold close | 24.1 | −8.92% |
| Finalized managed | 27.6 | −1.67% |

Stops cut the catastrophic raw tails (LHSW −49% raw → −15% managed). That is risk control, not alpha. Do not claim “27% win rate” from managed outcomes when the research question is hold profit.

---

## 4. Comparison with prior research conclusions

| Prior claim (Jul 20) | Status now |
|----------------------|------------|
| Conf=100 is toxic | **Confirmed** — still ~68% of sum PnL damage when ≥98 |
| Prefer conf 90–94 | **Partially confirmed** — best win rate, but avg still slightly red |
| Prefer ret_5d 10–20% | **Confirmed** — only non-zero win bucket with decent n |
| Lottery / ≥5× vol is binary | **Confirmed** — −17.7% avg |
| Do not extend hold to 5d | **Confirmed** — worse |
| AI WAIT should be hard filter | **Stronger evidence** — filtered book avg −10% / −14% |
| Ranking fix should improve surfaced quality | **Not yet visible** in hold PnL (sample small; filtered names still in stream) |

---

## 5. Recommended follow-ups (priority)

### P0 — Hard filters (selection, not ranking)

1. **Hard reject** (or force `ai_gate` non-actionable) when:
   - `confidence >= 98`, **or**
   - `ret_5d_pct >= 50`, **or**
   - `vol_ratio >= 5` unless a separate ignition lane with size=0 / research-only tag.
2. Treat AI `WAIT` / `filtered` as **non-actionable everywhere** (Slack already deferred; extend UI + paper + research “actionable” cohort).
3. Disable or tightly quarantine `overextension_bypass_vol_ratio` for live Slack/top-N — it is the main door for July blow-ups.

### P1 — Keep only the continuation lane

4. Prefer / require entry ret_5d ∈ **[10, 20]%** and vol ∈ **[2, 3)×** for actionable BUYs.
5. Keep default hold at **3** sessions; do not lengthen.

### P2 — Regime / day risk

6. Add a simple breadth / SPY filter or “max new BUYs / day” circuit after consecutive red days.
7. Track two ledgers explicitly in the UI: **actionable AI-passed** vs **technical-only**.

### Research hygiene

```bash
PYTHONPATH=./src:. python scripts/research_profit_hold_cohort.py \
  --since 2026-08-04 \
  --actionable-only \
  --out-csv docs/research/2026-08/profit_hold_cohort_actionable_since_2026-08-04.csv \
  --out-json docs/research/2026-08/profit_hold_cohort_actionable_since_2026-08-04_summary.json
```

Re-run weekly after ~2–3 weeks of mature holds. Score **AI-passed-only** separately from the full technical book.

---

## 5b. Implementation log (2026-08-04)

Course of action from this research + OpenAI 429 pressure:

| Change | Where |
|--------|--------|
| Hard-reject conf≥98 / ret_5d≥50 / vol≥5; require continuation band ret_5d∈[10,20] & vol∈[2,3) | `config.yaml`, `signal_quality.hard_reject_reasons`, `main._apply_hard_buy_filters` |
| Disable overextension bypass + volume ignition for live BUYs | `config.yaml` (`overextension_bypass_vol_ratio: 0`, `ignite_vol_ratio_min: 0`) |
| Paper opens only on `ai_gate=passed`; close on filtered/skipped | `firestore.write_buy_signals`, `write_entry_evaluation`, `close_signal_paper_position` |
| Holding AI: 1×/day cron, cap 3, 24h cooldown, **passed-only** | `ai-holding-advisor.yml`, `config.yaml`, `ai_holding_advisor` |
| Entry AI: max 3/run, no lottery pro force; LLM failure leaves `pending` | `config.yaml`, `ai_stock_eval/main.py`, entry batch env retries |
| Monitor skips non-passed signal paper | `monitor_open_positions.py` |
| UI default ledger = Actionable (AI passed) | Signals page toolbar |
| Research `--actionable-only` | `research_profit_hold_cohort.py` |

**Still open (P2):** market-breadth / day circuit breaker.

**Remeasure:** after 2026-08-04+ mature actionable sample accumulates, compare win% / PF vs technical book (24% / 0.30).

---

## 6. Compact mature book

```
asof       ticker  hold%    conf  AI            ret5     vol
2026-07-02 GRND    +2.10     93   —             19.0     2.2
2026-07-02 LHAI   -46.72    100   WAIT         285.4    19.9
2026-07-02 NGNE   +12.87     94   —             12.7     2.9
2026-07-06 GPC     -6.26     96   —             17.3     2.6
2026-07-06 REAX    -1.38     94   —             25.4     2.3
2026-07-06 RIVN    -2.74     88   —             25.4     2.4
2026-07-06 RXST    -9.45     87   —              9.4     2.4
2026-07-06 SLDE    -2.07     96   —             17.7     2.6
2026-07-07 LHSW   -49.26    100   —            362.6    17.1
2026-07-07 OFIX    +0.52     95   —             18.3     2.4
2026-07-07 RMD     -6.65     85   —              9.0     2.3
2026-07-08 KFRC    +3.00     91   —             10.1     2.6
2026-07-08 KURA    -9.01     84   —              9.3     2.0
2026-07-08 NGNE    +4.13     88   —             14.0     2.4
2026-07-09 NVVE   +86.10    100   —           2038.5    17.9
2026-07-09 PRME   -24.89     99   —             25.2     2.9
2026-07-13 NVVE   -38.70    100   —            137.3     6.3
2026-07-13 PHAT   -13.01     92   —             12.6     2.1
2026-07-13 SUNE   -32.11    100   —             71.0    12.5
2026-07-14 QTTB   -29.61    100   —             66.2    14.7
2026-07-15 NXTC   -17.93    100   WAIT/filt    269.7    19.6
2026-07-20 GPRE   -10.56    100   WAIT/filt     13.9     3.5
2026-07-24 OII     -3.00     92   WAIT/filt     13.5     2.1
2026-07-27 MEDP    -4.54     91   WAIT/filt     12.6     3.2
2026-07-27 NVCR   -23.81     95   WAIT/filt     21.7     4.9
2026-07-27 OII     -0.79     92   WAIT/filt     13.5     2.1
2026-07-30 LAD    -13.44    100   pending       25.7     5.2
2026-07-30 MORN    +0.92     94   WAIT/filt     19.1     2.4
2026-07-30 SAH    -22.40     83   WAIT/filt     11.7     2.1
```

---

## Summary

Most recent signals lost money because the scanner still buys **late, high-confidence, high-volume extensions** in a regime where those breakouts fail. The few real winners are quieter **10–20% / 2–3× volume** continuations. Ranking demotions and tighter caps were necessary but insufficient; the next step is **hard rejection / quarantine of lottery + conf≥98**, and treating AI WAIT as non-actionable in every ledger — not only Slack.

**Related:** July notes in [`../2026-07/`](../2026-07/), strategy config `config.yaml`, ranking helpers `src/signals_bot/strategy/signal_quality.py`.
