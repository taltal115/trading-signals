import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { formatApiErr } from '../../core/api-errors';
import { fmtUiDecimal, fmtUiPercent } from '../../core/positions-logic';
import { environment } from '../../../environments/environment';

/** Row in Firestore ``universe.symbol_details`` (Finnhub profile + strategy scores + status). */
export interface UniverseSymbolDetail {
  name?: string;
  confidence?: number;
  score?: number;
  sector?: string;
  country?: string;
  market_cap?: number;
  active?: boolean;
  status?: string;
  inactive_reason?: string;
  last_score?: number;
  last_confidence?: number;
  last_evaluated_run_at?: string;
  last_active_at?: string;
  last_active_asof_date?: string;
  inactive_runs_streak?: number;
  inactive_since_run_at?: string;
}

export type UniverseStatusKey =
  | 'active'
  | 'inactive_failed'
  | 'inactive_low_conf'
  | 'inactive_stale'
  | 'inactive_capped'
  | 'unknown';

export type UniverseStatusFilter = 'all' | UniverseStatusKey;

const STATUS_LABELS: Record<UniverseStatusKey, string> = {
  active: 'Active',
  inactive_failed: 'Failed',
  inactive_low_conf: 'Low conf',
  inactive_stale: 'Stale',
  inactive_capped: 'Capped',
  unknown: 'Unknown',
};

const STATUS_FILTER_OPTIONS: { value: UniverseStatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'inactive_failed', label: 'Failed' },
  { value: 'inactive_low_conf', label: 'Low conf' },
  { value: 'inactive_stale', label: 'Stale' },
  { value: 'inactive_capped', label: 'Capped' },
  { value: 'unknown', label: 'Unknown' },
];

const SNAP_PAGE_SIZE = 5;
const SYMBOL_PAGE_SIZE = 50;

type SymbolRow = { ticker: string; detail: UniverseSymbolDetail };

interface SymbolTableState {
  loading: boolean;
  loaded: boolean;
  error: string | null;
  total: number;
  offset: number;
  rows: SymbolRow[];
  sortKey: string;
  sortDir: 'asc' | 'desc';
  statusFilter: UniverseStatusFilter;
  search: string;
}

export interface SymbolTableView {
  loading: boolean;
  error: string | null;
  total: number;
  offset: number;
  pageRows: SymbolRow[];
  pageStart: number;
  pageEnd: number;
  statusFilter: UniverseStatusFilter;
  search: string;
  sortKey: string;
  sortDir: 'asc' | 'desc';
}

export interface UniverseSnapshotLite {
  id: string;
  asof_date?: string;
  ts_utc?: string;
  source?: string;
  symbol_count: number;
  active_count: number;
  inactive_count: number;
}

interface SnapshotPage {
  docs: UniverseSnapshotLite[];
  nextCursor: string | null;
}

interface UniverseListApiResponse {
  docs: {
    id: string;
    data: {
      asof_date?: string;
      ts_utc?: string;
      source?: string;
      symbol_count?: number;
      active_count?: number;
      inactive_count?: number;
    };
  }[];
  nextCursor: string | null;
}

interface SymbolPageApiResponse {
  total: number;
  offset: number;
  limit: number;
  rows: { ticker: string; detail: Record<string, unknown> }[];
}

function normalizeSymbolDetails(d: Record<string, unknown> | undefined): UniverseSymbolDetail {
  if (!d || typeof d !== 'object') return {};
  return d as UniverseSymbolDetail;
}

function defaultSymbolTableState(): SymbolTableState {
  return {
    loading: false,
    loaded: false,
    error: null,
    total: 0,
    offset: 0,
    rows: [],
    sortKey: 'score',
    sortDir: 'desc',
    statusFilter: 'all',
    search: '',
  };
}

