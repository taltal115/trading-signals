import {
  DEFAULT_PIPELINE_THRESHOLDS,
  PIPELINE_EDGES,
  PIPELINE_STAGE_ORDER,
  type PipelineChecklistItem,
  type PipelineCondition,
  type PipelineGraph,
  type PipelineHeader,
  type PipelineNode,
  type PipelineNodeStatus,
  type PipelineStageId,
  type PipelineThresholds,
  type PipelineTraceSource,
} from './dto/pipeline-lifecycle.dto';

export interface AiEvalRow {
  id: string;
  data: Record<string, unknown>;
}

export interface UniverseSymbolInfo {
  active?: boolean;
  status?: string;
  inactive_reason?: string;
  active_kind?: string;
  last_action?: string;
  last_confidence?: number;
}

export interface PaperPositionInfo {
  id: string;
  status?: string;
  holding_advice?: Record<string, unknown>;
  holding_advice_at_utc?: string;
  checks?: { id: string; data: Record<string, unknown> }[];
}

export interface AssembleLifecycleInput {
  docId: string;
  ticker: string;
  signalIndex: number;
  asofDate: string;
  signal: Record<string, unknown>;
  aiEvals: AiEvalRow[];
  universe?: UniverseSymbolInfo | null;
  paper?: PaperPositionInfo | null;
  thresholds?: Partial<PipelineThresholds>;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function metric(signal: Record<string, unknown>, key: string): number | null {
  const top = num(signal[key]);
  if (top != null) return top;
  const m = asObj(signal['metrics']);
  return num(m[key]);
}

function mergeThresholds(
  signal: Record<string, unknown>,
  override?: Partial<PipelineThresholds>,
): { thresholds: PipelineThresholds; fromPersisted: boolean } {
  const trace = asObj(signal['pipeline_trace']);
  const snap = asObj(trace['thresholds']);
  const fromPersisted = Object.keys(snap).length > 0;
  const base = { ...DEFAULT_PIPELINE_THRESHOLDS, ...override };
  if (!fromPersisted) {
    return { thresholds: base, fromPersisted: false };
  }
  return {
    thresholds: {
      ...base,
      continuation_ret_5d_min_pct:
        num(snap['continuation_ret_5d_min_pct']) ?? base.continuation_ret_5d_min_pct,
      continuation_ret_5d_max_pct:
        num(snap['continuation_ret_5d_max_pct']) ?? base.continuation_ret_5d_max_pct,
      continuation_vol_ratio_min:
        num(snap['continuation_vol_ratio_min']) ?? base.continuation_vol_ratio_min,
      continuation_vol_ratio_max:
        num(snap['continuation_vol_ratio_max']) ?? base.continuation_vol_ratio_max,
      hard_reject_ret_5d_min_pct:
        num(snap['hard_reject_ret_5d_min_pct']) ?? base.hard_reject_ret_5d_min_pct,
      hard_reject_vol_ratio_min:
        num(snap['hard_reject_vol_ratio_min']) ?? base.hard_reject_vol_ratio_min,
      hard_reject_confidence_min:
        num(snap['hard_reject_confidence_min']) ?? base.hard_reject_confidence_min,
      require_continuation_band:
        snap['require_continuation_band'] == null
          ? base.require_continuation_band
          : Boolean(snap['require_continuation_band']),
      ret_5d_min_pct: num(snap['ret_5d_min_pct']) ?? base.ret_5d_min_pct,
      ret_10d_min_pct: num(snap['ret_10d_min_pct']) ?? base.ret_10d_min_pct,
      vol_ratio_min: num(snap['vol_ratio_min']) ?? base.vol_ratio_min,
      min_buy_confidence: num(snap['min_buy_confidence']) ?? base.min_buy_confidence,
      entry_min_total: num(snap['entry_min_total']) ?? base.entry_min_total,
      entry_min_conviction: num(snap['entry_min_conviction']) ?? base.entry_min_conviction,
    },
    fromPersisted: true,
  };
}

function conditionsFromTraceStage(
  signal: Record<string, unknown>,
  stageId: string,
): PipelineCondition[] | null {
  const trace = asObj(signal['pipeline_trace']);
  const stages = asObj(trace['stages']);
  const stage = asObj(stages[stageId]);
  const raw = stage['conditions'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map((c, i) => {
    const o = asObj(c);
    return {
      id: str(o['id']) || `c${i}`,
      label: str(o['label']) || str(o['id']) || `Condition ${i + 1}`,
      pass: Boolean(o['pass']),
      actual: (o['actual'] as string | number | boolean | null | undefined) ?? null,
      threshold: (o['threshold'] as string | number | boolean | null | undefined) ?? null,
      detail: str(o['detail']) || undefined,
    };
  });
}

function inContinuationBand(
  ret5d: number | null,
  vol: number | null,
  t: PipelineThresholds,
): boolean {
  if (!t.require_continuation_band) return true;
  if (ret5d == null || vol == null) return false;
  return (
    ret5d >= t.continuation_ret_5d_min_pct &&
    ret5d <= t.continuation_ret_5d_max_pct &&
    vol >= t.continuation_vol_ratio_min &&
    vol < t.continuation_vol_ratio_max
  );
}

function buildHeader(
  input: AssembleLifecycleInput,
): PipelineHeader {
  const s = input.signal;
  return {
    ticker: input.ticker.toUpperCase(),
    asofDate: input.asofDate,
    docId: input.docId,
    signalIndex: input.signalIndex,
    aiGate: str(s['ai_gate']) || 'pending',
    confidence: num(s['confidence']),
    score: num(s['score']),
    close: num(s['close']),
    stop: num(s['stop']),
    target: num(s['target']),
    holdDays: num(s['hold_days']),
    notes: str(s['notes']) || null,
    paperStatus: str(s['paper_status']) || null,
    paperPositionId: str(s['paper_position_id']) || null,
  };
}

function nodeUniverse(
  input: AssembleLifecycleInput,
): PipelineNode {
  const u = input.universe;
  if (!u) {
    return {
      id: 'universe',
      label: 'Universe',
      status: 'not_run',
      summary: 'No universe snapshot for this asof',
      job: 'universe-discovery',
      conditions: [],
      detail: { message: 'no universe snapshot for this asof' },
    };
  }
  const active = Boolean(u.active);
  const status = str(u.status) || (active ? 'active' : 'inactive');
  // A Firestore BUY already exists — inactive universe is informational, not the pipeline fail point.
  const nodeStatus: PipelineNodeStatus = active ? 'passed' : 'degraded';
  return {
    id: 'universe',
    label: 'Universe',
    status: nodeStatus,
    summary: active
      ? `${status}${u.active_kind ? ` (${u.active_kind})` : ''}`
      : str(u.inactive_reason) || status,
    job: 'universe-discovery',
    conditions: [
      {
        id: 'active',
        label: 'In active universe',
        pass: active,
        actual: active,
        detail: status,
      },
    ],
    detail: { ...u },
  };
}

function nodeScan(
  signal: Record<string, unknown>,
  t: PipelineThresholds,
  persisted: boolean,
): PipelineNode {
  const ret5 = metric(signal, 'ret_5d_pct');
  const ret10 = metric(signal, 'ret_10d_pct');
  const vol = metric(signal, 'vol_ratio');
  const conf = num(signal['confidence']);
  const notes = str(signal['notes']);
  const fromTrace = conditionsFromTraceStage(signal, 'scan');
  const conditions: PipelineCondition[] =
    fromTrace ??
    [
      {
        id: 'momentum_5d',
        label: 'ret_5d ≥ min',
        pass: ret5 != null && ret5 >= t.ret_5d_min_pct,
        actual: ret5,
        threshold: t.ret_5d_min_pct,
      },
      {
        id: 'momentum_10d',
        label: 'ret_10d ≥ min',
        pass: ret10 != null && ret10 >= t.ret_10d_min_pct,
        actual: ret10,
        threshold: t.ret_10d_min_pct,
      },
      {
        id: 'volume',
        label: 'vol_ratio ≥ min',
        pass: vol != null && vol >= t.vol_ratio_min,
        actual: vol,
        threshold: t.vol_ratio_min,
      },
      {
        id: 'min_confidence',
        label: 'confidence ≥ min_buy_confidence',
        pass: conf != null && conf >= t.min_buy_confidence,
        actual: conf,
        threshold: t.min_buy_confidence,
      },
    ];
  return {
    id: 'scan',
    label: 'Scan / strategy',
    status: 'passed',
    summary:
      conf != null
        ? `BUY conf ${conf}${notes ? ` — ${notes}` : ''}`
        : notes || 'Technical BUY',
    job: 'breakout-scan',
    conditions,
    detail: {
      confidence: conf,
      score: num(signal['score']),
      notes,
      thresholdsSource: persisted ? 'persisted' : 'inferred',
    },
  };
}

function nodeHardFilters(
  signal: Record<string, unknown>,
  t: PipelineThresholds,
  persisted: boolean,
): PipelineNode {
  const ret5 = metric(signal, 'ret_5d_pct');
  const vol = metric(signal, 'vol_ratio');
  const conf = num(signal['confidence']);
  const fromTrace = conditionsFromTraceStage(signal, 'hard_filters');
  const conditions: PipelineCondition[] =
    fromTrace ??
    [
      {
        id: 'not_lottery_ret',
        label: `ret_5d < ${t.hard_reject_ret_5d_min_pct}% (lottery)`,
        pass: ret5 == null || ret5 < t.hard_reject_ret_5d_min_pct,
        actual: ret5,
        threshold: t.hard_reject_ret_5d_min_pct,
      },
      {
        id: 'not_lottery_vol',
        label: `vol < ${t.hard_reject_vol_ratio_min}× (lottery)`,
        pass: vol == null || vol < t.hard_reject_vol_ratio_min,
        actual: vol,
        threshold: t.hard_reject_vol_ratio_min,
      },
      {
        id: 'continuation_ret',
        label: `ret_5d in [${t.continuation_ret_5d_min_pct}, ${t.continuation_ret_5d_max_pct}]`,
        pass:
          !t.require_continuation_band ||
          (ret5 != null &&
            ret5 >= t.continuation_ret_5d_min_pct &&
            ret5 <= t.continuation_ret_5d_max_pct),
        actual: ret5,
        threshold: `[${t.continuation_ret_5d_min_pct}, ${t.continuation_ret_5d_max_pct}]`,
      },
      {
        id: 'continuation_vol',
        label: `vol in [${t.continuation_vol_ratio_min}, ${t.continuation_vol_ratio_max})`,
        pass:
          !t.require_continuation_band ||
          (vol != null &&
            vol >= t.continuation_vol_ratio_min &&
            vol < t.continuation_vol_ratio_max),
        actual: vol,
        threshold: `[${t.continuation_vol_ratio_min}, ${t.continuation_vol_ratio_max})`,
      },
    ];
  if (t.hard_reject_confidence_min > 0 && !fromTrace) {
    conditions.push({
      id: 'conf_cap',
      label: `confidence < ${t.hard_reject_confidence_min}`,
      pass: conf == null || conf < t.hard_reject_confidence_min,
      actual: conf,
      threshold: t.hard_reject_confidence_min,
    });
  }
  const band = inContinuationBand(ret5, vol, t);
  return {
    id: 'hard_filters',
    label: 'Hard filters',
    status: 'passed',
    summary: band
      ? `In-band ret_5d ${ret5 ?? '—'}% / vol ${vol ?? '—'}×`
      : `Passed (ret_5d ${ret5 ?? '—'}% / vol ${vol ?? '—'}×)`,
    job: 'breakout-scan',
    conditions,
    detail: {
      in_continuation_band: band,
      lottery_flag: Boolean(signal['lottery_flag'] ?? asObj(signal['metrics'])['lottery_flag']),
      thresholdsSource: persisted ? 'persisted' : 'inferred',
    },
  };
}

function latestEntryEval(evals: AiEvalRow[]): AiEvalRow | null {
  const entry = evals.filter((e) => str(e.data['stage']).toLowerCase() === 'entry');
  return entry[0] ?? null;
}

function latestHoldingEval(evals: AiEvalRow[]): AiEvalRow | null {
  const holding = evals.filter((e) => str(e.data['stage']).toLowerCase() === 'holding');
  return holding[0] ?? null;
}

function nodeEntryQueue(
  signal: Record<string, unknown>,
  t: PipelineThresholds,
  entryEval: AiEvalRow | null,
): PipelineNode {
  const gate = str(signal['ai_gate']).toLowerCase() || 'pending';
  const ret5 = metric(signal, 'ret_5d_pct');
  const vol = metric(signal, 'vol_ratio');
  const inBand = inContinuationBand(ret5, vol, t);
  const detail = asObj(entryEval?.data['detail']);
  const recDetail = asObj(asObj(signal['recommendation'])['detail']);
  const skipReason =
    str(detail['skip_reason']) || str(recDetail['skip_reason']);
  const rank = num(detail['rank']) ?? num(recDetail['rank']);
  const topN = num(detail['top_n']) ?? num(recDetail['top_n']);
  const fromTrace = conditionsFromTraceStage(signal, 'entry_queue');

  const conditions: PipelineCondition[] =
    fromTrace ??
    [
      {
        id: 'in_band',
        label: 'In continuation band (queue priority)',
        pass: inBand,
        actual: inBand,
        detail: `ret_5d=${ret5 ?? '—'}, vol=${vol ?? '—'}`,
      },
    ];

  if (gate === 'skipped' && skipReason === 'rank_below_top_n') {
    conditions.push({
      id: 'top_n',
      label: 'Within entry LLM top-N',
      pass: false,
      actual: rank,
      threshold: topN,
      detail: `rank ${rank ?? '?'} > top ${topN ?? '?'}`,
    });
    return {
      id: 'entry_queue',
      label: 'Entry queue',
      status: 'skipped',
      summary: `Skipped — rank ${rank ?? '?'} > top ${topN ?? '?'}`,
      job: 'ai-entry-batch',
      atUtc: str(entryEval?.data['ts_utc']) || undefined,
      conditions,
      detail: { skip_reason: skipReason, rank, top_n: topN, in_band: inBand },
      raw: entryEval?.data,
    };
  }

  if (gate === 'pending' && !entryEval) {
    return {
      id: 'entry_queue',
      label: 'Entry queue',
      status: 'pending',
      summary: inBand ? 'Queued — awaiting entry AI' : 'Out-of-band — awaiting rank/LLM',
      job: 'ai-entry-batch',
      conditions,
      detail: { in_band: inBand },
    };
  }

  return {
    id: 'entry_queue',
    label: 'Entry queue',
    status: 'passed',
    summary: inBand ? 'Selected for entry eval' : 'Evaluated (out-of-band / ranked)',
    job: 'ai-entry-batch',
    atUtc: str(entryEval?.data['ts_utc']) || undefined,
    conditions,
    detail: { in_band: inBand },
  };
}

/** Labels for flat boolean `provider_status` from `build_provider_status_dict`. */
const PROVIDER_STATUS_META: Record<
  string,
  { label: string; optional?: boolean; group: 'news' | 'market' | 'macro' | 'other' }
> = {
  finnhub_configured: { label: 'Finnhub API key configured', group: 'news' },
  finnhub_news_ok: { label: 'Finnhub news headlines', group: 'news' },
  finnhub_quote_ok: { label: 'Finnhub quote', group: 'market' },
  newsapi_configured: { label: 'NewsAPI key configured', group: 'news', optional: true },
  newsapi_ok: { label: 'NewsAPI headlines', group: 'news', optional: true },
  gdelt_enabled: { label: 'GDELT enabled', group: 'news', optional: true },
  gdelt_ok: { label: 'GDELT headlines', group: 'news', optional: true },
  history_ok: { label: 'OHLCV history usable', group: 'market' },
  yahoo_history_ok: { label: 'Yahoo history', group: 'market', optional: true },
  stooq_history_ok: { label: 'Stooq history', group: 'market', optional: true },
  spy_ok: { label: 'SPY context history', group: 'market', optional: true },
  fred_configured: { label: 'FRED API key configured', group: 'macro', optional: true },
  fred_ok: { label: 'FRED macro events', group: 'macro', optional: true },
  firestore_candidate_ok: { label: 'Firestore candidate score', group: 'other' },
};

function providerFlagOk(val: unknown): boolean | null {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (['true', '1', 'ok', 'healthy', 'yes'].includes(s)) return true;
    if (['false', '0', 'fail', 'failed', 'no'].includes(s)) return false;
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const o = val as Record<string, unknown>;
    if (o['ok'] === true || o['status'] === 'ok' || o['status'] === 'healthy') return true;
    if (o['ok'] === false) return false;
    if (o['skipped'] === true) return true;
  }
  return null;
}

function nodeNewsContext(
  signal: Record<string, unknown>,
  entryEval: AiEvalRow | null,
  gate: string,
  queueStatus: PipelineNodeStatus,
): PipelineNode {
  if (queueStatus === 'skipped' || queueStatus === 'pending') {
    return {
      id: 'news_context',
      label: 'News / context',
      status: 'not_run',
      summary: queueStatus === 'skipped' ? 'Skipped with queue' : 'Waiting on queue',
      job: 'ai-entry-batch',
      conditions: [],
    };
  }
  if (!entryEval) {
    return {
      id: 'news_context',
      label: 'News / context',
      status: gate === 'pending' ? 'pending' : 'not_run',
      summary: 'No entry eval yet',
      job: 'ai-entry-batch',
      conditions: [],
    };
  }
  const detail = asObj(entryEval.data['detail']);
  const providers = asObj(detail['provider_status']);
  const conditions: PipelineCondition[] = [];

  const preferredOrder = [
    'finnhub_news_ok',
    'finnhub_configured',
    'newsapi_ok',
    'newsapi_configured',
    'gdelt_ok',
    'gdelt_enabled',
    'finnhub_quote_ok',
    'history_ok',
    'yahoo_history_ok',
    'stooq_history_ok',
    'spy_ok',
    'fred_ok',
    'fred_configured',
    'firestore_candidate_ok',
  ];
  const keys = [
    ...preferredOrder.filter((k) => k in providers),
    ...Object.keys(providers).filter((k) => !preferredOrder.includes(k)),
  ];

  let newsHeadlineOk = false;
  let coreMarketOk = false;
  let optionalFail = false;
  let requiredFail = false;

  for (const name of keys) {
    const val = providers[name];
    const ok = providerFlagOk(val);
    if (ok == null) continue;
    const meta = PROVIDER_STATUS_META[name] || {
      label: name,
      group: 'other' as const,
      optional: true,
    };
    if (name === 'finnhub_news_ok' || name === 'newsapi_ok') {
      if (ok) newsHeadlineOk = true;
    }
    if (name === 'history_ok' || name === 'finnhub_quote_ok') {
      if (ok) coreMarketOk = true;
      else requiredFail = true;
    }
    if (!ok && meta.optional) optionalFail = true;
    if (!ok && !meta.optional && name !== 'finnhub_news_ok' && name !== 'newsapi_ok') {
      // finnhub_news / newsapi are OR'd — handled below
      if (name === 'finnhub_configured' && !ok) requiredFail = true;
    }
    conditions.push({
      id: name,
      label: meta.label,
      pass: ok,
      actual: ok,
      threshold: meta.optional ? 'optional' : 'required',
      detail: meta.optional && !ok ? 'Optional — entry continues without it' : undefined,
    });
  }

  // Either Finnhub or NewsAPI headlines is enough for the news path.
  const newsPass =
    newsHeadlineOk ||
    providerFlagOk(providers['finnhub_news_ok']) === true ||
    providerFlagOk(providers['newsapi_ok']) === true;
  if (!newsPass && ('finnhub_news_ok' in providers || 'newsapi_ok' in providers)) {
    optionalFail = true; // still not a hard gate fail per product rules
  }

  if (conditions.length === 0) {
    return {
      id: 'news_context',
      label: 'News / context',
      status: 'degraded',
      summary: 'No provider_status on eval',
      job: 'ai-entry-batch',
      atUtc: str(entryEval.data['ts_utc']) || undefined,
      conditions: [],
      detail: { provider_status: providers },
      raw: detail,
    };
  }

  let status: PipelineNodeStatus;
  let summary: string;
  if (newsPass && coreMarketOk && !optionalFail && !requiredFail) {
    status = 'passed';
    summary = 'News + context providers OK';
  } else if (newsPass || coreMarketOk) {
    status = 'degraded';
    const bits: string[] = [];
    if (newsPass) bits.push('headlines OK');
    else bits.push('no headlines');
    if (optionalFail) bits.push('optional providers missed');
    if (requiredFail) bits.push('some core flags failed');
    summary = bits.join(' — ') + ' (entry continued)';
  } else {
    status = 'degraded';
    summary = 'News incomplete — entry continued';
  }

  return {
    id: 'news_context',
    label: 'News / context',
    status,
    summary,
    job: 'ai-entry-batch',
    atUtc: str(entryEval.data['ts_utc']) || undefined,
    conditions,
    detail: { provider_status: providers },
    raw: detail,
  };
}

function parseChecklist(rec: Record<string, unknown>): PipelineChecklistItem[] {
  const raw = rec['checklist'];
  if (!Array.isArray(raw)) return [];
  return raw.map((c, i) => {
    const o = asObj(c);
    return {
      id: str(o['id']) || `item${i}`,
      label: str(o['label']) || str(o['id']) || `Item ${i + 1}`,
      pass: Boolean(o['pass']),
    };
  });
}

function nodeAiEntry(
  signal: Record<string, unknown>,
  entryEval: AiEvalRow | null,
  queueStatus: PipelineNodeStatus,
): PipelineNode {
  if (queueStatus === 'skipped') {
    return {
      id: 'ai_entry',
      label: 'AI entry',
      status: 'not_run',
      summary: 'LLM not run (rank skip)',
      job: 'ai-entry-batch',
      conditions: [],
    };
  }
  if (!entryEval && str(signal['ai_gate']).toLowerCase() === 'pending') {
    return {
      id: 'ai_entry',
      label: 'AI entry',
      status: 'pending',
      summary: 'Awaiting LLM entry eval',
      job: 'ai-entry-batch',
      conditions: [],
    };
  }
  if (!entryEval && !asObj(signal['recommendation'])['decision']) {
    return {
      id: 'ai_entry',
      label: 'AI entry',
      status: 'not_run',
      summary: 'No entry evaluation',
      job: 'ai-entry-batch',
      conditions: [],
    };
  }
  const rec = asObj(
    entryEval?.data['recommendation'] ?? signal['recommendation'],
  );
  const decision = str(rec['decision']) || str(entryEval?.data['decision']) || '—';
  const scores = asObj(rec['scores']);
  const total = num(scores['total']);
  const checklist = parseChecklist(rec);
  const ai = asObj(signal['ai']);
  return {
    id: 'ai_entry',
    label: 'AI entry',
    status: 'passed',
    summary: `${decision}${total != null ? ` · total ${total}` : ''}`,
    job: 'ai-entry-batch',
    atUtc: str(entryEval?.data['ts_utc'] || ai['last_at_utc']) || undefined,
    conditions: checklist.map((c) => ({
      id: c.id,
      label: c.label,
      pass: c.pass,
      actual: c.pass,
    })),
    checklist,
    detail: {
      decision,
      headline: str(rec['headline']),
      why: str(rec['why']),
      scores,
      model: str(entryEval?.data['model'] || ai['model']),
      tokens: num(entryEval?.data['total_tokens'] ?? ai['total_tokens']),
      estimated_cost_usd: num(
        entryEval?.data['estimated_cost_usd'] ?? ai['estimated_cost_usd'],
      ),
    },
    raw: entryEval?.data ?? rec,
  };
}

function nodeAiGate(
  signal: Record<string, unknown>,
  t: PipelineThresholds,
  entryEval: AiEvalRow | null,
  queueStatus: PipelineNodeStatus,
): PipelineNode {
  const gate = str(signal['ai_gate']).toLowerCase() || 'pending';
  if (queueStatus === 'skipped') {
    return {
      id: 'ai_gate',
      label: 'AI gate',
      status: 'not_run',
      summary: 'Not reached (queue skip)',
      job: 'ai-entry-batch',
      conditions: [],
    };
  }
  if (gate === 'pending') {
    return {
      id: 'ai_gate',
      label: 'AI gate',
      status: 'pending',
      summary: 'Pending AI evaluation',
      job: 'ai-entry-batch',
      conditions: [],
    };
  }
  const rec = asObj(
    entryEval?.data['recommendation'] ?? signal['recommendation'],
  );
  const decision = str(rec['decision']).toUpperCase();
  const scores = asObj(rec['scores']);
  const total = num(scores['total']) ?? 0;
  const detail = asObj(rec['detail']);
  const llm = asObj(asObj(signal['ai_evaluation'])['llm']);
  const conviction =
    num(detail['conviction']) ??
    num(asObj(llm['verdict'])['conviction']) ??
    num(asObj(entryEval?.data['detail'])['conviction']);
  const direction = str(detail['direction'] || 'long').toLowerCase();
  const longOk = !direction.startsWith('short');
  const conditions: PipelineCondition[] = [
    {
      id: 'decision_buy',
      label: 'decision == BUY',
      pass: decision === 'BUY',
      actual: decision,
      threshold: 'BUY',
    },
    {
      id: 'total',
      label: `scores.total ≥ ${t.entry_min_total}`,
      pass: total >= t.entry_min_total,
      actual: total,
      threshold: t.entry_min_total,
    },
    {
      id: 'conviction',
      label: `conviction ≥ ${t.entry_min_conviction}`,
      pass: conviction == null ? gate === 'passed' : conviction >= t.entry_min_conviction,
      actual: conviction,
      threshold: t.entry_min_conviction,
    },
    {
      id: 'long_only',
      label: 'Long-only direction',
      pass: longOk,
      actual: direction || 'long',
      threshold: 'long',
    },
  ];
  const status: PipelineNodeStatus =
    gate === 'passed' ? 'passed' : gate === 'filtered' ? 'failed' : 'skipped';
  return {
    id: 'ai_gate',
    label: 'AI gate',
    status,
    summary:
      gate === 'passed'
        ? `Passed (total ${total})`
        : `Filtered — ${decision} / total ${total}`,
    job: 'ai-entry-batch',
    atUtc: str(entryEval?.data['ts_utc']) || undefined,
    conditions,
    detail: { ai_gate: gate, decision, total, conviction, direction },
  };
}

function nodePaper(
  signal: Record<string, unknown>,
  gateStatus: PipelineNodeStatus,
  paper: PaperPositionInfo | null | undefined,
): PipelineNode {
  const gate = str(signal['ai_gate']).toLowerCase();
  if (gateStatus === 'pending' || gateStatus === 'not_run') {
    return {
      id: 'paper',
      label: 'Paper',
      status: 'not_run',
      summary: 'Waiting on AI gate',
      job: 'ai-entry-batch',
      conditions: [],
    };
  }
  if (gate === 'filtered' || gate === 'skipped') {
    return {
      id: 'paper',
      label: 'Paper',
      status: 'not_run',
      summary: 'No paper (gate not passed)',
      job: 'ai-entry-batch',
      conditions: [
        {
          id: 'open_on_pass',
          label: 'Open paper only when ai_gate=passed',
          pass: false,
          actual: gate,
          threshold: 'passed',
        },
      ],
    };
  }
  const paperStatus = str(signal['paper_status'] || paper?.status) || 'none';
  const pid = str(signal['paper_position_id'] || paper?.id);
  const open = paperStatus === 'open' || paperStatus === 'exit_advised';
  return {
    id: 'paper',
    label: 'Paper',
    status: open || paperStatus === 'closed' ? 'passed' : 'pending',
    summary: pid ? `${paperStatus} · ${pid}` : paperStatus || 'none',
    job: 'ai-entry-batch',
    conditions: [
      {
        id: 'paper_open',
        label: 'Paper position stamped',
        pass: Boolean(pid) && paperStatus !== 'none',
        actual: paperStatus,
        threshold: 'open|closed',
      },
    ],
    detail: { paper_status: paperStatus, paper_position_id: pid || null },
  };
}

function nodeHolding(
  signal: Record<string, unknown>,
  paperStatus: PipelineNodeStatus,
  holdingEval: AiEvalRow | null,
  paper: PaperPositionInfo | null | undefined,
): PipelineNode {
  if (paperStatus !== 'passed') {
    return {
      id: 'holding',
      label: 'Holding / monitor',
      status: 'not_run',
      summary: 'No open paper path',
      job: 'holding-advisor',
      conditions: [],
    };
  }
  const advice =
    asObj(signal['holding_advice']) ||
    asObj(paper?.holding_advice) ||
    asObj(holdingEval?.data['recommendation'] || holdingEval?.data['advice']);
  const adviceVal =
    str(advice['advice']) ||
    str(holdingEval?.data['decision']) ||
    '';
  const at =
    str(signal['holding_advice_at_utc']) ||
    str(paper?.holding_advice_at_utc) ||
    str(holdingEval?.data['ts_utc']);
  const checks = paper?.checks || [];
  if (!adviceVal && checks.length === 0) {
    return {
      id: 'holding',
      label: 'Holding / monitor',
      status: 'pending',
      summary: 'Awaiting holding advisor / monitor',
      job: 'holding-advisor',
      conditions: [],
    };
  }
  return {
    id: 'holding',
    label: 'Holding / monitor',
    status: 'passed',
    summary: adviceVal
      ? `${adviceVal}${checks.length ? ` · ${checks.length} checks` : ''}`
      : `${checks.length} monitor check(s)`,
    job: 'holding-advisor',
    atUtc: at || undefined,
    conditions: adviceVal
      ? [
          {
            id: 'advice',
            label: 'Holding advice',
            pass: true,
            actual: adviceVal,
          },
        ]
      : [],
    detail: {
      holding_advice: advice,
      recent_checks: checks.slice(0, 5).map((c) => ({
        id: c.id,
        ts_utc: c.data['ts_utc'],
        alert_summary: c.data['alert_summary'],
        status: c.data['status'],
      })),
    },
    raw: holdingEval?.data,
  };
}

function nodeOutcome(signal: Record<string, unknown>): PipelineNode {
  const researchStatus = str(signal['researchStatus'] || signal['research_status']);
  const pnl = num(signal['pnlPct'] ?? signal['pnl_pct']);
  const profitable = signal['isProfitable'] ?? signal['is_profitable'];
  const outcome = str(signal['outcome']);
  if (!researchStatus && pnl == null && !outcome) {
    return {
      id: 'outcome',
      label: 'Outcome',
      status: 'pending',
      summary: 'Hold window not finalized',
      job: 'signal-research',
      conditions: [],
    };
  }
  const finalized =
    researchStatus.toLowerCase() === 'finalized' ||
    Boolean(outcome) ||
    profitable != null;
  let status: PipelineNodeStatus = 'pending';
  if (finalized) {
    if (profitable === true || (pnl != null && pnl > 0)) status = 'passed';
    else if (profitable === false || (pnl != null && pnl < 0)) status = 'failed';
    else status = 'passed';
  }
  return {
    id: 'outcome',
    label: 'Outcome',
    status,
    summary: finalized
      ? `${outcome || researchStatus || 'finalized'}${pnl != null ? ` · ${pnl.toFixed(2)}%` : ''}`
      : researchStatus || 'Pending research',
    job: 'signal-research',
    conditions: [
      {
        id: 'finalized',
        label: 'Research finalized',
        pass: finalized,
        actual: researchStatus || outcome || null,
      },
      {
        id: 'pnl',
        label: 'PnL %',
        pass: pnl == null ? finalized : pnl >= 0,
        actual: pnl,
      },
    ],
    detail: {
      researchStatus,
      outcome,
      pnlPct: pnl,
      isProfitable: profitable,
      exitDate: signal['exitDate'] ?? signal['exit_date'],
      reason: signal['reason'],
    },
  };
}

function findFailPoint(nodes: PipelineNode[]): PipelineStageId | undefined {
  // Universe is informational on existing BUY rows; start fail detection at scan.
  const order = PIPELINE_STAGE_ORDER.filter((id) => id !== 'universe');
  for (const id of order) {
    const n = nodes.find((x) => x.id === id);
    if (!n) continue;
    if (n.status === 'failed' || n.status === 'skipped') return n.id;
  }
  return undefined;
}

function grayAfterFail(
  nodes: PipelineNode[],
  failPoint?: PipelineStageId,
): PipelineNode[] {
  if (!failPoint) return nodes;
  const idx = PIPELINE_STAGE_ORDER.indexOf(failPoint);
  if (idx < 0) return nodes;
  return nodes.map((n) => {
    const ni = PIPELINE_STAGE_ORDER.indexOf(n.id);
    if (ni > idx && (n.status === 'pending' || n.status === 'not_run')) {
      return { ...n, status: 'not_run' as const };
    }
    // Stages after a terminal skip/fail that were still "pending" stay not_run
    if (ni > idx && n.id !== failPoint) {
      if (n.status === 'pending') {
        return { ...n, status: 'not_run' as const, summary: n.summary || 'Not reached' };
      }
    }
    return n;
  });
}

/**
 * Build a Databricks-style lifecycle graph for one Firestore BUY signal row.
 * Prefer persisted `pipeline_trace` conditions when present; otherwise infer from metrics + thresholds.
 */
export function assemblePipelineGraph(input: AssembleLifecycleInput): PipelineGraph {
  const { thresholds, fromPersisted } = mergeThresholds(
    input.signal,
    input.thresholds,
  );
  const entryEval = latestEntryEval(input.aiEvals);
  const holdingEval = latestHoldingEval(input.aiEvals);
  const gate = str(input.signal['ai_gate']).toLowerCase() || 'pending';

  const universe = nodeUniverse(input);
  const scan = nodeScan(input.signal, thresholds, fromPersisted);
  const hard = nodeHardFilters(input.signal, thresholds, fromPersisted);
  const queue = nodeEntryQueue(input.signal, thresholds, entryEval);
  const news = nodeNewsContext(input.signal, entryEval, gate, queue.status);
  const ai = nodeAiEntry(input.signal, entryEval, queue.status);
  const aiGate = nodeAiGate(input.signal, thresholds, entryEval, queue.status);
  const paper = nodePaper(input.signal, aiGate.status, input.paper);
  const holding = nodeHolding(input.signal, paper.status, holdingEval, input.paper);
  const outcome = nodeOutcome(input.signal);

  let nodes = [universe, scan, hard, queue, news, ai, aiGate, paper, holding, outcome];
  const failPoint = findFailPoint(nodes);
  nodes = grayAfterFail(nodes, failPoint);

  const hasTrace = Boolean(asObj(input.signal['pipeline_trace'])['version']);
  let traceSource: PipelineTraceSource = 'inferred';
  if (hasTrace && fromPersisted) traceSource = 'persisted';
  else if (hasTrace || fromPersisted) traceSource = 'mixed';

  const header = buildHeader(input);

  return {
    version: 1,
    traceSource,
    inferredBanner:
      traceSource !== 'persisted'
        ? 'Conditions inferred from current config defaults; older runs may differ from thresholds used at scan time.'
        : undefined,
    header,
    nodes,
    edges: PIPELINE_EDGES,
    failPoint,
  };
}
