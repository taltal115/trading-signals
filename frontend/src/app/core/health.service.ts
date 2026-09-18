import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject, catchError, tap, of } from 'rxjs';
import { environment } from '../../environments/environment';
import { formatApiErr } from './api-errors';

export type HealthStatusLevel = 'healthy' | 'degraded' | 'down' | 'not_configured';

export interface IntegrationHealth {
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

  fetchStatus(): void {
    this.loading$.next(true);
    this.error$.next(null);
    
    const base = environment.apiBaseUrl;
    this.http.get<HealthStatusResponse>(`${base}/api/health/status`)
      .pipe(
        tap((response) => {
          this.status$.next(response);
          this.loading$.next(false);
        }),
        catchError((err) => {
          this.error$.next(formatApiErr(err));
          this.loading$.next(false);
          return of(null);
        })
      )
      .subscribe();
  }

  getHealthyCount(category: CategoryHealth): number {
    return category.integrations.filter(i => i.status === 'healthy').length;
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
      case 'healthy': return '✅';
      case 'degraded': return '⚠️';
      case 'down': return '❌';
      case 'not_configured': return '⚠️';
    }
  }

  getStatusClass(status: HealthStatusLevel): string {
    switch (status) {
      case 'healthy': return 'status-healthy';
      case 'degraded': return 'status-degraded';
      case 'down': return 'status-down';
      case 'not_configured': return 'status-not-configured';
    }
  }
}