@Component({
  selector: 'app-universe-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './universe-page.component.html',
  styleUrl: './universe-page.component.css',
})
export class UniversePageComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private sub: Subscription | null = null;
  private readonly subsSymbol: Subscription[] = [];

  readonly loading = signal(true);
  readonly loadingSnapshotPage = signal(false);
  readonly error = signal<string | null>(null);

  readonly snapshotPages = signal<SnapshotPage[]>([]);
  readonly snapshotPageIndex = signal(0);
  readonly expandedId = signal<string | null>(null);

  readonly symbolState = signal<Record<string, SymbolTableState>>({});

  readonly statusFilterOptions = STATUS_FILTER_OPTIONS;

  protected readonly fmtUiDecimal = fmtUiDecimal;

  ngOnInit(): void {
    this.fetchSnapshotPage(undefined);
  }

  private fetchSnapshotPage(cursor: string | undefined): void {
    const base = environment.apiBaseUrl;
    const first = cursor === undefined;
    if (first) {
      this.loading.set(true);
    } else {
      this.loadingSnapshotPage.set(true);
    }
    this.error.set(null);

    let params = new HttpParams().set('limit', String(SNAP_PAGE_SIZE));
    if (cursor) {
      params = params.set('cursor', cursor);
    }

    this.sub?.unsubscribe();
    this.sub = this.http.get<UniverseListApiResponse>(`${base}/api/universe`, { params }).subscribe({
      next: (r) => {
        const page: SnapshotPage = {
          docs: (r.docs ?? []).map((d) => {
            const activeRaw = Number(d.data?.active_count);
            const inactiveRaw = Number(d.data?.inactive_count);
            const active = Number.isFinite(activeRaw) ? activeRaw : 0;
            const inactive = Number.isFinite(inactiveRaw) ? inactiveRaw : 0;
            const countRaw = Number(d.data?.symbol_count);
            const total =
              Number.isFinite(countRaw) && countRaw > 0 ? countRaw : active + inactive;
            return {
              id: d.id,
              asof_date: d.data?.asof_date != null ? String(d.data.asof_date) : undefined,
              ts_utc: d.data?.ts_utc != null ? String(d.data.ts_utc) : undefined,
              source: d.data?.source != null ? String(d.data.source) : undefined,
              symbol_count: total,
              active_count: active,
              inactive_count: inactive,
            };
          }),
          nextCursor: r.nextCursor ?? null,
        };
        if (first) {
          this.snapshotPages.set([page]);
          this.snapshotPageIndex.set(0);
        } else {
          this.snapshotPages.update((prev) => [...prev, page]);
          this.snapshotPageIndex.update((i) => i + 1);
        }
        this.loading.set(false);
        this.loadingSnapshotPage.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.loadingSnapshotPage.set(false);
        this.error.set(formatApiErr(err));
        if (first) {
          this.snapshotPages.set([]);
        }
      },
    });
  }

  snapshotPageLabel(): number {
    return this.snapshotPageIndex() + 1;
  }

  currentSnapshots(): UniverseSnapshotLite[] {
    const pages = this.snapshotPages();
    const i = this.snapshotPageIndex();
    return pages[i]?.docs ?? [];
  }

  canPrevSnapshots(): boolean {
    return this.snapshotPageIndex() > 0;
  }

  canNextSnapshots(): boolean {
    const pages = this.snapshotPages();
    const i = this.snapshotPageIndex();
    if (!pages.length) return false;
    if (i + 1 < pages.length) return true;
    return !!pages[i]?.nextCursor;
  }

  nextSnapshotPage(): void {
    const pages = this.snapshotPages();
    const i = this.snapshotPageIndex();
    if (i + 1 < pages.length) {
      this.snapshotPageIndex.set(i + 1);
      return;
    }
    const cur = pages[i];
    if (!cur?.nextCursor) return;
    this.fetchSnapshotPage(cur.nextCursor);
  }

  prevSnapshotPage(): void {
    if (this.snapshotPageIndex() <= 0) {
      return;
    }
    this.snapshotPageIndex.update((x) => x - 1);
  }

  toggleRow(id: string): void {
    const next = this.expandedId() === id ? null : id;
    this.expandedId.set(next);
    if (!next) return;
    const st = this.symbolState()[next];
    if (!st?.loaded && !st?.loading) {
      this.loadSymbolPage(next, 0);
    }
  }

  private patchSymbolState(docId: string, patch: Partial<SymbolTableState>): void {
    this.symbolState.update((s) => ({
      ...s,
      [docId]: {
        ...(s[docId] ?? defaultSymbolTableState()),
        ...patch,
      },
    }));
  }

  private loadSymbolPage(docId: string, offset: number): void {
    const st = this.symbolState()[docId] ?? defaultSymbolTableState();
    if (st.loading) return;

    const base = environment.apiBaseUrl;
    this.patchSymbolState(docId, { loading: true, error: null, offset });

    const params = new HttpParams()
      .set('offset', String(offset))
      .set('limit', String(SYMBOL_PAGE_SIZE))
      .set('sort', st.sortKey)
      .set('dir', st.sortDir);

    const sub = this.http
      .get<SymbolPageApiResponse>(`${base}/api/universe/${encodeURIComponent(docId)}/symbols`, {
        params,
      })
      .subscribe({
        next: (r) => {
          this.patchSymbolState(docId, {
            loading: false,
            loaded: true,
            error: null,
            total: r.total,
            offset: r.offset,
            rows: (r.rows ?? []).map((row) => ({
              ticker: row.ticker,
              detail: normalizeSymbolDetails(row.detail),
            })),
          });
        },
        error: (err) => {
          this.patchSymbolState(docId, {
            loading: false,
            loaded: true,
            error: formatApiErr(err),
          });
        },
      });
    this.subsSymbol.push(sub);
  }

  symbolViewFor(docId: string): SymbolTableView | null {
    const st = this.symbolState()[docId];
    if (!st) return null;
    const pageRows = this.filteredRows(st);
    return {
      loading: st.loading,
      error: st.error,
      total: st.total,
      offset: st.offset,
      pageRows,
      pageStart: pageRows.length === 0 ? 0 : st.offset + 1,
      pageEnd: st.offset + pageRows.length,
      statusFilter: st.statusFilter,
      search: st.search,
      sortKey: st.sortKey,
      sortDir: st.sortDir,
    };
  }

  private filteredRows(st: SymbolTableState): SymbolRow[] {
    const q = st.search.trim().toUpperCase();
    return st.rows.filter((row) => {
      const sk = this.statusKey(row.detail);
      if (st.statusFilter !== 'all' && sk !== st.statusFilter) {
        return false;
      }
      if (!q) return true;
      const det = row.detail;
      return (
        row.ticker.toUpperCase().includes(q) ||
        String(det.name ?? '')
          .toUpperCase()
          .includes(q) ||
        String(det.sector ?? '')
          .toUpperCase()
          .includes(q) ||
        String(det.country ?? '')
          .toUpperCase()
          .includes(q)
      );
    });
  }
  onSymbolSortHeader(docId: string, key: string): void {
    const st = this.symbolState()[docId];
    if (!st || st.loading) return;
    const sortDir =
      st.sortKey === key ? (st.sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    this.patchSymbolState(docId, { sortKey: key, sortDir, offset: 0 });
    this.loadSymbolPage(docId, 0);
  }

  symbolThClass(docId: string, key: string): Record<string, boolean> {
    const st = this.symbolState()[docId];
    return {
      'sort-asc': !!st && st.sortKey === key && st.sortDir === 'asc',
      'sort-desc': !!st && st.sortKey === key && st.sortDir === 'desc',
    };
  }

  setSymbolStatusFilter(docId: string, raw: string): void {
    const value = raw as UniverseStatusFilter;
    this.patchSymbolState(docId, { statusFilter: value });
  }

  setSymbolSearch(docId: string, value: string): void {
    this.patchSymbolState(docId, { search: value });
  }

  clearSymbolFilters(docId: string): void {
    this.patchSymbolState(docId, { statusFilter: 'all', search: '' });
  }

  symbolFiltersActive(docId: string): boolean {
    const st = this.symbolState()[docId];
    if (!st) return false;
    return st.statusFilter !== 'all' || st.search.trim().length > 0;
  }

  nextSymbolPage(docId: string): void {
    const st = this.symbolState()[docId];
    if (!st || st.loading) return;
    const nextOff = st.offset + SYMBOL_PAGE_SIZE;
    if (nextOff >= st.total) return;
    this.loadSymbolPage(docId, nextOff);
  }

  prevSymbolPage(docId: string): void {
    const st = this.symbolState()[docId];
    if (!st || st.loading || st.offset <= 0) return;
    this.loadSymbolPage(docId, Math.max(0, st.offset - SYMBOL_PAGE_SIZE));
  }

  canNextSymbols(docId: string): boolean {
    const st = this.symbolState()[docId];
    if (!st || st.loading) return false;
    return st.offset + SYMBOL_PAGE_SIZE < st.total;
  }

  canPrevSymbols(docId: string): boolean {
    const st = this.symbolState()[docId];
    if (!st || st.loading) return false;
    return st.offset > 0;
  }

  fmtMarketCapMillions(millions: number | null | undefined): string {
    if (millions == null || !Number.isFinite(Number(millions))) return '—';
    const m = Number(millions);
    if (Math.abs(m) >= 1000) {
      return fmtUiDecimal(m / 1000) + 'B USD';
    }
    return fmtUiDecimal(m) + 'M USD';
  }

  fmtUniverseScore(score: number | null | undefined): string {
    if (score == null || !Number.isFinite(Number(score))) return '—';
    const s = Number(score);
    if (s >= 0 && s <= 1.0 + 1e-9) {
      return fmtUiPercent(s * 100) + '%';
    }
    return fmtUiDecimal(s);
  }

  fmtConfidence(c: number | null | undefined): string {
    if (c == null || !Number.isFinite(Number(c))) return '—';
    return String(Math.round(Number(c)));
  }

  statusKey(det: UniverseSymbolDetail | null | undefined): UniverseStatusKey {
    if (!det) return 'unknown';
    const raw = String(det.status ?? '').trim().toLowerCase();
    if (raw === 'active') return 'active';
    if (raw === 'inactive_failed') return 'inactive_failed';
    if (raw === 'inactive_low_conf') return 'inactive_low_conf';
    if (raw === 'inactive_stale') return 'inactive_stale';
    if (raw === 'inactive_capped') return 'inactive_capped';
    if (det.active === true) return 'active';
    if (det.active === false) return 'unknown';
    return 'active';
  }

  statusLabel(key: UniverseStatusKey): string {
    return STATUS_LABELS[key] ?? STATUS_LABELS.unknown;
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    for (const s of this.subsSymbol) {
      s.unsubscribe();
    }
  }
}
