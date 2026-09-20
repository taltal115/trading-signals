import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type { PipelineGraph } from './pipeline-lifecycle.types';

export interface NewsArticleItem {
  title: string;
  url: string;
  source?: string;
  publishedAt?: string;
}

export interface NewsArticlesResponse {
  ticker: string;
  provider: string;
  articles: NewsArticleItem[];
  browseUrl?: string;
  message?: string;
}

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

  fetchNewsArticles(opts: {
    ticker: string;
    provider: string;
  }): Observable<NewsArticlesResponse> {
    const params = new HttpParams()
      .set('ticker', opts.ticker)
      .set('provider', opts.provider);
    const base = environment.apiBaseUrl;
    return this.http.get<NewsArticlesResponse>(`${base}/api/signals/news-articles`, {
      params,
    });
  }
}
