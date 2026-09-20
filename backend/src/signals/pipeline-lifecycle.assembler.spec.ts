/**
 * Self-check for assemblePipelineGraph (pending / skipped / filtered / passed).
 * Run: npx --yes tsx src/signals/pipeline-lifecycle.assembler.spec.ts
 */
import assert from 'node:assert/strict';
import { assemblePipelineGraph } from './pipeline-lifecycle.assembler';

function baseSignal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticker: 'TEST',
    confidence: 82,
    score: 0.82,
    close: 25.5,
    stop: 24.0,
    target: 28.0,
    hold_days: 3,
    notes: 'breakout + momentum + volume',
    ret_5d_pct: 12.4,
    ret_10d_pct: 18.0,
    vol_ratio: 2.6,
    atr_pct: 4.1,
    ai_gate: 'pending',
    ...over,
  };
}

function runPending(): void {
  const g = assemblePipelineGraph({
    docId: '2026-09-18T120000Z_run',
    ticker: 'TEST',
    signalIndex: 0,
    asofDate: '2026-09-18',
    signal: baseSignal(),
    aiEvals: [],
    universe: { active: true, status: 'eligible_buy', active_kind: 'buy' },
  });
  assert.equal(g.header.aiGate, 'pending');
  const queue = g.nodes.find((n) => n.id === 'entry_queue');
  const gate = g.nodes.find((n) => n.id === 'ai_gate');
  assert.ok(queue);
  assert.equal(queue!.status, 'pending');
  assert.ok(gate);
  assert.equal(gate!.status, 'pending');
  assert.equal(g.failPoint, undefined);
  console.log('ok pending');
}

function runSkipped(): void {
  const g = assemblePipelineGraph({
    docId: 'doc1',
    ticker: 'TEST',
    signalIndex: 0,
    asofDate: '2026-09-18',
    signal: baseSignal({
      ai_gate: 'skipped',
      recommendation: {
        decision: 'WAIT',
        detail: { skip_reason: 'rank_below_top_n', rank: 12, top_n: 8 },
      },
    }),
    aiEvals: [
      {
        id: 'doc1__TEST__entry__1',
        data: {
          stage: 'entry',
          ts_utc: '2026-09-18T15:00:00Z',
          ai_gate: 'skipped',
          detail: { skip_reason: 'rank_below_top_n', rank: 12, top_n: 8 },
          recommendation: {
            decision: 'WAIT',
            detail: { skip_reason: 'rank_below_top_n', rank: 12, top_n: 8 },
          },
        },
      },
    ],
  });
  const queue = g.nodes.find((n) => n.id === 'entry_queue');
  assert.equal(queue!.status, 'skipped');
  assert.equal(g.failPoint, 'entry_queue');
  const ai = g.nodes.find((n) => n.id === 'ai_entry');
  assert.equal(ai!.status, 'not_run');
  console.log('ok skipped');
}

function runFiltered(): void {
  const g = assemblePipelineGraph({
    docId: 'doc2',
    ticker: 'TEST',
    signalIndex: 0,
    asofDate: '2026-09-18',
    signal: baseSignal({
      ai_gate: 'filtered',
      recommendation: {
        decision: 'WAIT',
        scores: { technical: 60, ai: 40, total: 55 },
        checklist: [{ id: 'volume', label: 'Volume confirms', pass: false }],
        detail: { conviction: 0.4, direction: 'long' },
      },
    }),
    aiEvals: [
      {
        id: 'doc2__TEST__entry__1',
        data: {
          stage: 'entry',
          ts_utc: '2026-09-18T16:00:00Z',
          decision: 'WAIT',
          ai_gate: 'filtered',
          model: 'gpt-test',
          recommendation: {
            decision: 'WAIT',
            scores: { technical: 60, ai: 40, total: 55 },
            checklist: [{ id: 'volume', label: 'Volume confirms', pass: false }],
            detail: { conviction: 0.4, direction: 'long' },
          },
          detail: { provider_status: { finnhub: { ok: true, status: 'ok' } } },
        },
      },
    ],
  });
  const gate = g.nodes.find((n) => n.id === 'ai_gate');
  assert.equal(gate!.status, 'failed');
  assert.equal(g.failPoint, 'ai_gate');
  const totalCond = gate!.conditions.find((c) => c.id === 'total');
  assert.ok(totalCond);
  assert.equal(totalCond!.pass, false);
  const paper = g.nodes.find((n) => n.id === 'paper');
  assert.equal(paper!.status, 'not_run');
  console.log('ok filtered');
}

