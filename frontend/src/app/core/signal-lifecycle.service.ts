import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type { PipelineGraph } from './pipeline-lifecycle.types';

@Injectable({ providedIn: 'root' })
export class SignalLifecycleService {
  private readonly http = inject(HttpClient);

  fetchLifecycle(opts: {
    docId: string;
    ticker: string;
    index?: number;
  }): Observable<PipelineGraph> {
    let params = new HttpParams()
      .set('docId', opts.docId)
      .set('ticker', opts.ticker);
    if (opts.index != null && Number.isFinite(opts.index)) {
      params = params.set('index', String(opts.index));
    }
    const base = environment.apiBaseUrl;
    return this.http.get<PipelineGraph>(`${base}/api/signals/lifecycle`, { params });
  }
}
