import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GithubWorkflowsService } from '../../core/github-workflows.service';
import { ResearchApiService, type ResearchRunRow } from '../../core/research-api.service';
import { ResearchDueBadgeService } from '../../core/research-due-badge.service';

type CoaItem = {
  priority?: string;
  title?: string;
  rationale?: string;
  suggested_changes?: {
    path?: string;
    knob?: string;
    from?: unknown;
    to?: unknown;
    note?: string;
  }[];
};

@Component({
  selector: 'app-research-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './research-page.component.html',
  styleUrl: './research-page.component.css',
})
export class ResearchPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(ResearchApiService);
  private readonly workflows = inject(GithubWorkflowsService);
  readonly dueBadge = inject(ResearchDueBadgeService);

  readonly loading = signal(true);
  readonly running = signal(false);
  readonly error = signal('');
  readonly runs = signal<ResearchRunRow[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly selected = signal<ResearchRunRow | null>(null);

  since = '2026-08-04';
  until = '';
  actionableOnly = false;
  includeImmature = false;
  limitRuns = 200;
  notifySlack = true;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly summary = computed(() => {
    const d = this.selected()?.data;
    const s = d?.['summary'];
    return s && typeof s === 'object' ? (s as Record<string, unknown>) : null;
  });

  readonly overall = computed(() => {
    const s = this.summary()?.['overall_at_hold'];
    return s && typeof s === 'object' ? (s as Record<string, unknown>) : null;
  });

  readonly coa = computed(() => {
    const d = this.selected()?.data;
    const c = d?.['course_of_action'];
    return c && typeof c === 'object' ? (c as Record<string, unknown>) : null;
  });

  readonly coaItems = computed((): CoaItem[] => {
    const items = this.coa()?.['items'];
    return Array.isArray(items) ? (items as CoaItem[]) : [];
  });

  readonly nextResearch = computed(() => {
    const d = this.selected()?.data;
    const n = d?.['next_research'] || this.coa()?.['next_research'];
    return n && typeof n === 'object' ? (n as Record<string, unknown>) : null;
  });

  readonly winners = computed(() => {
    const w = this.summary()?.['top_winners'];
    return Array.isArray(w) ? (w as Record<string, unknown>[]) : [];
  });

  readonly losers = computed(() => {
    const w = this.summary()?.['top_losers'];
    return Array.isArray(w) ? (w as Record<string, unknown>[]) : [];
  });

  readonly gateSlices = computed(() => {
    const g = this.summary()?.['by_ai_gate'];
    return Array.isArray(g) ? (g as Record<string, unknown>[]) : [];
  });

  async ngOnInit(): Promise<void> {
    await this.reloadList();
  }

  ngOnDestroy(): void {
    this.stopPoll();
  }

  async reloadList(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const rows = await this.api.listRuns(40);
      this.runs.set(rows);
      const first = rows[0];
      if (first) {
        const due =
          (first.data['next_research'] as { due_date?: string } | undefined)?.due_date ||
          null;
        this.dueBadge.refreshFromDue(due);
        if (!this.selectedId()) {
          await this.selectRun(first.id);
        } else {
          const still = rows.find((r) => r.id === this.selectedId());
          if (still) await this.selectRun(still.id);
        }
      }
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  async selectRun(id: string): Promise<void> {
    this.selectedId.set(id);
    try {
      const row = await this.api.getRun(id);
      this.selected.set(row);
      const due =
        (row.data['next_research'] as { due_date?: string } | undefined)?.due_date || null;
      this.dueBadge.refreshFromDue(due);
      const st = String(row.data['status'] || '');
      if (st === 'queued' || st === 'running') {
        this.startPoll(id);
      } else {
        this.stopPoll();
      }
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  async runResearch(): Promise<void> {
    this.running.set(true);
    this.error.set('');
    try {
      const res = await this.workflows.triggerProfitHoldResearch({
        since: this.since.trim(),
        until: this.until.trim() || undefined,
        actionable_only: this.actionableOnly,
        include_immature: this.includeImmature,
        limit_runs: this.limitRuns,
        notify_slack: this.notifySlack,
      });
      this.selectedId.set(res.run_id);
      await this.reloadList();
      this.startPoll(res.run_id);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.running.set(false);
    }
  }

  ackDue(): void {
    this.dueBadge.acknowledge();
  }

  fmt(v: unknown, digits = 2): string {
    if (v == null || v === '') return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return n.toFixed(digits);
  }

  runParamsLabel(r: ResearchRunRow): string {
    const p = r.data['params'];
    if (!p || typeof p !== 'object') return '';
    const o = p as Record<string, unknown>;
    const since = o['since'] != null ? String(o['since']) : '';
    const actionable = o['actionable_only'] ? ' · actionable' : '';
    return since ? `since ${since}${actionable}` : '';
  }

  private startPoll(id: string): void {
    this.stopPoll();
    this.pollTimer = setInterval(() => {
      void this.pollOnce(id);
    }, 8000);
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(id: string): Promise<void> {
    try {
      const row = await this.api.getRun(id);
      this.selected.set(row);
      const st = String(row.data['status'] || '');
      if (st === 'succeeded' || st === 'failed') {
        this.stopPoll();
        await this.reloadList();
      }
    } catch {
      /* ignore transient poll errors */
    }
  }
}
