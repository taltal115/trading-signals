import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, catchError, of, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { formatApiErr } from './api-errors';

export type HealthStatusLevel = 'healthy' | 'degraded' | 'down' | 'not_configured';

export interface IntegrationHealth {
  id: string;
  name: string;
  key: string;
  status: HealthStatusLevel;
  responseTime?: number;
  lastChecked: string;
  message: string;
  isPaid?: boolean;
}

export interface CategoryHealth {
  name: string;
  critical: boolean;
  integrations: IntegrationHealth[];
}

export interface HealthStatusResponse {
  timestamp: string;
  categories: CategoryHealth[];
}

@Injectable({ providedIn: 'root' })
export class HealthService {
  private readonly http = inject(HttpClient);

  readonly loading$ = new BehaviorSubject<boolean>(false);
  readonly error$ = new BehaviorSubject<string | null>(null);
  readonly status$ = new BehaviorSubject<HealthStatusResponse | null>(null);

  /** Provider ids currently being re-checked. */
  readonly refreshingIds = signal<Record<string, boolean>>({});

  fetchStatus(): void {
    this.loading$.next(true);
    this.error$.next(null);

    const base = environment.apiBaseUrl;
    this.http
      .get<HealthStatusResponse>(`${base}/api/health/status`)
      .pipe(
        tap((response) => {
          this.status$.next(response);
          this.loading$.next(false);
        }),
        catchError((err) => {
          this.error$.next(formatApiErr(err));
          this.loading$.next(false);
          return of(null);
        }),
      )
      .subscribe();
  }

  /** Re-check one provider and patch it into the current status snapshot. */
  refreshProvider(id: string): void {
    const pid = String(id || '').trim();
    if (!pid || this.refreshingIds()[pid]) return;

    this.refreshingIds.update((m) => ({ ...m, [pid]: true }));
    const base = environment.apiBaseUrl;
    this.http
      .get<IntegrationHealth>(`${base}/api/health/status/${encodeURIComponent(pid)}`)
      .pipe(
        tap((updated) => {
          const cur = this.status$.value;
          if (cur) {
            const categories = cur.categories.map((cat) => ({
              ...cat,
              integrations: cat.integrations.map((i) =>
                (i.id || this.slugFromName(i.name)) === updated.id ? updated : i,
              ),
            }));
            this.status$.next({
              ...cur,
              timestamp: new Date().toISOString(),
              categories,
            });
          }
          this.refreshingIds.update((m) => {
            const next = { ...m };
            delete next[pid];
            return next;
          });
        }),
        catchError((err) => {
          this.error$.next(formatApiErr(err));
          this.refreshingIds.update((m) => {
            const next = { ...m };
            delete next[pid];
            return next;
          });
          return of(null);
        }),
      )
      .subscribe();
  }

  isRefreshing(id: string): boolean {
    return !!this.refreshingIds()[id];
  }

  /** Fallback when older API payloads lack `id`. */
  slugFromName(name: string): string {
    const n = String(name || '').toLowerCase();
    if (n.includes('polygon') || n.includes('massive')) return 'polygon';
    if (n.includes('yahoo')) return 'yahoo';
    if (n.includes('stooq')) return 'stooq';
    if (n.includes('finnhub')) return 'finnhub';
    if (n.includes('newsapi')) return 'newsapi';
    if (n.includes('gdelt')) return 'gdelt';
    if (n.includes('openai')) return 'openai';
    if (n.includes('fred')) return 'fred';
    if (n.includes('firestore')) return 'firestore';
    if (n.includes('sqlite')) return 'sqlite';
    if (n.includes('slack')) return 'slack';
    if (n.includes('ibkr')) return 'ibkr';
    return n.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  providerId(integration: IntegrationHealth): string {
    return integration.id || this.slugFromName(integration.name);
  }

  getHealthyCount(category: CategoryHealth): number {
    return category.integrations.filter((i) => i.status === 'healthy').length;
  }

  getTotalCount(category: CategoryHealth): number {
    return category.integrations.length;
  }

  getCategoryIcon(category: CategoryHealth): string {
    const healthyCount = this.getHealthyCount(category);
    const totalCount = this.getTotalCount(category);

    if (healthyCount === totalCount) return '🟢';
    if (healthyCount === 0) return '🔴';
    return '🟡';
  }

  getStatusIcon(status: HealthStatusLevel): string {
    switch (status) {
      case 'healthy':
        return '✅';
      case 'degraded':
        return '⚠️';
      case 'down':
        return '❌';
      case 'not_configured':
        return '⚠️';
    }
  }

  getStatusClass(status: HealthStatusLevel): string {
    switch (status) {
      case 'healthy':
        return 'status-healthy';
      case 'degraded':
        return 'status-degraded';
      case 'down':
        return 'status-down';
      case 'not_configured':
        return 'status-not-configured';
    }
  }
}