function runPassed(): void {
  const g = assemblePipelineGraph({
    docId: 'doc3',
    ticker: 'TEST',
    signalIndex: 0,
    asofDate: '2026-09-18',
    signal: baseSignal({
      ai_gate: 'passed',
      paper_status: 'open',
      paper_position_id: 'paper__doc3__TEST',
      holding_advice: { advice: 'HOLD', headline: 'Stay in' },
      holding_advice_at_utc: '2026-09-19T14:00:00Z',
      researchStatus: 'finalized',
      pnlPct: 4.2,
      isProfitable: true,
      outcome: 'target_or_time',
      recommendation: {
        decision: 'BUY',
        scores: { technical: 75, ai: 80, total: 78 },
        checklist: [{ id: 'rr', label: 'R/R ok', pass: true }],
        detail: { conviction: 0.85, direction: 'long' },
      },
      pipeline_trace: {
        version: 1,
        thresholds: {
          entry_min_total: 70,
          entry_min_conviction: 0.7,
          continuation_ret_5d_min_pct: 8,
          continuation_ret_5d_max_pct: 25,
          continuation_vol_ratio_min: 2,
          continuation_vol_ratio_max: 4,
          require_continuation_band: true,
        },
        stages: {
          scan: {
            status: 'passed',
            conditions: [
              {
                id: 'momentum_5d',
                label: 'ret_5d ≥ min',
                pass: true,
                actual: 12.4,
                threshold: 8,
              },
            ],
          },
        },
      },
    }),
    aiEvals: [
      {
        id: 'doc3__TEST__entry__1',
        data: {
          stage: 'entry',
          ts_utc: '2026-09-18T17:00:00Z',
          decision: 'BUY',
          ai_gate: 'passed',
          recommendation: {
            decision: 'BUY',
            scores: { technical: 75, ai: 80, total: 78 },
            checklist: [{ id: 'rr', label: 'R/R ok', pass: true }],
            detail: { conviction: 0.85, direction: 'long' },
          },
          detail: {
            provider_status: {
              finnhub: { ok: true, status: 'ok' },
              gdelt: { ok: false, status: 'timeout' },
            },
          },
        },
      },
      {
        id: 'doc3__TEST__holding__1',
        data: {
          stage: 'holding',
          ts_utc: '2026-09-19T14:00:00Z',
          decision: 'HOLD',
          recommendation: { advice: 'HOLD', headline: 'Stay in' },
        },
      },
    ],
    paper: {
      id: 'paper__doc3__TEST',
      status: 'open',
      holding_advice: { advice: 'HOLD' },
      checks: [
        {
          id: 'c1',
          data: { ts_utc: '2026-09-19T15:00:00Z', alert_summary: 'ok' },
        },
      ],
    },
    universe: { active: true, status: 'eligible_buy' },
  });
  assert.equal(g.header.aiGate, 'passed');
  assert.equal(g.traceSource, 'persisted');
  assert.equal(g.failPoint, undefined);
  assert.equal(g.nodes.find((n) => n.id === 'ai_gate')!.status, 'passed');
  assert.equal(g.nodes.find((n) => n.id === 'paper')!.status, 'passed');
  assert.equal(g.nodes.find((n) => n.id === 'holding')!.status, 'passed');
  assert.equal(g.nodes.find((n) => n.id === 'outcome')!.status, 'passed');
  assert.equal(g.nodes.find((n) => n.id === 'news_context')!.status, 'degraded');
  console.log('ok passed');
}

runPending();
runSkipped();
runFiltered();
runPassed();
console.log('All lifecycle assembler fixtures passed.');
