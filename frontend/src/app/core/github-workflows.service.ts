import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

/**
 * Dispatches GitHub Actions via Nest (`GITHUB_PERSONAL_TOKEN` server-side only).
 */
@Injectable({ providedIn: 'root' })
export class GithubWorkflowsService {
  private readonly http = inject(HttpClient);

  private url(path: string): string {
    const base = environment.apiBaseUrl.replace(/\/$/, '');
    return `${base}/api/github${path}`;
  }

  async triggerMonitorWorkflow(ticker: string): Promise<void> {
    await firstValueFrom(
      this.http.post<{ ok: boolean }>(this.url('/workflows/position-monitor'), {
        ticker: String(ticker || '').trim(),
      }),
    );
  }

  async triggerProfitHoldResearch(body: {
    since: string;
    until?: string;
    actionable_only?: boolean;
    include_immature?: boolean;
    limit_runs?: number;
    notify_slack?: boolean;
  }): Promise<{ ok: boolean; run_id: string }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean; run_id: string }>(
        this.url('/workflows/profit-hold-research'),
        body,
        { withCredentials: true },
      ),
    );
  }
}
