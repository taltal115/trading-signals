import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../core/auth.service';
import {
  EventRecommendation,
  EventsApiService,
  StockEventRow,
  StockEventsLatestResponse,
} from '../../core/events-api.service';
import { environment } from '../../../environments/environment';

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

@Component({
  selector: 'app-events-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './events-page.component.html',
  styleUrl: './events-page.component.css',
})
export class EventsPageComponent implements OnInit {
  private readonly eventsApi = inject(EventsApiService);
  readonly authSvc = inject(AuthService);
  readonly env = environment;

  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly snapshot = signal<StockEventsLatestResponse | null>(null);

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

  trackEvent = (_: number, r: StockEventRow) => eventRowKey(r);
  trackRec = (_: number, r: EventRecommendation) => r.rank;
}
