import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { formatApiErr } from './api-errors';
import { environment } from '../../environments/environment';

export interface MonitorCheckRow {
  id: string;
  data: Record<string, unknown>;
}

export type MonitorTagFilter = 'all' | 'WAIT' | 'SELL';
export type MonitorAiAdviceFilter = 'all' | 'has' | 'none';

export interface MonitorPageResult {
  rows: MonitorCheckRow[];
  nextCursor: string | null;
}

@Injectable({ providedIn: 'root' })
export class MonitorStoreService {
  private readonly http = inject(HttpClient);
  private uid: string | null = null;

  readonly rows$ = new BehaviorSubject<MonitorCheckRow[]>([]);
  readonly error$ = new BehaviorSubject<string | null>(null);
  readonly loading$ = new BehaviorSubject<boolean>(false);
  /** True once an authenticated uid is bound (page drives fetches). */
  readonly ready$ = new BehaviorSubject<boolean>(false);

  start(uid: string): void {
    if (this.uid === uid && this.ready$.value) return;
    this.uid = uid;
    this.ready$.next(true);
  }

  stop(): void {
    this.uid = null;
    this.ready$.next(false);
    this.rows$.next([]);
    this.error$.next(null);
    this.loading$.next(false);
  }

  fetchPage(opts: {
    limit: number;
    cursor?: string;
    tag: MonitorTagFilter;
    aiAdvice: MonitorAiAdviceFilter;
  }): Observable<MonitorPageResult> {
    if (!this.uid) {
      return of({ rows: [], nextCursor: null });
    }
    this.loading$.next(true);
    let params = new HttpParams()
      .set('limit', String(opts.limit))
      .set('tag', opts.tag)
      .set('aiAdvice', opts.aiAdvice);
    if (opts.cursor) {
      params = params.set('cursor', opts.cursor);
    }
    const base = environment.apiBaseUrl;
    return new Observable<MonitorPageResult>((subscriber) => {
      const sub = this.http
        .get<{
          docs: { id: string; data: Record<string, unknown> }[];
          nextCursor?: string | null;
        }>(`${base}/api/monitor/checks`, { params })
        .subscribe({
          next: (r) => {
            this.error$.next(null);
            this.loading$.next(false);
            const rows = (r.docs ?? []).map((d) => ({ id: d.id, data: d.data }));
            this.rows$.next(rows);
            subscriber.next({ rows, nextCursor: r.nextCursor ?? null });
            subscriber.complete();
          },
          error: (err) => {
            this.error$.next(formatApiErr(err));
            this.loading$.next(false);
            this.rows$.next([]);
            subscriber.next({ rows: [], nextCursor: null });
            subscriber.complete();
          },
        });
      return () => sub.unsubscribe();
    });
  }
}
