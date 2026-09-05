import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AiAggChartComponent } from '../ai-agg-chart/ai-agg-chart.component';
import type { AiChartRow } from '../../core/ai-analytics-chart.util';

type AggRow = { key: string; requests: number; tokens: number; cost: number };
type EvalRow = Record<string, unknown>;
type TableSortKey = 'ts_utc' | 'stage' | 'ticker' | 'decision' | 'model' | 'tokens' | 'cost';
type SortDir = 'asc' | 'desc';

const TABLE_PAGE_SIZES = [10, 25, 50] as const;

function toChartRows(rows: AggRow[]): AiChartRow[] {
  return rows.map((r) => ({
    label: r.key,
    requests: r.requests,
    tokens: r.tokens,
    cost: r.cost,
  }));
}

function rowStr(r: EvalRow, key: string): string {
  return String(r[key] ?? '').trim();
}

function rowDay(r: EvalRow): string {
  return rowStr(r, 'ts_utc').slice(0, 10);
}

@Component({
  selector: 'app-ai-analytics-page',
  standalone: true,
  imports: [CommonModule, AiAggChartComponent],
  templateUrl: './ai-analytics-page.component.html',
  styleUrl: './ai-analytics-page.component.css',
})
export class AiAnalyticsPageComponent implements OnInit {
  private readonly http = inject(HttpClient);

  readonly pageSizeOptions = TABLE_PAGE_SIZES;
  readonly loading = signal(true);
  readonly error = signal('');
  readonly rows = signal<EvalRow[]>([]);

  readonly filterStage = signal('all');
  readonly filterDecision = signal('all');
  readonly filterTicker = signal('');
  readonly filterFrom = signal('');
  readonly filterTo = signal('');

  readonly tableQuery = signal('');
  readonly tableSortKey = signal<TableSortKey>('ts_utc');
  readonly tableSortDir = signal<SortDir>('desc');
  readonly pageSize = signal<(typeof TABLE_PAGE_SIZES)[number]>(50);
  readonly pageIndex = signal(0);

  readonly stageOptions = computed(() => {
    const set = new Set<string>();
    for (const r of this.rows()) {
      const s = rowStr(r, 'stage');
      if (s) set.add(s);
    }
    return ['all', ...[...set].sort()];
  });

  readonly decisionOptions = computed(() => {
    const set = new Set<string>();
    for (const r of this.rows()) {
      const s = rowStr(r, 'decision');
      if (s) set.add(s);
    }
    return ['all', ...[...set].sort()];
  });

  readonly filteredRows = computed(() => {
    const stage = this.filterStage();
    const decision = this.filterDecision();
    const ticker = this.filterTicker().trim().toUpperCase();
    const from = this.filterFrom();
    const to = this.filterTo();
    return this.rows().filter((r) => {
      if (stage !== 'all' && rowStr(r, 'stage') !== stage) return false;
      if (decision !== 'all' && rowStr(r, 'decision') !== decision) return false;
      if (ticker && !rowStr(r, 'ticker').toUpperCase().includes(ticker)) return false;
      const day = rowDay(r);
      if (from && day && day < from) return false;
      if (to && day && day > to) return false;
      return true;
    });
  });

  readonly totals = computed(() => {
    let requests = 0;
    let tokens = 0;
    let cost = 0;
    for (const r of this.filteredRows()) {
      requests += 1;
      tokens += Number(r['total_tokens'] || 0) || 0;
      cost += Number(r['estimated_cost_usd'] || 0) || 0;
    }
    return { requests, tokens, cost };
  });

  readonly byStage = computed(() => this.aggregate(this.filteredRows(), 'stage'));
  readonly byTicker = computed(() => this.aggregate(this.filteredRows(), 'ticker'));
  readonly byStageChart = computed(() => toChartRows(this.byStage()));
  readonly byDayChart = computed(() =>
    toChartRows([...this.byDay()].sort((a, b) => a.key.localeCompare(b.key)))
  );
  readonly byTickerChart = computed(() => toChartRows(this.byTicker()));
  readonly byDay = computed(() => {
    const map = new Map<string, AggRow>();
    for (const r of this.filteredRows()) {
      const day = rowDay(r) || 'unknown';
      const cur = map.get(day) || { key: day, requests: 0, tokens: 0, cost: 0 };
      cur.requests += 1;
      cur.tokens += Number(r['total_tokens'] || 0) || 0;
      cur.cost += Number(r['estimated_cost_usd'] || 0) || 0;
      map.set(day, cur);
    }
    return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
  });

