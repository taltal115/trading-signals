import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { toSignal } from '@angular/core/rxjs-interop';
import { Subscription, catchError, of, tap } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { PositionsStoreService } from '../../core/positions-store.service';
import {
  PositionRow,
  calculatePnlForPosition,
  effectiveQuantity,
  fmtSignedUsd,
  fmtUiDecimal,
  formatNum,
  quantityWasInferred,
} from '../../core/positions-logic';
import { formatApiErr } from '../../core/api-errors';
import { environment } from '../../../environments/environment';
import { normalizeSignalDocs } from '../../core/signal-docs-normalize';
import {
  buildSignalJoinIndex,
  findSignalRowForPosition,
  resolveSignalRowForPosition,
  type SignalJoinEntry,
} from '../../core/reporting-signal-join';
import type { SignalDoc } from '../../core/signal-docs-normalize';

function compareSortVals(
  a: string | number | null,
  b: string | number | null,
  dir: 'asc' | 'desc'
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  let cmp: number;
  if (typeof a === 'number' && typeof b === 'number') {
    cmp = a - b;
  } else {
    cmp = String(a).localeCompare(String(b), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  }
  return dir === 'asc' ? cmp : -cmp;
}

@Component({
  selector: 'app-reporting-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './reporting-page.component.html',
  styleUrl: './reporting-page.component.css',
})
export class ReportingPageComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  readonly authSvc = inject(AuthService);
  private readonly positionsStore = inject(PositionsStoreService);

  private sub: Subscription | null = null;

  readonly allowedUser = toSignal(this.authSvc.allowedUser$, { initialValue: null });
  readonly allRows = toSignal(this.positionsStore.rows$, { initialValue: [] });
  readonly positionsLoading = toSignal(this.positionsStore.loading$, { initialValue: false });
  readonly positionsError = toSignal(this.positionsStore.error$, { initialValue: null });

  readonly guestMode = computed(
    () => !this.authSvc.devAuthBypass && !this.allowedUser()
  );

  readonly signalsLoading = signal(true);
  readonly signalsError = signal('');
  /** Built after signals load; empty map until then. */
  readonly signalIndex = signal(new Map<string, SignalJoinEntry>());

  readonly dateFrom = signal('');
  readonly dateTo = signal('');
  readonly statusFilter = signal<'all' | 'open' | 'closed'>('all');
  readonly outcomeFilter = signal<'all' | 'winners' | 'losers'>('all');

  readonly sortKey = signal<string>('bought_at');
  readonly sortDir = signal<'asc' | 'desc'>('desc');

  readonly pdfExporting = signal(false);

  readonly summary = computed(() => {
    const rows = this.allRows();
    let open = 0;
    let closed = 0;
    let linked = 0;
    const idx = this.signalIndex();
    for (const r of rows) {
      if (r.data.status === 'open') open++;
      else if (r.data.status === 'closed') closed++;
      if (findSignalRowForPosition(r, idx)) linked++;
    }
    return { total: rows.length, open, closed, linked, unlinked: rows.length - linked };
  });

  readonly filteredRows = computed(() => {
    const from = this.dateFrom();
    const to = this.dateTo();
    const st = this.statusFilter();
    const out = this.outcomeFilter();
    const hasDate = !!(from || to);
    return this.allRows().filter((pos) => {
      if (st !== 'all' && pos.data.status !== st) return false;
      const pnl = this.pnlPctNumber(pos);
      if (out === 'winners') {
        if (pnl == null || pnl <= 0.0001) return false;
      } else if (out === 'losers') {
        if (pnl == null || pnl >= -0.0001) return false;
      }
      if (hasDate) {
        const ymd = this.referenceDateYmd(pos);
        if (!ymd) return false;
        if (from && ymd < from) return false;
        if (to && ymd > to) return false;
      }
      return true;
    });
  });

  readonly filterSummary = computed(() => ({
    shown: this.filteredRows().length,
    total: this.allRows().length,
  }));

  readonly reportTimeframeLabel = computed(() => {
    const from = this.dateFrom();
    const to = this.dateTo();
    let datePart: string;
    if (!from && !to) {
      datePart = 'All trade dates (filtered by bought / created timestamp)';
    } else if (from && to) {
      datePart = `${from} → ${to}`;
    } else if (from) {
      datePart = `From ${from}`;
    } else {
      datePart = `Through ${to}`;
    }
    const bits = [datePart];
    if (this.statusFilter() !== 'all') {
      bits.push('Status: ' + this.statusFilter());
    }
    if (this.outcomeFilter() !== 'all') {
      bits.push('P/L filter: ' + this.outcomeFilter());
    }
    return bits.join(' · ');
  });

  readonly displayRowsOpen = computed(() =>
    this.sortFilteredByStatus('open')
  );

  readonly displayRowsClosed = computed(() =>
    this.sortFilteredByStatus('closed')
  );

  /** P/L and win-rate totals for rows matching current filters (not table sort). */
  readonly filterStats = computed(() => {
    let totalPnl = 0;
    let inv = 0;
    let count = 0;
    let wins = 0;
    let rated = 0;
    for (const row of this.filteredRows()) {
      const c = calculatePnlForPosition(row.data, {});
      totalPnl += c.pnlValue;
      inv += c.investment;
      count++;
      const p = this.pnlPctNumber(row);
      if (p != null) {
        rated++;
        if (p > 0.0001) wins++;
      }
    }
    const totalPct = inv > 0 ? (totalPnl / inv) * 100 : 0;
    const winRatePct = rated > 0 ? (wins / rated) * 100 : null;
    return { count, totalPnl, totalPct, wins, rated, winRatePct };
  });

  ngOnInit(): void {
    const base = environment.apiBaseUrl;
    this.sub = this.http
      .get<{ docs: { id: string; data: SignalDoc }[] }>(`${base}/api/signals`)
      .pipe(
        tap({ next: () => this.signalsError.set('') }),
        catchError((err) => {
          this.signalsError.set(formatApiErr(err));
          return of({ docs: [] as { id: string; data: SignalDoc }[] });
        })
      )
      .subscribe((r) => {
        this.signalsLoading.set(false);
        const normalized = normalizeSignalDocs(r.docs ?? []);
        this.signalIndex.set(buildSignalJoinIndex(normalized));
      });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private sortFilteredByStatus(status: 'open' | 'closed'): PositionRow[] {
    const rows = this.filteredRows().filter((r) => r.data.status === status);
    const key = this.sortKey();
    const dir = this.sortDir();
    rows.sort((a, b) =>
      compareSortVals(this.columnSortValue(a, key), this.columnSortValue(b, key), dir)
    );
    return rows;
  }

  holdEstText(pos: PositionRow): string {
    const d = pos.data;
    const hold =
      d.hold_days_from_signal != null ? String(d.hold_days_from_signal) + 'd' : '—';
    const est =
      d.estimated_hold_days != null ? formatNum(d.estimated_hold_days) : '—';
    return hold + ' / ' + est;
  }

  confDisplay(pos: PositionRow): { text: string; cls: string; inferred: boolean } | null {
    const d = pos.data;
    const stored = d.signal_confidence != null ? Number(d.signal_confidence) : NaN;
    if (Number.isFinite(stored)) {
      return {
        text: fmtUiDecimal(stored) + '%',
        cls: this.confClass(stored),
        inferred: false,
      };
    }
    const sig = resolveSignalRowForPosition(pos, this.signalIndex());
    if (!sig) return null;
    const raw = sig.row['confidence'];
    if (raw == null || raw === '') return null;
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    return {
      text: fmtUiDecimal(v) + '%',
      cls: this.confClass(raw),
      inferred: sig.via === 'ticker',
    };
  }

  confTitle(pos: PositionRow): string | null {
    const c = this.confDisplay(pos);
    if (!c) return null;
    if (!c.inferred) return null;
    return 'Confidence from the latest signal run that lists this ticker (position is not linked to that run).';
  }

  qtyTitle(pos: PositionRow): string | null {
    return quantityWasInferred(pos.data)
      ? 'Quantity not stored; showing 1 share (same default as P/L math).'
      : null;
  }

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

  clearFilters(): void {
    this.dateFrom.set('');
    this.dateTo.set('');
    this.statusFilter.set('all');
    this.outcomeFilter.set('all');
  }

  readonly canExportPdf = computed(
    () =>
      !this.guestMode() &&
      !this.positionsLoading() &&
      !this.positionsError() &&
      this.allRows().length > 0 &&
      !this.signalsLoading()
  );

  async exportReportPdf(): Promise<void> {
    if (!this.canExportPdf() || this.pdfExporting()) return;
    this.pdfExporting.set(true);
    try {
      const [{ jsPDF }, { autoTable }] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const margin = 10;
      let y = 12;
      doc.setFontSize(15);
      doc.text('Trade reporting', margin, y);
      y += 6;
      doc.setFontSize(8);
      doc.setTextColor(60, 60, 60);
      doc.text('Generated (UTC): ' + new Date().toISOString(), margin, y);
      y += 4;
      doc.text('Timeframe: ' + this.reportTimeframeLabel(), margin, y);
      y += 4;
      doc.text(this.buildPdfSummaryLine(), margin, y);
      y += 4;
      doc.text('Filters: ' + this.buildPdfFilterLine(), margin, y);
      y += 4;
      const fs = this.filterStats();
      doc.text(
        `Filtered: ${fs.count} positions | P/L ${fmtSignedUsd(fs.totalPnl)} (${this.filterPctText()} blended) | Win rate ${this.winRateText()} (${this.winRateSubtext()})`,
        margin,
        y
      );
      y += 4;
      doc.text(`Table sort: ${this.sortKey()} (${this.sortDir()})`, margin, y);
      y += 4;
      doc.setFontSize(7);
      doc.setTextColor(90, 90, 90);
      doc.text(
        '* qty = default 1 share when missing in data. ~ conf = from latest signal run with this ticker when position is not linked to that run.',
        margin,
        y
      );
      doc.setTextColor(0, 0, 0);
      doc.setFontSize(8);
      y += 8;

      const head = [this.pdfTableHeaders()];
      type DocWithTable = typeof doc & { lastAutoTable?: { finalY: number } };
      const afterTable = (d: typeof doc) => (d as DocWithTable).lastAutoTable?.finalY ?? y;

      const drawSection = (
        title: string,
        rgb: [number, number, number],
        body: string[][]
      ): void => {
        doc.setFontSize(10);
        doc.setTextColor(...rgb);
        doc.text(`${title} (${body.length})`, margin, y);
        doc.setTextColor(0, 0, 0);
        y += 5;
        if (body.length === 0) {
          doc.setFontSize(8);
          doc.setTextColor(100, 100, 100);
          doc.text('No rows.', margin, y);
          doc.setTextColor(0, 0, 0);
          y += 6;
          return;
        }
        autoTable(doc, {
          startY: y,
          head,
          body,
          styles: { fontSize: 6, cellPadding: 0.45, overflow: 'linebreak' },
          headStyles: { fillColor: rgb, textColor: 255, fontStyle: 'bold' },
          margin: { left: margin, right: margin },
          tableWidth: 'wrap',
          showHead: 'everyPage',
        });
        y = afterTable(doc) + 10;
      };

      if (fs.count === 0) {
        doc.setFontSize(9);
        doc.text('No rows match the current filters.', margin, y);
      } else {
        drawSection(
          'Open positions',
          [16, 122, 107],
          this.displayRowsOpen().map((p) => this.buildPdfTableRow(p))
        );
        drawSection(
          'Closed positions',
          [180, 83, 9],
          this.displayRowsClosed().map((p) => this.buildPdfTableRow(p))
        );
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      doc.save(`trade-report-${stamp}.pdf`);
    } finally {
      this.pdfExporting.set(false);
    }
  }

  filterPnlCardClass(): Record<string, boolean> {
    const s = this.filterStats();
    if (s.count === 0) return {};
    const profit = s.totalPnl > 0.0001;
    const loss = s.totalPnl < -0.0001;
    return {
      'pnl-card-profit': profit,
      'pnl-card-loss': loss,
    };
  }

  filterPctClass(): string {
    const s = this.filterStats();
    if (s.count === 0) return 'pnl-flat';
    if (s.totalPct > 0.0001) return 'pnl-profit';
    if (s.totalPct < -0.0001) return 'pnl-loss';
    return 'pnl-flat';
  }

  filterValueClass(): string {
    const s = this.filterStats();
    if (s.count === 0) return 'pnl-flat';
    if (s.totalPnl > 0.0001) return 'pnl-profit';
    if (s.totalPnl < -0.0001) return 'pnl-loss';
    return 'pnl-flat';
  }

  filterPctText(): string {
    const s = this.filterStats();
    const v = s.totalPct;
    const sign = v > 0 ? '+' : v < 0 ? '' : '+';
    return sign + fmtUiDecimal(v) + '%';
  }

  winRateCardClass(): Record<string, boolean> {
    const s = this.filterStats();
    if (s.count === 0 || s.rated === 0 || s.winRatePct == null) return {};
    const hi = s.winRatePct > 50 + 0.0001;
    const lo = s.winRatePct < 50 - 0.0001;
    return {
      'pnl-card-profit': hi,
      'pnl-card-loss': lo,
    };
  }

  winRateMainClass(): string {
    const s = this.filterStats();
    if (s.winRatePct == null) return 'pnl-flat';
    if (s.winRatePct > 50 + 0.0001) return 'pnl-profit';
    if (s.winRatePct < 50 - 0.0001) return 'pnl-loss';
    return 'pnl-flat';
  }

  winRateText(): string {
    const p = this.filterStats().winRatePct;
    if (p == null) return '—';
    return fmtUiDecimal(p) + '%';
  }

  winRateSubtext(): string {
    const s = this.filterStats();
    if (s.count === 0) return 'No rows match filters';
    if (s.rated === 0) return 'No P/L % in filtered set';
    return s.wins + ' / ' + s.rated + ' winners';
  }

  plPctText(pos: PositionRow): string {
    const d = pos.data;
    if (d.status === 'closed') {
      let p = d.pnl_pct;
      if (p == null && d.exit_price != null && d.entry_price != null) {
        const e = Number(d.entry_price);
        const x = Number(d.exit_price);
        if (e > 0) p = ((x - e) / e) * 100;
      }
      if (p == null || !Number.isFinite(Number(p))) return '—';
      const v = Number(p);
      const sign = v > 0 ? '+' : '';
      return sign + fmtUiDecimal(v) + '%';
    }
    const { pnlPct } = calculatePnlForPosition(d, {});
    if (!Number.isFinite(pnlPct)) return '—';
    const sign = pnlPct > 0 ? '+' : '';
    return sign + fmtUiDecimal(pnlPct) + '%';
  }

  plPctClass(pos: PositionRow): string {
    const d = pos.data;
    let p: number | null = null;
    if (d.status === 'closed') {
      let pv = d.pnl_pct;
      if (pv == null && d.exit_price != null && d.entry_price != null) {
        const e = Number(d.entry_price);
        const x = Number(d.exit_price);
        if (e > 0) pv = ((x - e) / e) * 100;
      }
      p = pv != null && Number.isFinite(Number(pv)) ? Number(pv) : null;
    } else {
      const { pnlPct } = calculatePnlForPosition(d, {});
      p = Number.isFinite(pnlPct) ? pnlPct : null;
    }
    if (p == null) return '';
    if (p > 0.0001) return 'pnl-profit';
    if (p < -0.0001) return 'pnl-loss';
    return 'pnl-flat';
  }

  fmtSigMoney(v: unknown): string {
    if (v == null || v === '') return '—';
    const n = Number(v);
    return Number.isFinite(n) ? formatNum(n) : '—';
  }

  str(v: unknown): string {
    if (v == null || v === '') return '—';
    return String(v);
  }

  confClass(conf: unknown): string {
    if (conf == null) return '';
    const v = Number(conf);
    if (!Number.isFinite(v)) return '';
    if (v >= 70) return 'conf-high';
    if (v >= 50) return 'conf-mid';
    return 'conf-low';
  }

  protected readonly formatNum = formatNum;
  protected readonly fmtSignedUsd = fmtSignedUsd;
  protected readonly effectiveQuantity = effectiveQuantity;
  protected readonly quantityWasInferred = quantityWasInferred;

  private buildPdfSummaryLine(): string {
    const s = this.summary();
    const f = this.filterSummary();
    return (
      `Portfolio: ${s.total} position(s) — ${s.open} open, ${s.closed} closed; ` +
      `${s.linked} linked to signal, ${s.unlinked} unlinked. ` +
      `After filters: ${f.shown} of ${f.total}.`
    );
  }

  private buildPdfFilterLine(): string {
    const parts: string[] = [];
    if (this.dateFrom()) parts.push('from ' + this.dateFrom());
    if (this.dateTo()) parts.push('to ' + this.dateTo());
    if (this.statusFilter() !== 'all') parts.push('status=' + this.statusFilter());
    if (this.outcomeFilter() !== 'all') parts.push('P/L=' + this.outcomeFilter());
    return parts.length ? parts.join('; ') : 'none (all)';
  }

  private pdfTableHeaders(): string[] {
    return [
      'ticker',
      'qty',
      'entry',
      'exit',
      'P/L %',
      'stop',
      'target',
      'bought',
      'created',
      'closed',
      'hold/est',
      'alert',
      'conf',
    ];
  }

  private pdfCell(v: unknown, maxLen = 280): string {
    if (v == null || v === '') return '—';
    const s = String(v).replace(/\s+/g, ' ').trim();
    return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
  }

  private buildPdfTableRow(pos: PositionRow): string[] {
    const d = pos.data;
    const sig = resolveSignalRowForPosition(pos, this.signalIndex());
    const exitPd =
      d.status === 'closed' && d.exit_price != null ? formatNum(d.exit_price) : '—';
    let conf = '—';
    const storedConf = d.signal_confidence != null ? Number(d.signal_confidence) : NaN;
    if (Number.isFinite(storedConf)) {
      conf = fmtUiDecimal(storedConf) + '%';
    } else if (sig != null && sig.row['confidence'] != null && sig.row['confidence'] !== '') {
      const cv = Number(sig.row['confidence']);
      if (Number.isFinite(cv)) {
        conf = fmtUiDecimal(cv) + '%' + (sig.via === 'ticker' ? ' ~' : '');
      }
    }
    const qty = effectiveQuantity(d);
    const qtyStr =
      formatNum(qty) + (quantityWasInferred(d) ? '*' : '');
    return [
      this.pdfCell(d.ticker, 16),
      qtyStr,
      formatNum(d.entry_price),
      exitPd,
      this.plPctText(pos),
      formatNum(d.stop_price),
      formatNum(d.target_price),
      this.pdfCell(d.bought_at, 22),
      this.pdfCell(d.created_at_utc, 22),
      this.pdfCell(d.closed_at_utc, 22),
      this.holdEstText(pos),
      this.pdfCell(d.last_alert_kind, 28),
      conf,
    ];
  }

  private referenceDateYmd(pos: PositionRow): string {
    const raw = pos.data.bought_at || pos.data.created_at_utc;
    if (raw == null || raw === '') return '';
    const s = String(raw);
    if (s.length >= 10 && s[4] === '-' && s[7] === '-') return s.slice(0, 10);
    return s;
  }

  private pnlPctNumber(pos: PositionRow): number | null {
    const d = pos.data;
    if (d.status === 'closed') {
      let pv = d.pnl_pct;
      if (pv == null && d.exit_price != null && d.entry_price != null) {
        const e = Number(d.entry_price);
        const x = Number(d.exit_price);
        if (e > 0) pv = ((x - e) / e) * 100;
      }
      return pv != null && Number.isFinite(Number(pv)) ? Number(pv) : null;
    }
    const { pnlPct } = calculatePnlForPosition(d, {});
    return Number.isFinite(pnlPct) ? pnlPct : null;
  }

  private columnSortValue(pos: PositionRow, key: string): string | number | null {
    const d = pos.data;
    switch (key) {
      case 'ticker':
        return (d.ticker || '').toUpperCase();
      case 'quantity':
        return effectiveQuantity(d);
      case 'entry_price':
        return d.entry_price != null ? Number(d.entry_price) : null;
      case 'exit_price':
        return d.status === 'closed' && d.exit_price != null ? Number(d.exit_price) : null;
      case 'pnl_pct':
        return this.pnlPctNumber(pos);
      case 'stop_price':
        return d.stop_price != null ? Number(d.stop_price) : null;
      case 'target_price':
        return d.target_price != null ? Number(d.target_price) : null;
      case 'bought_at':
        return this.referenceDateYmd(pos) || String(d.bought_at || '');
      case 'created_at_utc':
        return String(d.created_at_utc || '');
      case 'closed_at_utc':
        return String(d.closed_at_utc || '');
      case 'hold_days':
        return d.hold_days_from_signal != null ? Number(d.hold_days_from_signal) : null;
      case 'last_alert_kind':
        return String(d.last_alert_kind || '');
      case 'sig_confidence': {
        const sc = d.signal_confidence != null ? Number(d.signal_confidence) : NaN;
        if (Number.isFinite(sc)) return sc;
        const r = resolveSignalRowForPosition(pos, this.signalIndex());
        const v = r?.row['confidence'];
        return v != null && v !== '' ? Number(v) : null;
      }
      default:
        return null;
    }
  }
}
