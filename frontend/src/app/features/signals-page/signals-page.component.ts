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
  roundUi,
} from '../../core/positions-logic';
import { formatApiErr } from '../../core/api-errors';
import {
  isProviderQuotaError,
  type StockSnapshot,
} from '../../core/market-data.service';
import { environment } from '../../../environments/environment';
import { normalizeSignalDocs, type SignalDoc } from '../../core/signal-docs-normalize';

type DisplayRow =
  | { kind: 'sig'; docId: string; asofDate: string; s: Record<string, unknown>; rowKey: string }
  | { kind: 'form'; rowKey: string };

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
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly authSvc = inject(AuthService);
  private readonly market = inject(MarketDataService);
  private readonly github = inject(GithubWorkflowsService);
  private readonly openPos = inject(OpenPositionService);
  private readonly positionsStore = inject(PositionsStoreService);
  private readonly signalsNew = inject(SignalsNewBadgeService);

  private sub: Subscription | null = null;

  readonly allowedUser = toSignal(this.authSvc.allowedUser$, { initialValue: null });
  readonly loadError = signal('');
  readonly loading = signal(true);
  readonly docs = signal<{ id: string; data: SignalDoc }[]>([]);
  /** Live price display per ticker (e.g. "$12.34" or "err"). */
  readonly liveByTicker = signal<Record<string, string>>({});
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
  } = {
    sector: '',
    industry: '',
    estimated_hold_days: null,
    signal_confidence: null,
  };

  readonly guestMode = computed(
    () => !this.authSvc.devAuthBypass && !this.allowedUser()
  );

  readonly displayRows = computed(() => {
    const out: DisplayRow[] = [];
    const openKey = this.inlineKey();
    for (const doc of this.docs()) {
      const arr = Array.isArray(doc.data.signals) ? doc.data.signals : [];
      const asof = String(doc.data.asof_date || '');
      for (const s of arr) {
        const ticker = String(s['ticker'] || '')
          .trim()
          .toUpperCase();
        const rowKey = doc.id + '\t' + ticker;
        out.push({ kind: 'sig', docId: doc.id, asofDate: asof, s, rowKey });
        if (openKey === rowKey) {
          out.push({ kind: 'form', rowKey });
        }
      }
    }
    return out;
  });

  readonly inlineForm = this.fb.group({
    ticker: ['', [Validators.required, Validators.maxLength(8)]],
    entry_price: [null as number | null, Validators.required],
    quantity: [10 as number | null],
    stop_price: [null as number | null],
    target_price: [null as number | null],
    signal_doc_id: [''],
    hold_days_from_signal: [null as number | null],
    signal_close_price: [null as number | null],
    bought_at: [''],
    notes: [''],
  });

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
        this.signalsNew.recompute(normalized);
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

  /** Confidence column: max 3 decimal places (trimmed). */
  confFmt(conf: unknown): string {
    if (conf == null) return '—';
    const v = Number(conf);
    return Number.isFinite(v) ? fmtUiDecimal(v) : '—';
  }

  isSignalRowNew(row: DisplayRow): boolean {
    if (row.kind !== 'sig') return false;
    return this.signalsNew.isRowNew(row.rowKey, row.asofDate, this.docs());
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

  async refreshLive(ticker: string, ev?: Event): Promise<void> {
    ev?.stopPropagation();
    const sym = String(ticker || '').trim().toUpperCase();
    if (!sym) return;
    try {
      const p = await this.market.fetchLivePrice(sym);
      this.liveByTicker.update((m) => ({ ...m, [sym]: fmtUsd(p) }));
    } catch (e) {
      if (!isProviderQuotaError(e)) {
        console.debug('live price', sym, e);
      }
      this.liveByTicker.update((m) => ({ ...m, [sym]: 'err' }));
    }
  }

  toggleInline(docId: string, s: Record<string, unknown>): void {
    const ticker = String(s['ticker'] || '')
      .trim()
      .toUpperCase();
    const key = docId + '\t' + ticker;
    if (this.inlineKey() === key && this.inlineExpanded()) {
      this.inlineKey.set(null);
      this.inlineExpanded.set(false);
      this.bracketPct.set(null);
      return;
    }
    this.signalsNew.acknowledgeLogBuy(key);
    this.inlineKey.set(key);
    this.inlineExpanded.set(false);
    this.fillFromSignal(docId, s);
    this.inlineStatus.set(
      'Prefilled from bot signal — edit fields if your fill or bracket differed.'
    );
    queueMicrotask(() => this.inlineExpanded.set(true));
  }

  closeInline(): void {
    this.inlineExpanded.set(false);
    queueMicrotask(() => {
      this.inlineKey.set(null);
      this.bracketPct.set(null);
    });
  }

  private fillFromSignal(signalDocId: string, s: Record<string, unknown>): void {
    const setNum = (name: keyof typeof this.inlineForm.controls, v: unknown) => {
      const c = this.inlineForm.get(name as string);
      if (!c) return;
      if (v == null || v === '') c.setValue(name === 'notes' || name === 'signal_doc_id' ? '' : null);
      else if (name === 'ticker' || name === 'signal_doc_id' || name === 'bought_at' || name === 'notes') {
        c.setValue(String(v));
      } else {
        const num = Number(v);
        c.setValue(Number.isFinite(num) ? roundUi(num) : null);
      }
    };

    this.inlineForm.patchValue({
      ticker: String(s['ticker'] || '')
        .trim()
        .toUpperCase(),
      signal_doc_id: signalDocId,
      notes: '',
      bought_at: '',
    });
    setNum('entry_price', s['close']);
    setNum('stop_price', s['stop']);
    setNum('target_price', s['target']);
    const hd = s['hold_days'];
    this.inlineForm.patchValue({
      hold_days_from_signal:
        hd != null && hd !== '' ? Number(hd) : null,
      signal_close_price: s['close'] != null ? Number(s['close']) : null,
    });
    const confRaw = s['confidence'];
    const confNum = confRaw != null && confRaw !== '' ? Number(confRaw) : NaN;
    this.signalMeta = {
      sector: String(s['sector'] || ''),
      industry: String(s['industry'] || ''),
      estimated_hold_days:
        s['estimated_hold_days'] != null ? Number(s['estimated_hold_days']) : null,
      signal_confidence: Number.isFinite(confNum) ? confNum : null,
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
      fmtUiDecimal(bp.stopPct) +
      '% · TP ' +
      (bp.targetPct >= 0 ? '+' : '') +
      fmtUiDecimal(bp.targetPct) +
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
    this.inlineSaving.set(true);
    try {
      const raw = this.inlineForm.getRawValue();
      const ticker = String(raw.ticker || '')
        .trim()
        .toUpperCase();
      const entry = Number(raw.entry_price);
      if (!ticker || !Number.isFinite(entry)) {
        this.inlineStatus.set('Ticker and entry price required.');
        return;
      }
      const qtyRaw = raw.quantity;
      const quantity =
        qtyRaw == null || !Number.isFinite(Number(qtyRaw)) ? null : Number(qtyRaw);
      const stop_price =
        raw.stop_price === null || raw.stop_price === undefined ? null : Number(raw.stop_price);
      const target_price =
        raw.target_price === null || raw.target_price === undefined ? null : Number(raw.target_price);
      const signal_doc_id = String(raw.signal_doc_id || '').trim() || null;
      const holdRaw = raw.hold_days_from_signal;
      const hold_days_from_signal =
        holdRaw === null || holdRaw === undefined ? null : parseInt(String(holdRaw), 10);
      const sigClose = raw.signal_close_price;
      const signal_close_price =
        sigClose === null || sigClose === undefined ? null : Number(sigClose);
      const bought_at = raw.bought_at
        ? new Date(String(raw.bought_at)).toISOString()
        : null;
      const notes = String(raw.notes || '').trim() || null;

      await this.openPos.save({
        ticker,
        entry_price: entry,
        quantity: quantity != null && Number.isFinite(quantity) ? quantity : null,
        stop_price: stop_price != null && Number.isFinite(stop_price) ? stop_price : null,
        target_price: target_price != null && Number.isFinite(target_price) ? target_price : null,
        signal_doc_id,
        signal_confidence: this.signalMeta.signal_confidence,
        hold_days_from_signal:
          hold_days_from_signal != null && Number.isFinite(hold_days_from_signal)
            ? hold_days_from_signal
            : null,
        signal_close_price:
          signal_close_price != null && Number.isFinite(signal_close_price)
            ? signal_close_price
            : null,
        bought_at,
        sector: this.signalMeta.sector || null,
        industry: this.signalMeta.industry || null,
        estimated_hold_days: this.signalMeta.estimated_hold_days,
        notes,
      });
      this.positionsStore.refetch();
      this.inlineStatus.set('Saved to my_positions.');
      this.inlineForm.reset();
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
