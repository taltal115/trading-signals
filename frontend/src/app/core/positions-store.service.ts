import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Subscription, switchMap, catchError, of, tap, EMPTY } from 'rxjs';
import type { PositionRow, PositionData } from './positions-logic';
import { formatApiErr } from './api-errors';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class PositionsStoreService {
  private readonly http = inject(HttpClient);
  private sub: Subscription | null = null;

  readonly rows$ = new BehaviorSubject<PositionRow[]>([]);
  readonly error$ = new BehaviorSubject<string | null>(null);
  /** True until the first `/api/positions` response (success or error) after `start()`. */
  readonly loading$ = new BehaviorSubject<boolean>(false);

  /** `uid` unused — server uses session; kept for call-site compatibility. */
  start(_uid: string): void {
    this.stop();
    this.error$.next(null);
    this.loading$.next(true);
    const base = environment.apiBaseUrl;
    this.sub = of(0)
      .pipe(
        switchMap(() =>
          this.http.get<{ docs: { id: string; data: PositionData }[] }>(`${base}/api/positions`).pipe(
            tap({ next: () => this.error$.next(null) }),
            catchError((err) => {
              this.error$.next(formatApiErr(err));
              return of({ docs: [] as { id: string; data: PositionData }[] });
            })
          )
        )
      )
      .subscribe((r) => {
        this.loading$.next(false);
        const docs = r.docs ?? [];
        this.rows$.next(docs.map((d) => ({ id: d.id, data: d.data })));
      });
  }

  /** Re-fetch positions without clearing the list or showing initial loading. */
  refetch(): void {
    const base = environment.apiBaseUrl;
    this.http
      .get<{ docs: { id: string; data: PositionData }[] }>(`${base}/api/positions`)
      .pipe(
        tap({ next: () => this.error$.next(null) }),
        catchError((err) => {
          this.error$.next(formatApiErr(err));
          return EMPTY;
        })
      )
      .subscribe((r) => {
        const docs = r.docs ?? [];
        this.rows$.next(docs.map((d) => ({ id: d.id, data: d.data })));
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