  readonly tableRows = computed(() => {
    const q = this.tableQuery().trim().toLowerCase();
    const rows = q
      ? this.filteredRows().filter((r) => {
          const blob = [
            r['ts_utc'],
            r['stage'],
            r['ticker'],
            r['decision'],
            r['model'],
            r['total_tokens'],
            r['estimated_cost_usd'],
          ]
            .map((v) => String(v ?? '').toLowerCase())
            .join(' ');
          return blob.includes(q);
        })
      : this.filteredRows();
    const key = this.tableSortKey();
    const dir = this.tableSortDir() === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => dir * this.compareRows(a, b, key));
  });

  readonly tableTotal = computed(() => this.tableRows().length);
  readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.tableTotal() / this.pageSize()))
  );
  readonly pageLabel = computed(() => `${this.pageIndex() + 1} / ${this.pageCount()}`);
  readonly canPrevPage = computed(() => this.pageIndex() > 0);
  readonly canNextPage = computed(() => this.pageIndex() + 1 < this.pageCount());
  readonly pagedRows = computed(() => {
    const size = this.pageSize();
    const start = this.pageIndex() * size;
    return this.tableRows().slice(start, start + size);
  });

  asNum(v: unknown): number | null {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  setStage(v: string): void {
    this.filterStage.set(v);
    this.pageIndex.set(0);
  }

  setDecision(v: string): void {
    this.filterDecision.set(v);
    this.pageIndex.set(0);
  }

  setTicker(v: string): void {
    this.filterTicker.set(v);
    this.pageIndex.set(0);
  }

  setFrom(v: string): void {
    this.filterFrom.set(v);
    this.pageIndex.set(0);
  }

  setTo(v: string): void {
    this.filterTo.set(v);
    this.pageIndex.set(0);
  }

  setTableQuery(v: string): void {
    this.tableQuery.set(v);
    this.pageIndex.set(0);
  }

  resetFilters(): void {
    this.filterStage.set('all');
    this.filterDecision.set('all');
    this.filterTicker.set('');
    this.filterFrom.set('');
    this.filterTo.set('');
    this.tableQuery.set('');
    this.pageIndex.set(0);
  }

  onPageSizeChange(raw: string): void {
    const n = Number(raw);
    if (n !== 10 && n !== 25 && n !== 50) return;
    this.pageSize.set(n);
    this.pageIndex.set(0);
  }

  prevPage(): void {
    if (this.canPrevPage()) this.pageIndex.update((i) => i - 1);
  }

  nextPage(): void {
    if (this.canNextPage()) this.pageIndex.update((i) => i + 1);
  }

  toggleSort(key: TableSortKey): void {
    if (this.tableSortKey() === key) {
      this.tableSortDir.set(this.tableSortDir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.tableSortKey.set(key);
      this.tableSortDir.set(key === 'ts_utc' || key === 'tokens' || key === 'cost' ? 'desc' : 'asc');
    }
    this.pageIndex.set(0);
  }

  sortClass(key: TableSortKey): Record<string, boolean> {
    return {
      'sort-asc': this.tableSortKey() === key && this.tableSortDir() === 'asc',
      'sort-desc': this.tableSortKey() === key && this.tableSortDir() === 'desc',
    };
  }

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const base = environment.apiBaseUrl || '';
      const res = await firstValueFrom(
        this.http.get<{ rows: { id: string; data: Record<string, unknown> }[] }>(
          `${base}/api/signals/ai-evals/recent?limit=300`,
          { withCredentials: true }
        )
      );
      this.rows.set((res.rows || []).map((r) => ({ id: r.id, ...r.data })));
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  private compareRows(a: EvalRow, b: EvalRow, key: TableSortKey): number {
    if (key === 'tokens') {
      return (Number(a['total_tokens']) || 0) - (Number(b['total_tokens']) || 0);
    }
    if (key === 'cost') {
      return (Number(a['estimated_cost_usd']) || 0) - (Number(b['estimated_cost_usd']) || 0);
    }
    return rowStr(a, key === 'ts_utc' ? 'ts_utc' : key).localeCompare(
      rowStr(b, key === 'ts_utc' ? 'ts_utc' : key)
    );
  }

  private aggregate(source: EvalRow[], field: string): AggRow[] {
    const map = new Map<string, AggRow>();
    for (const r of source) {
      const key = String(r[field] || 'unknown');
      const cur = map.get(key) || { key, requests: 0, tokens: 0, cost: 0 };
      cur.requests += 1;
      cur.tokens += Number(r['total_tokens'] || 0) || 0;
      cur.cost += Number(r['estimated_cost_usd'] || 0) || 0;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.requests - a.requests);
  }
}
