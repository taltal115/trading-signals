import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Subscription, switchMap, catchError, of, tap } from 'rxjs';
import { formatApiErr } from './api-errors';
import { environment } from '../../environments/environment';

export interface MonitorCheckRow {
  id: string;
  data: Record<string, unknown>;
}

@Injectable({ providedIn: 'root' })
export class MonitorStoreService {
  private readonly http = inject(HttpClient);
  private sub: Subscription | null = null;

  readonly rows$ = new BehaviorSubject<MonitorCheckRow[]>([]);
  readonly error$ = new BehaviorSubject<string | null>(null);
  readonly loading$ = new BehaviorSubject<boolean>(false);

  start(_uid: string): void {
    this.stop();
    this.loading$.next(true);
    const base = environment.apiBaseUrl;
    this.sub = of(0)
      .pipe(
        switchMap(() =>
          this.http
            .get<{ docs: { id: string; data: Record<string, unknown> }[] }>(`${base}/api/monitor/checks`)
            .pipe(
              tap({ next: () => this.error$.next(null) }),
              catchError((err) => {
                this.error$.next(formatApiErr(err));
                return of({ docs: [] });
              })
            )
        )
      )
      .subscribe((r) => {
        this.loading$.next(false);
        this.rows$.next((r.docs ?? []).map((d) => ({ id: d.id, data: d.data })));
      });
  }

  stop(): void {
    this.sub?.unsubscribe();
    this.sub = null;
    this.rows$.next([]);
    this.error$.next(null);
    this.loading$.next(false);
  }
}
