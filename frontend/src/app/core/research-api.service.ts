import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export type ResearchRunRow = {
  id: string;
  data: Record<string, unknown>;
};

@Injectable({ providedIn: 'root' })
export class ResearchApiService {
  private readonly http = inject(HttpClient);

  private url(path: string): string {
    const base = environment.apiBaseUrl.replace(/\/$/, '');
    return `${base}/api/research${path}`;
  }

  async listRuns(limit = 30): Promise<ResearchRunRow[]> {
    const res = await firstValueFrom(
      this.http.get<{ rows: ResearchRunRow[] }>(this.url(`/runs?limit=${limit}`), {
        withCredentials: true,
      }),
    );
    return res.rows || [];
  }

  async getRun(id: string): Promise<ResearchRunRow> {
    return firstValueFrom(
      this.http.get<ResearchRunRow>(this.url(`/runs/${encodeURIComponent(id)}`), {
        withCredentials: true,
      }),
    );
  }
}
