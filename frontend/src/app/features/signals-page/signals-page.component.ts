import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { Subscription, switchMap, catchError, of, tap } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { MarketDataService } from '../../core/market-data.service';
import { GithubWorkflowsService } from '../../core/github-workflows.service';
import { OpenPositionService } from '../../core/open-position.service';
import { PositionsStoreService } from '../../core/positions-store.service';
import { SignalsNewBadgeService } from '../../core/signals-new-badge.service';
import {
  BracketPct,
  extractBracketPctsFromSignal,
  fmtMoneyInput,
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
import { normalizeSignalDocs, type SignalDoc } from '../../core/signal-docs-normalize';

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

function docTimestampMs(data: SignalDoc): number {
  const raw = data.ts_utc;
  if (typeof raw === 'string' && raw.trim()) {
    const t = Date.parse(raw.trim());
    if (Number.isFinite(t)) return t;
  }
  const ad = String(data.asof_date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(ad)) {
    const t = Date.parse(ad + 'T12:00:00.000Z');
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function compareInstances(a: FlatSigInst, b: FlatSigInst): number {
  if (b.docTsMs !== a.docTsMs) return b.docTsMs - a.docTsMs;
  const d = b.sigSortMs - a.sigSortMs;
  if (d !== 0) return d;
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
  private readonly github = inject(GithubWorkflowsService);
  private readonly openPos = inject(OpenPositionService);
  private readonly positionsStore = inject(PositionsStoreService);
  readonly signalsBadge = inject(SignalsNewBadgeService);

  private sub: Subscription | null = null;

  readonly allowedUser = toSignal(this.authSvc.allowedUser$, { initialValue: null });
  readonly loadError = signal('');
  readonly loading = signal(true);
  readonly docs = signal<{ id: string; data: SignalDoc }[]>([]);
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
  /** Per-ticker re-eval UI: loading shows …, then Triggered briefly. */
  readonly reevalState = signal<{ key: string; phase: 'loading' | 'triggered' } | null>(null);
  /** Per signal row (rowKey): AI eval workflow dispatch. */
  readonly aiEvalState = signal<{ key: string; phase: 'loading' | 'triggered' } | null>(null);

  /** Per signal row: expanded Finnhub quote + company profile. */
  readonly stockDetailByRow = signal<Record<string, StockDetailEntry>>({});

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
    for (const doc of this.docs()) {
      const arr = Array.isArray(doc.data.signals) ? doc.data.signals : [];
      const asof = String(doc.data.asof_date || '');
      const docTsMs = docTimestampMs(doc.data);
      for (let index = 0; index < arr.length; index++) {
        const s = arr[index] as Record<string, unknown>;
        const tickerU = String(s['ticker'] || '')
          .trim()
          .toUpperCase();
        if (!tickerU) continue;
        flat.push({
          docId: doc.id,
          asofDate: asof,
          docTsMs,
          index,
          s,
          tickerU,
          sigSortMs: sortKeyForInstance(s, index),
        });
      }
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
    const doc = this.docs().find((d) => d.id === docId);
    const arr = Array.isArray(doc?.data.signals) ? doc!.data.signals : [];
    const s = arr[idx];
    const ticker =
      s && typeof s === 'object' && s !== null
        ? String((s as Record<string, unknown>)['ticker'] || '')
            .trim()
            .toUpperCase()
        : '';
    if (!docId || !ticker) return null;
    return { docId, ticker };
  }

  /** Ticker for the open Log Buy form (title + live price). */
  inlineTicker(): string {
    return this.inlineContext()?.ticker ?? '';
  }

  ngOnInit(): void {
    const base = environment.apiBaseUrl;
    this.sub = of(0)
      .pipe(
        switchMap(() =>
          this.http
            .get<{ docs: { id: string; data: SignalDoc }[] }>(`${base}/api/signals`)
            .pipe(
              tap({ next: () => this.loadError.set('') }),
              catchError((err) => {
                this.loading.set(false);
                this.loadError.set(formatApiErr(err));
                return of({ docs: [] as { id: string; data: SignalDoc }[] });
              })
            )
        )
      )
      .subscribe((r) => {
        this.loading.set(false);
        const normalized = normalizeSignalDocs(r.docs ?? []);
        this.docs.set(normalized);
        this.signalsBadge.recompute(normalized);
        this.inlineKey.set(null);
        this.inlineExpanded.set(false);
        this.bracketPct.set(null);
      });
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

  isSignalRowNew(row: DisplayRow): boolean {
    if (row.kind !== 'sig' || row.role !== 'primary') return false;
    const tickerU = String(row.s['ticker'] || '')
      .trim()
      .toUpperCase();
    return this.signalsBadge.isTickerUnreadOnLatestRun(tickerU, this.docs());
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
    const doc = this.docs().find((d) => d.id === docId);
    const arr = Array.isArray(doc?.data.signals) ? doc!.data.signals : [];
    const s = arr[signalIndex] as Record<string, unknown> | undefined;
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

  async reeval(ticker: string): Promise<void> {
    const sym = String(ticker || '').trim();
    if (!sym) return;
    const key = sym.toUpperCase();
    this.reevalState.set({ key, phase: 'loading' });
    try {
      await this.github.triggerBotScanWorkflow(sym);
      this.reevalState.set({ key, phase: 'triggered' });
    } catch (e) {
      console.error(e);
      this.reevalState.set({ key, phase: 'triggered' });
    }
    setTimeout(() => {
      if (this.reevalState()?.key === key) this.reevalState.set(null);
    }, 3000);
  }

  reevalLabel(ticker: string): string {
    const k = String(ticker || '')
      .trim()
      .toUpperCase();
    const st = this.reevalState();
    if (st?.key === k && st.phase === 'loading') return '…';
    if (st?.key === k && st.phase === 'triggered') return 'Triggered';
    return 'Re-eval';
  }

  reevalDisabled(ticker: string): boolean {
    const k = String(ticker || '')
      .trim()
      .toUpperCase();
    const st = this.reevalState();
    return st?.key === k && st.phase === 'loading';
  }

  async aiEval(rowKey: string, ticker: string, signalDocId: string): Promise<void> {
    if (this.guestMode()) return;
    const sym = String(ticker || '').trim();
    const doc = String(signalDocId || '').trim();
    if (!sym || !doc) return;
    this.aiEvalState.set({ key: rowKey, phase: 'loading' });
    try {
      await this.github.triggerAiStockEvalWorkflow(sym, doc);
      this.aiEvalState.set({ key: rowKey, phase: 'triggered' });
    } catch (e) {
      console.error(e);
      this.aiEvalState.set({ key: rowKey, phase: 'triggered' });
    }
    setTimeout(() => {
      if (this.aiEvalState()?.key === rowKey) this.aiEvalState.set(null);
    }, 3000);
  }

  aiEvalLabel(rowKey: string): string {
    const st = this.aiEvalState();
    if (st?.key === rowKey && st.phase === 'loading') return '…';
    if (st?.key === rowKey && st.phase === 'triggered') return 'Triggered';
    return 'AI eval';
  }

  aiEvalDisabled(rowKey: string): boolean {
    const st = this.aiEvalState();
    return this.guestMode() || (st?.key === rowKey && st.phase === 'loading');
  }

  /** Angular templates cannot call global `String`. */
  str(x: unknown): string {
    return String(x ?? '');
  }
}
