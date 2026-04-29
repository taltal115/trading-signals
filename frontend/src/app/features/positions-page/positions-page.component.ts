import {
  Component,
  ElementRef,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import {
  FormBuilder,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { PositionsStoreService } from '../../core/positions-store.service';
import { MarketDataService } from '../../core/market-data.service';
import { GithubWorkflowsService } from '../../core/github-workflows.service';
import { OpenPositionService } from '../../core/open-position.service';
import { ExitDialogService } from '../../core/exit-dialog.service';
import {
  PositionRow,
  PositionData,
  addTradingDays,
  countTradingDaysBetween,
  formatNum,
  rowPnlClass,
  getFilteredPositions,
  sortPositionsData,
  exitViaLabel,
  calculatePnlForPosition,
  fmtMoneyInput,
  BracketPct,
  fmtUiDecimal,
  positionIsOpen,
  positionIsClosed,
} from '../../core/positions-logic';
import { formatApiErr } from '../../core/api-errors';
import { environment } from '../../../environments/environment';
import { PriceHistoryChartComponent } from '../price-history-chart/price-history-chart.component';

interface CheckRow {
  ts_utc?: string;
  tag?: string;
  alert_kind?: string;
  confidence?: unknown;
  last_spot?: unknown;
  pnl_pct?: unknown;
  days_held?: unknown;
  atr_hold_est?: unknown;
  alert_summary?: string;
}

@Component({
  selector: 'app-positions-page',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, PriceHistoryChartComponent],
  templateUrl: './positions-page.component.html',
  styleUrl: './positions-page.component.css',
})
export class PositionsPageComponent {
  constructor() {
    this.exitDlg.exitSaved$
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        const det = this.detailsRef?.nativeElement;
        if (det) det.open = false;
      });
  }

  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  readonly authSvc = inject(AuthService);
  private readonly positionsStore = inject(PositionsStoreService);
  private readonly market = inject(MarketDataService);
  private readonly github = inject(GithubWorkflowsService);
  private readonly openPos = inject(OpenPositionService);
  private readonly exitDlg = inject(ExitDialogService);

  @ViewChild('detailsEl') detailsRef?: ElementRef<HTMLDetailsElement>;

  readonly allowedUser = toSignal(this.authSvc.allowedUser$, { initialValue: null });
  readonly allRows = toSignal(this.positionsStore.rows$, { initialValue: [] });
  readonly loadError = toSignal(this.positionsStore.error$, { initialValue: null });
  readonly positionsLoading = toSignal(this.positionsStore.loading$, {
    initialValue: false,
  });

  readonly guestMode = computed(
    () => !this.authSvc.devAuthBypass && !this.allowedUser()
  );

  readonly hideClosed = signal(true);
  readonly sortKey = signal<string>('bought_at');
  readonly sortDir = signal<'asc' | 'desc'>('desc');
  readonly livePrices = signal<Record<string, number>>({});

  readonly expandedMonitorId = signal<string | null>(null);
  readonly expandedHistoryId = signal<string | null>(null);
  readonly checksMap = signal<Record<string, CheckRow[] | undefined>>({});
  readonly checksErr = signal<Record<string, string>>({});

  readonly spotRefreshing = signal<string | null>(null);
  readonly checkBusy = signal<string | null>(null);

  readonly manualBracketPct = signal<BracketPct | null>(null);
  readonly manualStatus = signal('');
  readonly manualSaving = signal(false);

  readonly manualForm = this.fb.group({
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

  readonly sortedRows = computed(() => {
    const rows = this.allRows();
    const filtered = getFilteredPositions(rows, this.hideClosed());
    return sortPositionsData(filtered, this.sortKey(), this.sortDir(), this.livePrices());
  });

  readonly showTable = computed(() => !this.guestMode() && this.allRows().length > 0);

  readonly tableFilteredEmpty = computed(
    () =>
      !this.guestMode() &&
      this.allRows().length > 0 &&
      this.sortedRows().length === 0 &&
      this.hideClosed()
  );

  readonly hintText = computed(() => {
    if (this.guestMode()) {
      return 'Sign in with Google to see positions.';
    }
    if (this.loadError()) return 'Positions error: ' + this.loadError();
    if (this.allRows().length === 0) return 'No positions yet. Add one with the form above.';
    return '';
  });

  onSortHeader(key: string): void {
    if (this.sortKey() === key) {
      this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortKey.set(key);
      this.sortDir.set('asc');
    }
  }

  thClass(key: string): Record<string, boolean> {
    return {
      'sort-asc': this.sortKey() === key && this.sortDir() === 'asc',
      'sort-desc': this.sortKey() === key && this.sortDir() === 'desc',
    };
  }

  rowClass(d: PositionData): string {
    return rowPnlClass(d);
  }

  /** Template bindings — inferred open/closed for migrated Firestore rows. */
  readonly uiOpen = positionIsOpen;
  readonly uiClosed = positionIsClosed;

  statusCell(d: PositionData): string {
    const raw = String(d.status ?? '').trim();
    if (raw) return raw;
    return positionIsOpen(d) ? 'open' : 'closed';
  }

  pnlClosed(pos: PositionRow): { cls: string; text: string } | null {
    const d = pos.data;
    if (!positionIsClosed(d)) return null;
    let p = d.pnl_pct;
    if (p == null && d.exit_price != null && d.entry_price != null) {
      const e = Number(d.entry_price);
      const x = Number(d.exit_price);
      if (e > 0) p = ((x - e) / e) * 100;
    }
    if (p == null || !Number.isFinite(Number(p))) return null;
    p = Number(p);
    const cls = p > 0.0001 ? 'pnl-profit' : p < -0.0001 ? 'pnl-loss' : 'pnl-flat';
    const sign = p > 0 ? '+' : '';
    return { cls, text: sign + fmtUiDecimal(p) + '%' };
  }

  actionCell(d: PositionData): { cls: string; text: string } | null {
    if (!d.last_alert_kind) return null;
    const isSell =
      ['STOP_HIT', 'TARGET_HIT', 'DURATION_DUE'].indexOf(String(d.last_alert_kind)) !== -1;
    return {
      cls: isSell ? 'tag-sell' : 'tag-wait',
      text: isSell ? 'SELL' : 'WAIT',
    };
  }

  holdLines(d: PositionData): { main: string; extra?: string; due?: string } | null {
    const hdFrom = d.hold_days_from_signal;
    const estHold = d.estimated_hold_days;
    const effective =
      hdFrom != null ? hdFrom : estHold != null ? Math.ceil(Number(estHold)) : null;
    if (effective == null) return null;
    let main = String(effective) + 'd';
    let extra: string | undefined;
    if (hdFrom == null && estHold != null) extra = '(ATR est)';
    else if (estHold != null && estHold !== hdFrom)
      extra = '(ATR ' + fmtUiDecimal(Number(estHold)) + 'd)';
    let due: string | undefined;
    const startDate = d.bought_at || d.created_at_utc;
    if (startDate) {
      try {
        const created = new Date(startDate);
        const dueDate = addTradingDays(created, effective);
        const dueStr = dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const tradingDaysHeld = countTradingDaysBetween(created, new Date());
        due = `day ${tradingDaysHeld}/${effective} · due ${dueStr}`;
      } catch {
        /* ignore */
      }
    }
    return { main, extra, due };
  }

  spotBlock(pos: PositionRow): {
    hasVal: boolean;
    valCls: string;
    valText: string;
    arrow: string;
    showRefresh: boolean;
    stale: string;
    /** Unrealized P/L % vs entry when position is open (spot vs entry). */
    pnlPart: { cls: string; text: string } | null;
  } {
    const d = pos.data;
    const ticker = (d.ticker || '').toUpperCase();
    const live = this.livePrices()[ticker];
    const spotF =
      live !== undefined
        ? live
        : d.last_spot != null
          ? Number(d.last_spot)
          : null;
    const entryF = d.entry_price != null ? Number(d.entry_price) : null;
    const showRefresh = positionIsOpen(d);

    if (spotF != null && Number.isFinite(spotF)) {
      let valCls = 'spot-val';
      let arrow = '';
      if (entryF != null && Number.isFinite(entryF) && entryF > 0) {
        if (spotF > entryF) {
          valCls = 'spot-val spot-up';
          arrow = ' ▲';
        } else if (spotF < entryF) {
          valCls = 'spot-val spot-down';
          arrow = ' ▼';
        }
      }
      const stale =
        live !== undefined
          ? 'live'
          : d.last_alert_ts_utc
            ? String(d.last_alert_ts_utc).slice(0, 16).replace('T', ' ')
            : '';

      let pnlPart: { cls: string; text: string } | null = null;
      if (positionIsOpen(d) && entryF != null && Number.isFinite(entryF) && entryF > 0) {
        const pnlPct = ((spotF - entryF) / entryF) * 100;
        const sign = pnlPct > 0 ? '+' : '';
        const pctCls =
          pnlPct > 0.0001 ? 'pnl-profit' : pnlPct < -0.0001 ? 'pnl-loss' : 'pnl-flat';
        pnlPart = {
          cls: pctCls + ' spot-pnl-pct',
          text: ` (${sign}${fmtUiDecimal(pnlPct)}%)`,
        };
      }

      return {
        hasVal: true,
        valCls,
        valText: fmtUiDecimal(spotF),
        arrow,
        showRefresh,
        stale,
        pnlPart,
      };
    }

    if (positionIsOpen(d)) {
      return {
        hasVal: false,
        valCls: '',
        valText: '—',
        arrow: '',
        showRefresh: true,
        stale: '',
        pnlPart: null,
      };
    }
    return {
      hasVal: false,
      valCls: '',
      valText: '—',
      arrow: '',
      showRefresh: false,
      stale: '',
      pnlPart: null,
    };
  }

  async onSpotRefresh(pos: PositionRow): Promise<void> {
    const docId = pos.id;
    const ticker = pos.data.ticker || '';
    if (!docId) return;
    const base = environment.apiBaseUrl;
    this.spotRefreshing.set(docId);
    let entry: number | null =
      pos.data.entry_price != null ? Number(pos.data.entry_price) : null;
    try {
      const r = await firstValueFrom(
        this.http.get<{ doc: { id: string; data: PositionData } }>(
          `${base}/api/positions/${docId}`
        )
      );
      const pd = r.doc?.data;
      if (pd && pd['entry_price'] != null) entry = Number(pd['entry_price']);
    } catch {
      /* ignore */
    }
    let spot: number | null = null;
    try {
      if (ticker) spot = await this.market.fetchLivePrice(ticker);
    } catch {
      try {
        const r2 = await firstValueFrom(
          this.http.get<{ doc: { id: string; data: PositionData } }>(
            `${base}/api/positions/${docId}`
          )
        );
        const cached = r2.doc?.data;
        if (cached && cached['last_spot'] != null)
          spot = Number(cached['last_spot']);
      } catch {
        /* ignore */
      }
    }
    if (spot != null && Number.isFinite(spot) && ticker) {
      const k = ticker.toUpperCase();
      this.livePrices.update((m) => ({ ...m, [k]: spot! }));
    }
    this.spotRefreshing.set(null);
  }

  toggleMonitor(pos: PositionRow): void {
    const id = pos.id;
    const ticker = pos.data.ticker || '';
    if (this.expandedMonitorId() === id) {
      this.expandedMonitorId.set(null);
      return;
    }
    this.expandedHistoryId.set(null);
    this.expandedMonitorId.set(id);
    void this.loadChecks(id, ticker);
  }

  toggleHistory(pos: PositionRow): void {
    if (this.expandedHistoryId() === pos.id) {
      this.expandedHistoryId.set(null);
      return;
    }
    this.expandedMonitorId.set(null);
    this.expandedHistoryId.set(pos.id);
  }

  private async loadChecks(posId: string, ticker: string): Promise<void> {
    const u = this.allowedUser();
    if (!u) {
      this.checksErr.update((m) => ({
        ...m,
        [posId]: 'Sign in to view checks.',
      }));
      return;
    }
    this.checksMap.update((m) => {
      const n = { ...m };
      delete n[posId];
      return n;
    });
    this.checksErr.update((m) => {
      const n = { ...m };
      delete n[posId];
      return n;
    });
    try {
      const base = environment.apiBaseUrl;
      const r = await firstValueFrom(
        this.http.get<{ docs: { id: string; data: CheckRow }[] }>(
          `${base}/api/positions/${posId}/checks`
        )
      );
      const rows: CheckRow[] = (r.docs ?? []).map((d) => d.data as CheckRow);
      this.checksMap.update((m) => ({ ...m, [posId]: rows }));
    } catch (e) {
      this.checksErr.update((m) => ({
        ...m,
        [posId]: formatApiErr(e),
      }));
    }
  }

  requestExit(pos: PositionRow): void {
    this.exitDlg.requestOpen({
      docId: pos.id,
      ticker: pos.data.ticker || '',
      entry: Number(pos.data.entry_price ?? 0),
      quantity: pos.data.quantity,
    });
  }

  async checkNow(ticker: string): Promise<void> {
    const t = String(ticker || '').trim();
    if (!t) return;
    this.checkBusy.set(t);
    try {
      await this.github.triggerMonitorWorkflow(t);
    } catch (e) {
      console.error(e);
    } finally {
      this.checkBusy.set(null);
    }
  }

  checkLabel(ticker: string): string {
    return this.checkBusy() === ticker ? '…' : 'Check';
  }

  checkDisabled(ticker: string): boolean {
    return this.checkBusy() === ticker;
  }

  manualBracketHint(): string {
    const bp = this.manualBracketPct();
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

  manualSyncDisabled(): boolean {
    const bp = this.manualBracketPct();
    return !bp || !Number.isFinite(bp.stopPct) || !Number.isFinite(bp.targetPct);
  }

  syncManualBracket(): void {
    const bp = this.manualBracketPct();
    if (!bp || !Number.isFinite(bp.stopPct) || !Number.isFinite(bp.targetPct)) {
      this.manualStatus.set(
        'No signal bracket % on this form. Open it with Log Buy from the signals table.'
      );
      return;
    }
    const entry = Number(this.manualForm.get('entry_price')?.value);
    if (!Number.isFinite(entry) || entry <= 0) {
      this.manualStatus.set('Enter a valid entry price first.');
      return;
    }
    const stop = entry * (1 + bp.stopPct / 100);
    const target = entry * (1 + bp.targetPct / 100);
    this.manualForm.patchValue({
      stop_price: parseFloat(fmtMoneyInput(stop)),
      target_price: parseFloat(fmtMoneyInput(target)),
    });
    this.manualStatus.set('');
  }

  async submitManual(): Promise<void> {
    this.manualStatus.set('');
    if (this.manualForm.invalid || this.guestMode()) return;
    const u = this.allowedUser();
    if (!u) {
      this.manualStatus.set('Sign in with Google first.');
      return;
    }
    this.manualSaving.set(true);
    try {
      const raw = this.manualForm.getRawValue();
      const ticker = String(raw.ticker || '')
        .trim()
        .toUpperCase();
      const entry = Number(raw.entry_price);
      if (!ticker || !Number.isFinite(entry)) {
        this.manualStatus.set('Ticker and entry price required.');
        return;
      }
      const qtyRaw = raw.quantity;
      const quantity =
        qtyRaw === null || qtyRaw === undefined ? null : Number(qtyRaw);
      const stop_price =
        raw.stop_price === null || raw.stop_price === undefined
          ? null
          : Number(raw.stop_price);
      const target_price =
        raw.target_price === null || raw.target_price === undefined
          ? null
          : Number(raw.target_price);
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
        signal_confidence: null,
        hold_days_from_signal:
          hold_days_from_signal != null && Number.isFinite(hold_days_from_signal)
            ? hold_days_from_signal
            : null,
        signal_close_price:
          signal_close_price != null && Number.isFinite(signal_close_price)
            ? signal_close_price
            : null,
        bought_at,
        sector: null,
        industry: null,
        estimated_hold_days: null,
        notes,
      });
      this.positionsStore.refetch();
      this.manualStatus.set('Saved to my_positions.');
      this.manualForm.reset();
      this.manualBracketPct.set(null);
      const det = this.detailsRef?.nativeElement;
      if (det) det.open = false;
    } catch (e) {
      this.manualStatus.set(
        'Error: ' + (e instanceof Error ? e.message : String(e))
      );
    } finally {
      this.manualSaving.set(false);
    }
  }

  tagClass(tag: string): string {
    return String(tag || '').toUpperCase() === 'SELL' ? 'tag-sell' : 'tag-wait';
  }

  checkPnl(c: CheckRow): { cls: string; text: string } | null {
    if (c.pnl_pct == null) return null;
    const pv = Number(c.pnl_pct);
    const cls = pv > 0.0001 ? 'pnl-profit' : pv < -0.0001 ? 'pnl-loss' : 'pnl-flat';
    const sign = pv > 0 ? '+' : '';
    return { cls, text: sign + fmtUiDecimal(pv) + '%' };
  }

  protected readonly formatNum = formatNum;
  protected readonly exitViaLabel = exitViaLabel;
}
