import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { HttpParams } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { Subscription, switchMap, catchError, of, tap, firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { MarketDataService } from '../../core/market-data.service';
import { OpenPositionService } from '../../core/open-position.service';
import { PositionsStoreService } from '../../core/positions-store.service';
import { SignalsNewBadgeService } from '../../core/signals-new-badge.service';
import {
  BracketPct,
  extractBracketPctsFromSignal,
  fmtMoneyInput,
  fmtSignedUsd,
  fmtUsd,
  fmtUiDecimal,
  fmtUiPercent,
  roundUi,
} from '../../core/positions-logic';
import { formatApiErr } from '../../core/api-errors';
import {
  isProviderQuotaError,
  type StockSnapshot,
} from '../../core/market-data.service';
import { environment } from '../../../environments/environment';
import { normalizeSignalDocs, normalizeSignalsApiResponse, type SignalDoc, type SignalInstanceRow } from '../../core/signal-docs-normalize';

/** One flattened BUY line from any run document (for cross-doc grouping). */
type FlatSigInst = {
  docId: string;
  asofDate: string;
  /** Run document ordering (newest run wins ties). */
  docTsMs: number;
  index: number;
  s: Record<string, unknown>;
  tickerU: string;
  sigSortMs: number;
};

type SigDisplayRow = {
  kind: 'sig';
  role: 'primary' | 'older';
  docId: string;
  asofDate: string;
  s: Record<string, unknown>;
  /** Index in Firestore `signals[]` for APIs and Log Buy context. */
  signalIndex: number;
  /** Unique per Firestore signal object: `${docId}\t${index}` */
  instanceKey: string;
  /** Stable key for duplicates: uppercase ticker — one parent row per stock in the table. */
  groupKey: string;
  /** One row per ticker in a run (`docId\tticker`) — badge ack (`acknowledgeLogBuy`). */
  rowKey: string;
  olderCount: number;
};

type DisplayRow = SigDisplayRow | { kind: 'form'; instanceKey: string };

type SignalsPage = { rows: SignalInstanceRow[]; nextCursor: string | null };
type SignalsListApiResponse = {
  rows?: SignalInstanceRow[];
  docs?: { id: string; data: SignalDoc }[];
  nextCursor?: string | null;
  latestRun?: { id: string; data: SignalDoc } | null;
};
const SIGNALS_PAGE_SIZE_OPTIONS = [10, 20, 30, 40, 50] as const;

function parseSignalTimeMs(s: Record<string, unknown>): number | null {
  for (const k of ['ts_utc', 'signal_ts', 'updated_at', 'created_at']) {
    const v = s[k];
    if (typeof v === 'string' && v.trim()) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

/** Lower = more actionable for table sort (passed > pending > filtered/none). */
function aiGateRank(s: Record<string, unknown>): number {
  const gate = String(s['ai_gate'] || '')
    .trim()
    .toLowerCase();
  if (gate === 'passed') return 0;
  if (gate === 'pending' || gate === '') return 1;
  if (gate === 'filtered') return 2;
  if (gate === 'skipped') return 2;
  return 3;
}

function compareInstances(a: FlatSigInst, b: FlatSigInst): number {
  // Newest first (run timestamp, then per-signal time). AI gate is only a tiebreaker.
  if (b.docTsMs !== a.docTsMs) return b.docTsMs - a.docTsMs;
  const d = b.sigSortMs - a.sigSortMs;
  if (d !== 0) return d;
  const ag = aiGateRank(a.s) - aiGateRank(b.s);
  if (ag !== 0) return ag;
  if (b.index !== a.index) return b.index - a.index;
  return a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0;
}

/** Prefer explicit timestamps; otherwise treat later array indices as newer. */
function sortKeyForInstance(s: Record<string, unknown>, index: number): number {
  const ms = parseSignalTimeMs(s);
  if (ms != null) return ms;
  return index;
}

type StockDetailEntry =
  | { expanded: false }
  | { expanded: true; status: 'loading' }
  | { expanded: true; status: 'error'; message: string }
  | { expanded: true; status: 'ok'; data: StockSnapshot };

/** Normalized AI view: prefers clear `recommendation` + `ai` summary; falls back to legacy `ai_evaluation`. */
export interface AiEvaluationView {
  action: string;
  actionClass: string;
  gate: string;
  convictionPct: number | null;
  total: number | null;
  candidate: number | null;
  aiComponent: number | null;
  summary: string;
  whyNow: string;
  headline: string;
  riskLevel: string;
  timeframe: string;
  source: string;
  evaluatedAt: string;
  model: string;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  evalCount: number;
  entry: { min: number | null; ideal: number | null; max: number | null } | null;
  stop: number | null;
  target: number | null;
  holdDays: number | null;
  targets: { label: string; price: number | null }[];
  riskReward: number | null;
  positionSize: string;
  risks: string[];
  invalidation: string;
  confidenceFactors: string[];
  checklist: { id: string; label: string; pass: boolean }[];
}

export interface AiHistoryRow {
  id: string;
  tsUtc: string;
  stage: string;
  decision: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  headline: string;
  recommendation: Record<string, unknown> | null;
}

function _num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function _str(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

function _strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => _str(x)).filter((s) => s.length > 0);
}

function aiActionClassOf(action: string): string {
  const a = action.trim().toUpperCase();
  if (a === 'BUY' || a === 'STRONG_BUY' || a === 'PASSED') return 'ai-action-buy';
  if (a === 'SELL' || a === 'STRONG_SELL' || a === 'AVOID' || a === 'EXIT') return 'ai-action-sell';
  if (a === 'WAIT' || a === 'HOLD' || a === 'NEUTRAL' || a === 'PENDING' || a === 'FILTERED')
    return 'ai-action-wait';
  return 'ai-action-other';
}

function buildAiEvaluationView(rowSignal: Record<string, unknown>): AiEvaluationView | null {
  const rec = rowSignal['recommendation'] as Record<string, unknown> | undefined;
  const ai = rowSignal['ai'] as Record<string, unknown> | undefined;
  const gate = _str(rowSignal['ai_gate']).toLowerCase();
  const legacy = rowSignal['ai_evaluation'];

  if (rec && typeof rec === 'object') {
    const scores = (rec['scores'] as Record<string, unknown> | undefined) ?? {};
    const plan = (rec['plan'] as Record<string, unknown> | undefined) ?? {};
    const entry = (plan['entry'] as Record<string, unknown> | undefined) ?? {};
    const detail = (rec['detail'] as Record<string, unknown> | undefined) ?? {};
    const checklistRaw = Array.isArray(rec['checklist']) ? (rec['checklist'] as unknown[]) : [];
    const decision = _str(rec['decision']) || _str(ai?.['last_decision']) || '—';
    return {
      action: decision,
      actionClass: aiActionClassOf(decision),
      gate: gate || (ai?.['has_eval'] ? 'evaluated' : ''),
      convictionPct: (() => {
        const c = _num(detail['conviction']);
        if (c == null) return null;
        return c <= 1 + 1e-9 ? c * 100 : c;
      })(),
      total: _num(scores['total']),
      candidate: null,
      aiComponent: _num(scores['ai']),
      summary: _str(detail['summary']) || _str(rec['why']),
      whyNow: _str(detail['why_now']) || _str(rec['why']),
      headline: _str(rec['headline']),
      riskLevel: _str(rec['risk_level']),
      timeframe: _str(detail['timeframe']),
      source: 'openai',
      evaluatedAt: _str(ai?.['last_at_utc']),
      model: _str(ai?.['model']),
      totalTokens: _num(ai?.['total_tokens']),
      estimatedCostUsd: _num(ai?.['estimated_cost_usd']),
      evalCount: _num(ai?.['eval_count']) ?? 0,
      entry: {
        min: _num(entry['min']),
        ideal: _num(entry['ideal']),
        max: _num(entry['max']),
      },
      stop: _num(plan['stop']),
      target: _num(plan['target']),
      holdDays: _num(plan['hold_days']),
      targets: Array.isArray(detail['targets'])
        ? (detail['targets'] as unknown[])
            .map((t, i) => {
              const o = t && typeof t === 'object' ? (t as Record<string, unknown>) : {};
              return { label: _str(o['label']) || `T${i + 1}`, price: _num(o['price']) };
            })
            .filter((t) => t.price != null)
        : [],
      riskReward: _num(detail['risk_reward_ratio']),
      positionSize: _str(detail['position_size_suggestion']),
      risks: _strList(detail['risks']),
      invalidation: _str(plan['invalidation']) || _str(detail['invalidation']),
      confidenceFactors: _strList(detail['confidence_factors']),
      checklist: checklistRaw
        .map((c) => {
          const o = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
          return { id: _str(o['id']), label: _str(o['label']), pass: !!o['pass'] };
        })
        .filter((c) => c.label),
    };
  }

  if (!legacy || typeof legacy !== 'object') {
    if (gate === 'pending') {
      return {
        action: 'PENDING',
        actionClass: aiActionClassOf('PENDING'),
        gate: 'pending',
        convictionPct: null,
        total: null,
        candidate: null,
        aiComponent: null,
        summary: 'Waiting for AI entry evaluation.',
        whyNow: '',
        headline: 'AI pending',
        riskLevel: '',
        timeframe: '',
        source: '',
        evaluatedAt: '',
        model: '',
        totalTokens: null,
        estimatedCostUsd: null,
        evalCount: 0,
        entry: null,
        stop: null,
        target: null,
        holdDays: null,
        targets: [],
        riskReward: null,
        positionSize: '',
        risks: [],
        invalidation: '',
        confidenceFactors: [],
        checklist: [],
      };
    }
    return null;
  }

  const r = legacy as Record<string, unknown>;
  const llm = r['llm'] as Record<string, unknown> | undefined;
  const verdict = (llm?.['verdict'] as Record<string, unknown> | undefined) ?? {};
  const scores = (r['scores'] as Record<string, unknown> | undefined) ?? {};
  const breakdown = (scores['breakdown'] as Record<string, unknown> | undefined) ?? {};
  const action = _str(verdict['action']) || '—';
  const conviction = _num(verdict['conviction']);
  const ez = verdict['entry_zone'] as Record<string, unknown> | undefined;
  const targetsRaw = Array.isArray(verdict['targets']) ? (verdict['targets'] as unknown[]) : [];
  const targets = targetsRaw
    .map((t, i) => {
      const o = t && typeof t === 'object' ? (t as Record<string, unknown>) : {};
      return {
        label: _str(o['label']) || `T${i + 1}`,
        price: _num(o['price']),
      };
    })
    .filter((t) => t.price != null);

  return {
    action,
    actionClass: aiActionClassOf(action),
    gate: gate || 'legacy',
    convictionPct:
      conviction == null ? null : conviction <= 1 + 1e-9 ? conviction * 100 : conviction,
    total: _num(scores['total']),
    candidate: _num(scores['candidate_score']),
    aiComponent: _num(breakdown['ai_component']),
    summary: _str(verdict['summary']),
    whyNow: _str(verdict['why_now']),
    headline: _str(verdict['headline']) || _str(verdict['summary']).split('.')[0],
    riskLevel: _str(verdict['risk_level']),
    timeframe: _str(verdict['timeframe']),
    source: _str(llm?.['source']) || 'unknown',
    evaluatedAt: _str(r['evaluated_at_utc']),
    model: '',
    totalTokens: null,
    estimatedCostUsd: null,
    evalCount: 1,
    entry: ez
      ? {
          min: _num(ez['min_price']),
          ideal: _num(ez['ideal_price']),
          max: _num(ez['max_price']),
        }
      : null,
    stop: _num(verdict['stop_loss']),
    target: targets[0]?.price ?? null,
    holdDays: _num(verdict['hold_days']),
    targets,
    riskReward: _num(verdict['risk_reward_ratio']),
    positionSize: _str(verdict['position_size_suggestion']),
    risks: _strList(verdict['risks']),
    invalidation: _str(verdict['invalidation']),
    confidenceFactors: _strList(verdict['confidence_factors']),
    checklist: [],
  };
}

@Component({
  selector: 'app-signals-page',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './signals-page.component.html',
  styleUrl: './signals-page.component.css',
})
export class SignalsPageComponent implements OnInit, OnDestroy {
  /** Unsigned `$` prices for the table (max 3 decimal places). */
  protected readonly fmtUsd = fmtUsd;
  protected readonly fmtUiDecimal = fmtUiDecimal;
  protected readonly fmtUiPercent = fmtUiPercent;
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly authSvc = inject(AuthService);
  private readonly market = inject(MarketDataService);
  private readonly openPos = inject(OpenPositionService);
  private readonly positionsStore = inject(PositionsStoreService);
  readonly signalsBadge = inject(SignalsNewBadgeService);

  private sub: Subscription | null = null;

  readonly allowedUser = toSignal(this.authSvc.allowedUser$, { initialValue: null });
  readonly loadError = signal('');
  readonly loading = signal(true);
  readonly loadingPage = signal(false);
  /** Paginated flattened signal rows from `/api/signals`. */
  readonly instanceRows = signal<SignalInstanceRow[]>([]);
  /** Latest run doc (for new-badge even when paginated). */
  readonly latestRunDoc = signal<{ id: string; data: SignalDoc } | null>(null);
  readonly pageSize = signal<number>(10);
  readonly signalsPages = signal<SignalsPage[]>([]);
  readonly signalsPageIndex = signal(0);
  /** `groupKey` = ticker (uppercase). When present, superseded suggestions for that symbol are visible. */
  readonly expandedSignalGroups = signal<ReadonlySet<string>>(new Set<string>());
  /** Live price display per ticker (e.g. "$12.34" or "err"). */
  readonly liveByTicker = signal<Record<string, string>>({});
  /** Last fetched raw price for comparison (e.g. vs signal close in Log Buy form). */
  readonly livePriceNumByTicker = signal<Record<string, number>>({});
  readonly inlineLiveRefreshing = signal(false);
  readonly inlineKey = signal<string | null>(null);
  readonly inlineExpanded = signal(false);
  readonly inlineStatus = signal('');
  readonly inlineSaving = signal(false);

  /** Per signal row: expanded Finnhub quote + company profile. */
  readonly stockDetailByRow = signal<Record<string, StockDetailEntry>>({});

  /** Per signal row (instanceKey): whether the inline AI summary panel is expanded. */
  readonly aiSummaryOpenByRow = signal<ReadonlySet<string>>(new Set<string>());
  /** Lazy-loaded ai_evals history per instanceKey. */
  readonly aiHistoryByRow = signal<
    Record<string, { status: 'loading' | 'ok' | 'error'; rows?: AiHistoryRow[]; message?: string }>
  >({});
  readonly aiHistoryExpandedId = signal<string | null>(null);

  readonly bracketPct = signal<BracketPct | null>(null);
  private signalMeta: {
    sector: string;
    industry: string;
    estimated_hold_days: number | null;
    signal_confidence: number | null;
    /** Signal row close at time of open (for backend; no longer a form field). */
    signal_close_price: number | null;
  } = {
    sector: '',
    industry: '',
    estimated_hold_days: null,
    signal_confidence: null,
    signal_close_price: null,
  };

  readonly guestMode = computed(
    () => !this.authSvc.devAuthBypass && !this.allowedUser()
  );
  readonly pageSizeOptions = SIGNALS_PAGE_SIZE_OPTIONS;
  readonly pageLabel = computed(() => this.signalsPageIndex() + 1);
  readonly canPrevPage = computed(() => this.signalsPageIndex() > 0);
  readonly canNextPage = computed(() => {
    const pages = this.signalsPages();
    const i = this.signalsPageIndex();
    if (!pages.length) return false;
    if (i + 1 < pages.length) return true;
    return !!pages[i]?.nextCursor;
  });

  readonly displayRows = computed(() => {
    const expanded = this.expandedSignalGroups();
    const out: DisplayRow[] = [];
    const openIk = this.inlineKey();
    const pushSig = (row: SigDisplayRow) => {
      out.push(row);
      const ik = row.instanceKey;
      if (openIk === ik) {
        out.push({ kind: 'form', instanceKey: ik });
      }
    };

    const flat: FlatSigInst[] = [];
    for (const r of this.instanceRows()) {
      const tickerU = String(r.signal['ticker'] || '')
        .trim()
        .toUpperCase();
      if (!tickerU) continue;
      flat.push({
        docId: r.docId,
        asofDate: r.asofDate,
        docTsMs: r.docTsMs,
        index: r.signalIndex,
        s: r.signal,
        tickerU,
        sigSortMs: sortKeyForInstance(r.signal, r.signalIndex),
      });
    }

    const byTicker = new Map<string, FlatSigInst[]>();
    for (const inst of flat) {
      if (!byTicker.has(inst.tickerU)) byTicker.set(inst.tickerU, []);
      byTicker.get(inst.tickerU)!.push(inst);
    }

    const tickersSorted = [...byTicker.keys()].sort((ta, tb) => {
      const aa = [...(byTicker.get(ta) ?? [])].sort(compareInstances)[0];
      const bb = [...(byTicker.get(tb) ?? [])].sort(compareInstances)[0];
      if (!aa || !bb) return 0;
      return compareInstances(aa, bb);
    });

    for (const tickerU of tickersSorted) {
      const grp = [...(byTicker.get(tickerU) ?? [])].sort(compareInstances);
      if (grp.length === 0) continue;
      const [primary, ...rest] = grp;
      const rk = `${primary.docId}\t${primary.tickerU}`;
      const ikP = `${primary.docId}\t${primary.index}`;
      const gk = primary.tickerU;

      pushSig({
        kind: 'sig',
        role: 'primary',
        docId: primary.docId,
        asofDate: primary.asofDate,
        s: primary.s,
        signalIndex: primary.index,
        instanceKey: ikP,
        groupKey: gk,
        rowKey: rk,
        olderCount: rest.length,
      });
      if (!expanded.has(gk)) continue;
      for (const o of rest) {
        const ikO = `${o.docId}\t${o.index}`;
        pushSig({
          kind: 'sig',
          role: 'older',
          docId: o.docId,
          asofDate: o.asofDate,
          s: o.s,
          signalIndex: o.index,
          instanceKey: ikO,
          groupKey: gk,
          rowKey: `${o.docId}\t${o.tickerU}`,
          olderCount: 0,
        });
      }
    }

    return out;
  });

  clearSignalNotifications(): void {
    this.signalsBadge.acknowledgeAllLatestRun();
  }

  olderSignalsExpanded(groupKey: string): boolean {
    return this.expandedSignalGroups().has(groupKey);
  }

  toggleOlderSignals(groupKey: string, ev?: Event): void {
    ev?.stopPropagation?.();
    this.expandedSignalGroups.update((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  readonly inlineForm = this.fb.group({
    entry_price: [null as number | null, Validators.required],
    quantity: [10 as number | null],
    stop_price: [null as number | null],
    target_price: [null as number | null],
    hold_days_from_signal: [null as number | null],
    notes: [''],
  });

  /** Parse `docId\t{index}` when the inline form is open (set by Log Buy). */
  private inlineContext(): { docId: string; ticker: string } | null {
    const k = this.inlineKey();
    if (!k) return null;
    const tab = k.indexOf('\t');
    if (tab < 0) return null;
    const docId = k.slice(0, tab).trim();
    const idx = parseInt(k.slice(tab + 1).trim(), 10);
    if (!Number.isFinite(idx)) return null;
    const row = this.instanceRows().find((r) => r.docId === docId && r.signalIndex === idx);
    const ticker = row
      ? String(row.signal['ticker'] || '')
          .trim()
          .toUpperCase()
      : '';
    if (!docId || !ticker) return null;
    return { docId, ticker };
  }

  /** Docs shape for badge service (latest run + current page). */
  private docsForBadge(): { id: string; data: SignalDoc }[] {
    const latest = this.latestRunDoc();
    if (latest) {
      return normalizeSignalDocs([latest]);
    }
    return this.instanceRowsToDocs(this.instanceRows());
  }

  private instanceRowsToDocs(rows: SignalInstanceRow[]): { id: string; data: SignalDoc }[] {
    const byDoc = new Map<string, { id: string; data: SignalDoc }>();
    for (const r of rows) {
      if (!byDoc.has(r.docId)) {
        byDoc.set(r.docId, {
          id: r.docId,
          data: { asof_date: r.asofDate, ts_utc: r.docTsUtc, signals: [] },
        });
      }
      byDoc.get(r.docId)!.data.signals!.push(r.signal);
    }
    return [...byDoc.values()];
  }

  private signalRow(docId: string, signalIndex: number): SignalInstanceRow | undefined {
    return this.instanceRows().find(
      (r) => r.docId === docId && r.signalIndex === signalIndex,
    );
  }

  /** Ticker for the open Log Buy form (title + live price). */
  inlineTicker(): string {
    return this.inlineContext()?.ticker ?? '';
  }

  ngOnInit(): void {
    this.fetchSignalsPage(undefined);
  }

  /**
   * Fetch live prices for all unique tickers in the loaded signals.
   * Called automatically after signals load to populate the table.
   */
  private fetchAllLivePrices(rows: SignalInstanceRow[]): void {
    const tickers = new Set<string>();
    for (const r of rows) {
      const t = String(r.signal['ticker'] || '')
        .trim()
        .toUpperCase();
      if (t) tickers.add(t);
    }
    for (const sym of tickers) {
      void this.refreshLive(sym);
    }
  }

  private fetchSignalsPage(cursor: string | undefined): void {
    const base = environment.apiBaseUrl;
    const first = cursor === undefined;
    if (first) {
      this.loading.set(true);
    } else {
      this.loadingPage.set(true);
    }
    this.loadError.set('');
    this.sub?.unsubscribe();

    const limit = this.pageSize();
    let params = new HttpParams().set('limit', String(limit));
    if (cursor) params = params.set('cursor', cursor);

    this.sub = of(0)
      .pipe(
        switchMap(() =>
          this.http.get<SignalsListApiResponse>(`${base}/api/signals`, { params }).pipe(
            tap({ next: () => this.loadError.set('') }),
            catchError((err) => {
              this.loading.set(false);
              this.loadingPage.set(false);
              this.loadError.set(formatApiErr(err));
              return of({} as SignalsListApiResponse);
            }),
          ),
        ),
      )
      .subscribe((raw) => {
        const r = normalizeSignalsApiResponse(raw, limit, cursor);
        const page: SignalsPage = {
          rows: r.rows,
          nextCursor: r.nextCursor,
        };
        if (first) {
          this.signalsPages.set([page]);
          this.signalsPageIndex.set(0);
          if (r.latestRun) {
            this.latestRunDoc.set({
              id: r.latestRun.id,
              data: r.latestRun.data,
            });
          }
        } else {
          this.signalsPages.update((prev) => [...prev, page]);
          this.signalsPageIndex.update((i) => i + 1);
        }
        this.applyPageRows(page.rows);
        this.loading.set(false);
        this.loadingPage.set(false);
      });
  }

  /** Replace visible rows when the user changes page. */
  private applyPageRows(rows: SignalInstanceRow[]): void {
    this.instanceRows.set(rows);
    this.expandedSignalGroups.set(new Set<string>());
    this.inlineKey.set(null);
    this.inlineExpanded.set(false);
    this.bracketPct.set(null);
    this.signalsBadge.recompute(this.docsForBadge());
    this.fetchAllLivePrices(rows);
  }

  onPageSizeChange(raw: string): void {
    const n = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n < 1) return;
    if (n === this.pageSize()) return;
    this.pageSize.set(n);
    this.signalsPages.set([]);
    this.signalsPageIndex.set(0);
    this.instanceRows.set([]);
    this.fetchSignalsPage(undefined);
  }

  nextPage(): void {
    const pages = this.signalsPages();
    const i = this.signalsPageIndex();
    if (i + 1 < pages.length) {
      this.signalsPageIndex.set(i + 1);
      this.applyPageRows(pages[i + 1].rows);
      return;
    }
    const cur = pages[i];
    if (!cur?.nextCursor) return;
    this.fetchSignalsPage(cur.nextCursor);
  }

  prevPage(): void {
    const i = this.signalsPageIndex();
    if (i <= 0) return;
    const nextIndex = i - 1;
    this.signalsPageIndex.set(nextIndex);
    this.applyPageRows(this.signalsPages()[nextIndex]?.rows ?? []);
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  confClass(conf: unknown): string {
    if (conf == null) return '';
    const v = Number(conf);
    if (!Number.isFinite(v)) return '';
    if (v >= 70) return 'conf-high';
    if (v >= 50) return 'conf-mid';
    return 'conf-low';
  }

  /** Confidence column: max 2 decimal places (trimmed); shown as `N%`. */
  confFmt(conf: unknown): string {
    if (conf == null) return '—';
    const v = Number(conf);
    return Number.isFinite(v) ? fmtUiPercent(v) : '—';
  }

  /**
   * Research-job outcome badge for a signal row (see `scripts/research_open_signals.py`).
   * Signals are only finalized once their hold window has fully played out; until then
   * (or if the daily research job hasn't reached this signal yet) the status is "Pending".
   */
  signalStatus(s: Record<string, unknown>): {
    label: string;
    cls: string;
    title: string;
    pctStr: string;
    pctCls: string;
    valueStr: string;
    reason: string;
  } {
    const researchStatus = _str(s['researchStatus']).toLowerCase();
    const pnlPct = _num(s['pnlPct']);
    const pnlValue = _num(s['pnlValue']);
    const pctStr = pnlPct == null ? '' : (pnlPct >= 0 ? '+' : '') + fmtUiPercent(pnlPct) + '%';
    const pctCls =
      pnlPct == null ? '' : pnlPct > 0.01 ? 'live-pct-up' : pnlPct < -0.01 ? 'live-pct-down' : 'live-pct-flat';
    const valueStr = pnlValue == null ? '' : fmtSignedUsd(pnlValue);

    if (researchStatus !== 'finalized') {
      return {
        label: 'Pending',
        cls: 'status-pending',
        title: 'Still within its holding window — outcome not finalized yet.',
        pctStr: '',
        pctCls: '',
        valueStr: '',
        reason: '',
      };
    }

    const isProfitableRaw = s['isProfitable'];
    let label: string;
    let cls: string;
    if (isProfitableRaw === true) {
      label = 'Profit';
      cls = 'status-profit';
    } else if (isProfitableRaw === false) {
      if (pnlPct != null && Math.abs(pnlPct) < 1e-9) {
        label = 'Flat';
        cls = 'status-flat';
      } else {
        label = 'Loss';
        cls = 'status-loss';
      }
    } else {
      return {
        label: 'No data',
        cls: 'status-pending',
        title: 'Research job could not price this signal through its hold deadline.',
        pctStr: '',
        pctCls: '',
        valueStr: '',
        reason: _str(s['reason']),
      };
    }

    const outcome = _str(s['outcome']);
    const reason = _str(s['reason']);
    const exitDate = _str(s['exitDate']);
    const titleParts = [
      outcome ? `Outcome: ${outcome}` : '',
      exitDate ? `Exit date: ${exitDate}` : '',
      pnlValue != null ? `P&L: ${fmtUsd(pnlValue)}` : '',
    ].filter((p) => p.length > 0);

    return { label, cls, title: titleParts.join(' · ') || label, pctStr, pctCls, valueStr, reason };
  }

  /** Per signal row (instanceKey): whether the "why" reason panel below the row is expanded. */
  readonly reasonOpenByRow = signal<ReadonlySet<string>>(new Set<string>());

  reasonOpen(instanceKey: string): boolean {
    return this.reasonOpenByRow().has(instanceKey);
  }

  toggleReason(instanceKey: string, ev?: Event): void {
    ev?.stopPropagation?.();
    this.reasonOpenByRow.update((prev) => {
      const next = new Set(prev);
      if (next.has(instanceKey)) next.delete(instanceKey);
      else next.add(instanceKey);
      return next;
    });
  }

  isSignalRowNew(row: DisplayRow): boolean {
    if (row.kind !== 'sig' || row.role !== 'primary') return false;
    const tickerU = String(row.s['ticker'] || '')
      .trim()
      .toUpperCase();
    return this.signalsBadge.isTickerUnreadOnLatestRun(tickerU, this.docsForBadge());
  }

  toggleStockDetails(rowKey: string, ticker: string): void {
    const cur = this.stockDetailByRow()[rowKey];
    if (cur?.expanded) {
      this.stockDetailByRow.update((m) => ({ ...m, [rowKey]: { expanded: false } }));
      return;
    }
    const sym = String(ticker || '')
      .trim()
      .toUpperCase();
    this.stockDetailByRow.update((m) => ({
      ...m,
      [rowKey]: { expanded: true, status: 'loading' },
    }));
    this.market
      .fetchStockSnapshot(sym)
      .then((data) =>
        this.stockDetailByRow.update((m) => ({
          ...m,
          [rowKey]: { expanded: true, status: 'ok', data },
        }))
      )
      .catch((e) =>
        this.stockDetailByRow.update((m) => ({
          ...m,
          [rowKey]: {
            expanded: true,
            status: 'error',
            message: e instanceof Error ? e.message : String(e),
          },
        }))
      );
  }

  stockDetailsOpen(rowKey: string): boolean {
    const e = this.stockDetailByRow()[rowKey];
    return !!e?.expanded;
  }

  stockDetailsLoading(rowKey: string): boolean {
    const e = this.stockDetailByRow()[rowKey];
    return !!e?.expanded && e.status === 'loading';
  }

  stockDetailsError(rowKey: string): string | null {
    const e = this.stockDetailByRow()[rowKey];
    return e?.expanded && e.status === 'error' ? e.message : null;
  }

  stockDetailsData(rowKey: string): StockSnapshot | null {
    const e = this.stockDetailByRow()[rowKey];
    return e?.expanded && e.status === 'ok' ? e.data : null;
  }

  fmtMarketCapMillions(millions: number | null, currency: string | null): string {
    if (millions == null || !Number.isFinite(millions)) return '—';
    const cur = (currency || '').trim();
    const suffix = cur ? ' ' + cur : '';
    if (Math.abs(millions) >= 1000) {
      return fmtUiDecimal(millions / 1000) + 'B' + suffix;
    }
    return fmtUiDecimal(millions) + 'M' + suffix;
  }

  fmtShares(n: number | null): string {
    if (n == null || !Number.isFinite(n)) return '—';
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
  }

  fmtUnixQuoteUtc(sec: number | null): string {
    if (sec == null || !Number.isFinite(sec)) return '—';
    return new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }

  liveDisplay(ticker: string): string {
    const k = ticker.trim().toUpperCase();
    return this.liveByTicker()[k] ?? '—';
  }

  /**
   * Calculate percentage change from signal price to live price.
   * Returns null if either value is unavailable.
   */
  livePctChange(ticker: string, signalPrice: unknown): number | null {
    const sym = String(ticker || '').trim().toUpperCase();
    const liveN = this.livePriceNumByTicker()[sym];
    if (liveN == null || !Number.isFinite(liveN)) return null;
    const sigN = Number(signalPrice);
    if (!Number.isFinite(sigN) || sigN === 0) return null;
    return ((liveN - sigN) / sigN) * 100;
  }

  /**
   * Formatted percentage change string (e.g., "+3.45%" or "-1.23%").
   */
  livePctChangeDisplay(ticker: string, signalPrice: unknown): string {
    const pct = this.livePctChange(ticker, signalPrice);
    if (pct == null) return '';
    const sign = pct >= 0 ? '+' : '';
    return sign + fmtUiPercent(pct) + '%';
  }

  /**
   * CSS class for live price percentage: green for positive, red for negative.
   */
  livePctChangeClass(ticker: string, signalPrice: unknown): string {
    const pct = this.livePctChange(ticker, signalPrice);
    if (pct == null) return '';
    if (pct > 0.01) return 'live-pct-up';
    if (pct < -0.01) return 'live-pct-down';
    return 'live-pct-flat';
  }

  /**
   * Classes for Log Buy "Live" vs signal row close (recorded signal price).
   * Reuses global spot-up / spot-down colors.
   */
  inlineLiveVsSignalClass(): string {
    const sym = this.inlineTicker();
    if (!sym) return '';
    const disp = this.liveByTicker()[sym];
    if (disp == null || disp === '' || disp === 'err') return 'signals-inline-live-muted';
    const sig = this.signalMeta.signal_close_price;
    if (sig == null || !Number.isFinite(sig)) return '';
    const liveN = this.livePriceNumByTicker()[sym];
    if (liveN == null || !Number.isFinite(liveN)) return '';
    const eps = 1e-6;
    if (liveN > sig + eps) return 'spot-val spot-up';
    if (liveN < sig - eps) return 'spot-val spot-down';
    return 'spot-val';
  }

  async refreshInlineLive(ev?: Event): Promise<void> {
    ev?.preventDefault();
    ev?.stopPropagation();
    const t = this.inlineTicker();
    if (!t) return;
    this.inlineLiveRefreshing.set(true);
    try {
      await this.refreshLive(t, ev);
    } finally {
      this.inlineLiveRefreshing.set(false);
    }
  }

  async refreshLive(ticker: string, ev?: Event): Promise<void> {
    ev?.stopPropagation();
    const sym = String(ticker || '').trim().toUpperCase();
    if (!sym) return;
    try {
      const p = await this.market.fetchLivePrice(sym);
      this.liveByTicker.update((m) => ({ ...m, [sym]: fmtUsd(p) }));
      this.livePriceNumByTicker.update((m) => ({ ...m, [sym]: p }));
    } catch (e) {
      if (!isProviderQuotaError(e)) {
        console.debug('live price', sym, e);
      }
      this.liveByTicker.update((m) => ({ ...m, [sym]: 'err' }));
      this.livePriceNumByTicker.update((m) => {
        const next = { ...m };
        delete next[sym];
        return next;
      });
    }
  }

  toggleInline(docId: string, signalIndex: number): void {
    const row = this.signalRow(docId, signalIndex);
    const s = row?.signal;
    if (!s) return;
    const ticker = String(s['ticker'] || '')
      .trim()
      .toUpperCase();
    const key = docId + '\t' + signalIndex;
    const rowKey = docId + '\t' + ticker;
    if (this.inlineKey() === key && this.inlineExpanded()) {
      this.inlineKey.set(null);
      this.inlineExpanded.set(false);
      this.bracketPct.set(null);
      return;
    }
    this.signalsBadge.acknowledgeLogBuy(rowKey);
    this.inlineKey.set(key);
    this.inlineExpanded.set(false);
    this.fillFromSignal(docId, s);
    this.inlineStatus.set(
      'Prefilled from bot signal — edit fields if your fill or bracket differed.'
    );
    queueMicrotask(() => this.inlineExpanded.set(true));
    void this.refreshLive(ticker);
  }

  closeInline(): void {
    this.inlineExpanded.set(false);
    queueMicrotask(() => {
      this.inlineKey.set(null);
      this.bracketPct.set(null);
    });
  }

  private fillFromSignal(_signalDocId: string, s: Record<string, unknown>): void {
    const setNum = (name: keyof typeof this.inlineForm.controls, v: unknown) => {
      const c = this.inlineForm.get(name as string);
      if (!c) return;
      if (v == null || v === '') c.setValue(name === 'notes' ? '' : null);
      else if (name === 'notes') {
        c.setValue(String(v));
      } else {
        const num = Number(v);
        c.setValue(Number.isFinite(num) ? roundUi(num) : null);
      }
    };

    this.inlineForm.patchValue({
      notes: '',
      quantity: 10,
    });
    setNum('entry_price', s['close']);
    setNum('stop_price', s['stop']);
    setNum('target_price', s['target']);
    const hd = s['hold_days'];
    this.inlineForm.patchValue({
      hold_days_from_signal: hd != null && hd !== '' ? Number(hd) : null,
    });
    const closeNum = s['close'] != null ? Number(s['close']) : NaN;
    const confRaw = s['confidence'];
    const confNum = confRaw != null && confRaw !== '' ? Number(confRaw) : NaN;
    this.signalMeta = {
      sector: String(s['sector'] || ''),
      industry: String(s['industry'] || ''),
      estimated_hold_days:
        s['estimated_hold_days'] != null ? Number(s['estimated_hold_days']) : null,
      signal_confidence: Number.isFinite(confNum) ? confNum : null,
      signal_close_price: Number.isFinite(closeNum) ? closeNum : null,
    };
    this.bracketPct.set(extractBracketPctsFromSignal(s));
  }

  bracketSyncDisabled(): boolean {
    const bp = this.bracketPct();
    return !bp || !Number.isFinite(bp.stopPct) || !Number.isFinite(bp.targetPct);
  }

  bracketHint(): string {
    const bp = this.bracketPct();
    if (!bp || !Number.isFinite(bp.stopPct) || !Number.isFinite(bp.targetPct)) return '';
    return (
      'Signal: SL ' +
      (bp.stopPct >= 0 ? '+' : '') +
      fmtUiPercent(bp.stopPct) +
      '% · TP ' +
      (bp.targetPct >= 0 ? '+' : '') +
      fmtUiPercent(bp.targetPct) +
      '% vs entry (same as Slack).'
    );
  }

  syncBracket(): void {
    const bp = this.bracketPct();
    if (!bp || !Number.isFinite(bp.stopPct) || !Number.isFinite(bp.targetPct)) {
      this.inlineStatus.set(
        'No signal bracket % on this form. Open it with Log Buy from the signals table.'
      );
      return;
    }
    const entry = Number(this.inlineForm.get('entry_price')?.value);
    if (!Number.isFinite(entry) || entry <= 0) {
      this.inlineStatus.set('Enter a valid entry price first.');
      return;
    }
    const stop = entry * (1 + bp.stopPct / 100);
    const target = entry * (1 + bp.targetPct / 100);
    this.inlineForm.patchValue({
      stop_price: parseFloat(fmtMoneyInput(stop)),
      target_price: parseFloat(fmtMoneyInput(target)),
    });
    this.inlineStatus.set('');
  }

  async submitInline(): Promise<void> {
    this.inlineStatus.set('');
    if (this.inlineForm.invalid || this.guestMode()) return;
    if (!this.allowedUser()) {
      this.inlineStatus.set('Sign in with Google first.');
      return;
    }
    const ctx = this.inlineContext();
    if (!ctx?.ticker) {
      this.inlineStatus.set('Form context missing; reopen Log Buy.');
      return;
    }
    this.inlineSaving.set(true);
    try {
      const raw = this.inlineForm.getRawValue();
      const ticker = ctx.ticker;
      const entry = Number(raw.entry_price);
      if (!Number.isFinite(entry)) {
        this.inlineStatus.set('Entry price required.');
        return;
      }
      const qtyRaw = raw.quantity;
      let quantity = 10;
      if (
        qtyRaw !== null &&
        qtyRaw !== undefined &&
        String(qtyRaw).trim() !== '' &&
        Number.isFinite(Number(qtyRaw))
      ) {
        quantity = Number(qtyRaw);
      }
      const stop_price =
        raw.stop_price === null || raw.stop_price === undefined ? null : Number(raw.stop_price);
      const target_price =
        raw.target_price === null || raw.target_price === undefined ? null : Number(raw.target_price);
      const signal_doc_id = ctx.docId || null;
      const holdRaw = raw.hold_days_from_signal;
      const hold_days_from_signal =
        holdRaw === null || holdRaw === undefined ? null : parseInt(String(holdRaw), 10);
      const sci = this.signalMeta.signal_close_price;
      const signal_close_price = sci != null && Number.isFinite(sci) ? sci : null;
      const bought_at = new Date().toISOString();
      const notes = String(raw.notes || '').trim() || null;

      await this.openPos.save({
        ticker,
        entry_price: entry,
        quantity,
        stop_price: stop_price != null && Number.isFinite(stop_price) ? stop_price : null,
        target_price: target_price != null && Number.isFinite(target_price) ? target_price : null,
        signal_doc_id,
        signal_confidence: this.signalMeta.signal_confidence,
        hold_days_from_signal:
          hold_days_from_signal != null && Number.isFinite(hold_days_from_signal)
            ? hold_days_from_signal
            : null,
        signal_close_price,
        bought_at,
        sector: this.signalMeta.sector || null,
        industry: this.signalMeta.industry || null,
        estimated_hold_days: this.signalMeta.estimated_hold_days,
        notes,
      });
      this.positionsStore.refetch();
      this.inlineStatus.set('Saved to my_positions.');
      this.inlineForm.reset({
        entry_price: null,
        quantity: 10,
        stop_price: null,
        target_price: null,
        hold_days_from_signal: null,
        notes: '',
      });
      this.bracketPct.set(null);
      this.closeInline();
    } catch (e) {
      this.inlineStatus.set(
        'Error: ' + (e instanceof Error ? e.message : String(e))
      );
    } finally {
      this.inlineSaving.set(false);
    }
  }

  /** True when this signal row has AI data or is pending evaluation. */
  hasAiEval(row: SigDisplayRow): boolean {
    const gate = String(row.s['ai_gate'] || '').toLowerCase();
    if (gate === 'pending' || gate === 'passed' || gate === 'filtered' || gate === 'skipped') return true;
    const ai = row.s['ai'];
    if (ai && typeof ai === 'object' && (ai as Record<string, unknown>)['has_eval']) return true;
    const rec = row.s['recommendation'];
    if (rec && typeof rec === 'object') return true;
    const v = row.s['ai_evaluation'];
    return !!(v && typeof v === 'object');
  }

  aiSummaryOpen(instanceKey: string): boolean {
    return this.aiSummaryOpenByRow().has(instanceKey);
  }

  toggleAiSummary(instanceKey: string, ev?: Event, row?: SigDisplayRow): void {
    ev?.stopPropagation?.();
    const opening = !this.aiSummaryOpenByRow().has(instanceKey);
    this.aiSummaryOpenByRow.update((prev) => {
      const next = new Set(prev);
      if (next.has(instanceKey)) next.delete(instanceKey);
      else next.add(instanceKey);
      return next;
    });
    if (opening && row) {
      void this.loadAiHistory(row);
    }
  }

  aiSummaryToggleLabel(row: SigDisplayRow): string {
    if (this.aiSummaryOpen(row.instanceKey)) return 'Hide';
    return this.hasAiEval(row) ? 'History' : '—';
  }

  /** Compact action chip text shown next to the toggle. */
  aiActionChip(row: SigDisplayRow): { label: string; cls: string } | null {
    const gate = String(row.s['ai_gate'] || '').toLowerCase();
    const view = this.aiViewForRow(row);
    if (gate === 'pending') {
      return { label: 'Pending', cls: aiActionClassOf('PENDING') };
    }
    if (gate === 'passed' && view) {
      return { label: `${view.action} ✓`, cls: view.actionClass };
    }
  if (gate === 'filtered' && view) {
    return { label: `${view.action} ✕`, cls: view.actionClass };
  }
  if (gate === 'skipped') {
    return { label: 'Skipped', cls: aiActionClassOf('FILTERED') };
  }
    if (!view) return null;
    return { label: view.action, cls: view.actionClass };
  }

  aiTokensTeaser(row: SigDisplayRow): string {
    const ai = row.s['ai'] as Record<string, unknown> | undefined;
    if (!ai || typeof ai !== 'object') return '';
    const tokens = _num(ai['total_tokens']);
    const model = _str(ai['model']);
    const cost = _num(ai['estimated_cost_usd']);
    const parts: string[] = [];
    if (model) parts.push(model);
    if (tokens != null) parts.push(`${tokens} tok`);
    if (cost != null) parts.push(`$${cost.toFixed(4)}`);
    return parts.join(' · ');
  }

  holdingAdviceForRow(
    row: SigDisplayRow
  ): { advice: string; headline: string; why: string; riskLevel: string } | null {
    const raw = row.s['holding_advice'];
    if (!raw || typeof raw !== 'object') return null;
    const h = raw as Record<string, unknown>;
    const advice = _str(h['advice']).toUpperCase();
    if (!advice) return null;
    return {
      advice,
      headline: _str(h['headline']),
      why: _str(h['why']),
      riskLevel: _str(h['risk_level']),
    };
  }

  holdingAdviceChip(row: SigDisplayRow): { label: string; cls: string } | null {
    const hold = this.holdingAdviceForRow(row);
    if (!hold) {
      const paper = _str(row.s['paper_status']).toLowerCase();
      if (paper === 'open') return { label: 'Paper open', cls: aiActionClassOf('PENDING') };
      return null;
    }
    return { label: hold.advice, cls: aiActionClassOf(hold.advice) };
  }

  aiViewForRow(row: SigDisplayRow): AiEvaluationView | null {
    return buildAiEvaluationView(row.s as Record<string, unknown>);
  }

  /** Expose action CSS class helper to the template. */
  aiActionClassOfPublic(action: string): string {
    return aiActionClassOf(action);
  }

  aiHistoryState(instanceKey: string) {
    return this.aiHistoryByRow()[instanceKey] ?? null;
  }

  async loadAiHistory(row: SigDisplayRow): Promise<void> {
    const key = row.instanceKey;
    const existing = this.aiHistoryByRow()[key];
    if (existing?.status === 'ok' || existing?.status === 'loading') return;
    this.aiHistoryByRow.update((m) => ({ ...m, [key]: { status: 'loading' } }));
    try {
      const base = environment.apiBaseUrl || '';
      const q = new URLSearchParams({
        signalDocId: row.docId,
        ticker: String(row.s['ticker'] || ''),
        limit: '40',
      });
      const res = await firstValueFrom(
        this.http.get<{ rows: { id: string; data: Record<string, unknown> }[] }>(
          `${base}/api/signals/ai-evals?${q.toString()}`,
          { withCredentials: true }
        )
      );
      const rows: AiHistoryRow[] = (res.rows || []).map((r) => {
        const d = r.data || {};
        const rec =
          d['recommendation'] && typeof d['recommendation'] === 'object'
            ? (d['recommendation'] as Record<string, unknown>)
            : null;
        return {
          id: r.id,
          tsUtc: _str(d['ts_utc']),
          stage: _str(d['stage']),
          decision: _str(d['decision']),
          model: _str(d['model']),
          promptTokens: _num(d['prompt_tokens']),
          completionTokens: _num(d['completion_tokens']),
          totalTokens: _num(d['total_tokens']),
          estimatedCostUsd: _num(d['estimated_cost_usd']),
          headline: _str(rec?.['headline']),
          recommendation: rec,
        };
      });
      this.aiHistoryByRow.update((m) => ({ ...m, [key]: { status: 'ok', rows } }));
    } catch (e) {
      this.aiHistoryByRow.update((m) => ({
        ...m,
        [key]: {
          status: 'error',
          message: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  }

  toggleHistoryDetail(evalId: string): void {
    this.aiHistoryExpandedId.update((cur) => (cur === evalId ? null : evalId));
  }

  fmtAiPct(n: number | null): string {
    if (n == null || !Number.isFinite(n)) return '—';
    return fmtUiPercent(n) + '%';
  }

  fmtAiNumber(n: number | null, digits = 2): string {
    if (n == null || !Number.isFinite(n)) return '—';
    return n.toFixed(digits);
  }

  fmtAiTimestamp(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }

  /** Angular templates cannot call global `String`. */
  str(x: unknown): string {
    return String(x ?? '');
  }
}
