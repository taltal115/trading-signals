import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../core/auth.service';
import {
  EventRecommendation,
  EventsApiService,
  StockEventRow,
  StockEventsLatestResponse,
} from '../../core/events-api.service';
import {
  MarketDataService,
  StockSnapshot,
  isProviderQuotaError,
} from '../../core/market-data.service';
import { fmtUiDecimal, fmtUiPercent, fmtUsd } from '../../core/positions-logic';
import { environment } from '../../../environments/environment';
import { EventsEventDetailComponent } from './events-event-detail.component';

type StockDetailState =
  | { expanded: false }
  | { expanded: true; status: 'loading' }
  | { expanded: true; status: 'error'; message: string }
  | { expanded: true; status: 'ok'; data: StockSnapshot };

function daysUntil(eventDate: string): number | null {
  const d = eventDate.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, day] = d.split('-').map(Number);
  const event = new Date(y, m - 1, day);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((event.getTime() - today.getTime()) / 86400000);
  return Number.isFinite(diff) ? diff : null;
}

function snapshotAgeDays(tsUtc: string): number | null {
  if (!tsUtc) return null;
  const t = Date.parse(tsUtc);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function eventRowKey(r: StockEventRow): string {
  return `${r.symbol}|${r.event_date}|${r.event_type}`;
}

const EVENTS_TABLE_PAGE_SIZE = 50;

@Component({
  selector: 'app-events-page',
  standalone: true,
  imports: [CommonModule, EventsEventDetailComponent],
  templateUrl: './events-page.component.html',
  styleUrl: './events-page.component.css',
})
export class EventsPageComponent implements OnInit {
  private readonly eventsApi = inject(EventsApiService);
  private readonly market = inject(MarketDataService);
  readonly authSvc = inject(AuthService);
  readonly env = environment;

  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly snapshot = signal<StockEventsLatestResponse | null>(null);
  readonly stockDetailByRow = signal<Record<string, StockDetailState>>({});

  readonly eventsByKey = computed(() => {
    const map = new Map<string, StockEventRow>();
    for (const e of this.snapshot()?.events ?? []) {
      map.set(eventRowKey(e), e);
    }
    return map;
  });

  readonly recommendations = computed(() => {
    const snap = this.snapshot();
    const recs = snap?.recommendations ?? [];
    return [...recs].sort((a, b) => a.rank - b.rank);
  });

  readonly recommendedKeys = computed(() => {
    const keys = new Set<string>();
    for (const rec of this.recommendations()) {
      keys.add(`${rec.symbol}|${rec.event_date}|${rec.event_type}`);
    }
    return keys;
  });

  readonly eventsTablePageIndex = signal(0);

  readonly sortedEvents = computed(() => {
    const snap = this.snapshot();
    if (!snap?.events?.length) return [];
    return [...snap.events].sort((a, b) => {
      const sa = a.event_score ?? -1;
      const sb = b.event_score ?? -1;
      if (sb !== sa) return sb - sa;
      const dc = a.event_date.localeCompare(b.event_date);
      if (dc !== 0) return dc;
      return a.symbol.localeCompare(b.symbol);
    });
  });

  readonly eventsTableTotal = computed(() => this.sortedEvents().length);

  readonly eventsTablePageCount = computed(() =>
    Math.max(1, Math.ceil(this.eventsTableTotal() / EVENTS_TABLE_PAGE_SIZE))
  );

  readonly effectiveEventsPageIndex = computed(() => {
    const maxIdx = Math.max(0, this.eventsTablePageCount() - 1);
    return Math.min(this.eventsTablePageIndex(), maxIdx);
  });

  readonly pagedEvents = computed(() => {
    const all = this.sortedEvents();
    const idx = this.effectiveEventsPageIndex();
    const start = idx * EVENTS_TABLE_PAGE_SIZE;
    return all.slice(start, start + EVENTS_TABLE_PAGE_SIZE);
  });

  readonly eventsTablePageStart = computed(() => {
    if (this.eventsTableTotal() === 0) return 0;
    return this.effectiveEventsPageIndex() * EVENTS_TABLE_PAGE_SIZE + 1;
  });

  readonly eventsTablePageEnd = computed(() => {
    const total = this.eventsTableTotal();
    if (total === 0) return 0;
    return Math.min(total, (this.effectiveEventsPageIndex() + 1) * EVENTS_TABLE_PAGE_SIZE);
  });

  readonly canPrevEventsPage = computed(() => this.eventsTablePageIndex() > 0);

  readonly canNextEventsPage = computed(() => {
    const total = this.eventsTableTotal();
    if (total === 0) return false;
    return (this.eventsTablePageIndex() + 1) * EVENTS_TABLE_PAGE_SIZE < total;
  });

  readonly staleHint = computed(() => {
    const snap = this.snapshot();
    if (!snap?.ts_utc) return false;
    const age = snapshotAgeDays(snap.ts_utc);
    return age !== null && age > 2;
  });

  readonly hasPhase2 = computed(() => {
    const snap = this.snapshot();
    return (snap?.source ?? '').includes('v2') || (snap?.recommendations?.length ?? 0) > 0;
  });

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const data = await this.eventsApi.getLatest();
      this.snapshot.set(data);
      this.eventsTablePageIndex.set(0);
    } catch (e) {
      this.loadError.set(e instanceof Error ? e.message : String(e));
      this.snapshot.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  daysUntil(row: StockEventRow | EventRecommendation): number | null {
    return daysUntil(row.event_date);
  }

  formatUniverseScore(score: number): string {
    if (score == null || !Number.isFinite(score)) return '—';
    return (score * 100).toFixed(1);
  }

  formatEventScore(score: number | undefined): string {
    if (score == null || !Number.isFinite(score)) return '—';
    return String(Math.round(score));
  }

  actionClass(action: string | undefined): string {
    const a = (action || '').toUpperCase();
    if (a === 'SETUP') return 'tag-buy';
    if (a === 'WATCH') return 'tag-wait';
    if (a === 'AVOID') return 'tag-sell';
    return '';
  }

  isRecommended(row: StockEventRow): boolean {
    return this.recommendedKeys().has(eventRowKey(row));
  }

  recRowKey(rec: EventRecommendation): string {
    return `${rec.symbol}|${rec.event_date}|${rec.event_type}`;
  }

  eventForKey(key: string): StockEventRow | null {
    return this.eventsByKey().get(key) ?? null;
  }

  eventForRec(rec: EventRecommendation): StockEventRow {
    const found = this.eventForKey(this.recRowKey(rec));
    if (found) return found;
    return {
      symbol: rec.symbol,
      event_type: rec.event_type,
      event_date: rec.event_date,
      event_time: null,
      title: '',
      eps_estimate: null,
      revenue_estimate: null,
      last_score: 0,
      last_confidence: null,
      data_source: 'recommendation',
      event_score: rec.event_score,
      bias: rec.bias,
      action: rec.action,
      reasons: rec.reasons,
    };
  }

  toggleInfo(rowKey: string, symbol: string): void {
    const cur = this.stockDetailByRow()[rowKey];
    if (cur?.expanded) {
      this.stockDetailByRow.update((m) => ({ ...m, [rowKey]: { expanded: false } }));
      return;
    }
    const sym = symbol.trim().toUpperCase();
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
      .catch((e) => {
        const msg = isProviderQuotaError(e)
          ? 'Market data temporarily unavailable (rate limit). Event context below is still available.'
          : e instanceof Error
            ? e.message
            : String(e);
        this.stockDetailByRow.update((m) => ({
          ...m,
          [rowKey]: { expanded: true, status: 'error', message: msg },
        }));
      });
  }

  infoOpen(rowKey: string): boolean {
    return !!this.stockDetailByRow()[rowKey]?.expanded;
  }

  infoLoading(rowKey: string): boolean {
    const e = this.stockDetailByRow()[rowKey];
    return !!e?.expanded && e.status === 'loading';
  }

  infoError(rowKey: string): string | null {
    const e = this.stockDetailByRow()[rowKey];
    return e?.expanded && e.status === 'error' ? e.message : null;
  }

  infoSnapshot(rowKey: string): StockSnapshot | null {
    const e = this.stockDetailByRow()[rowKey];
    return e?.expanded && e.status === 'ok' ? e.data : null;
  }

  recommendationForEvent(row: StockEventRow): EventRecommendation | null {
    const key = eventRowKey(row);
    return this.recommendations().find((r) => this.recRowKey(r) === key) ?? null;
  }

  fmtPct(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return (v >= 0 ? '+' : '') + fmtUiPercent(v) + '%';
  }

  fmtNum(v: number | null | undefined, digits = 2): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return fmtUiDecimal(v);
  }

  fmtLarge(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return '—';
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
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

  fmtUnixQuoteUtc(sec: number | null): string {
    if (sec == null || !Number.isFinite(sec)) return '—';
    return new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }

  protected readonly fmtUsd = fmtUsd;

  prevEventsPage(): void {
    if (this.canPrevEventsPage()) {
      this.eventsTablePageIndex.update((i) => i - 1);
    }
  }

  nextEventsPage(): void {
    if (this.canNextEventsPage()) {
      this.eventsTablePageIndex.update((i) => i + 1);
    }
  }

  trackEvent = (_: number, r: StockEventRow) => eventRowKey(r);
  trackRec = (_: number, r: EventRecommendation) => r.rank;
}
