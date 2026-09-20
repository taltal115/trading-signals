import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { SignalLifecycleService } from '../../core/signal-lifecycle.service';
import { formatApiErr } from '../../core/api-errors';
import type { PipelineGraph, PipelineNode } from '../../core/pipeline-lifecycle.types';
import { PipelineDagComponent } from './pipeline-dag.component';
import { PipelineDrawerComponent } from './pipeline-drawer.component';

@Component({
  selector: 'app-signal-workflow-page',
  standalone: true,
  imports: [CommonModule, RouterLink, PipelineDagComponent, PipelineDrawerComponent],
  templateUrl: './signal-workflow-page.component.html',
  styleUrl: './signal-workflow-page.component.css',
})
export class SignalWorkflowPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly lifecycle = inject(SignalLifecycleService);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly graph = signal<PipelineGraph | null>(null);
  readonly selected = signal<PipelineNode | null>(null);

  ngOnInit(): void {
    const docId = String(this.route.snapshot.paramMap.get('docId') || '').trim();
    const ticker = String(this.route.snapshot.paramMap.get('ticker') || '')
      .trim()
      .toUpperCase();
    const indexRaw = this.route.snapshot.queryParamMap.get('index');
    let index: number | undefined;
    if (indexRaw != null && indexRaw !== '') {
      const n = Number.parseInt(indexRaw, 10);
      if (Number.isFinite(n) && n >= 0) index = n;
    }
    if (!docId || !ticker) {
      this.loading.set(false);
      this.error.set('Missing docId or ticker in the URL.');
      return;
    }
    this.lifecycle.fetchLifecycle({ docId, ticker, index }).subscribe({
      next: (g) => {
        this.graph.set(g);
        this.loading.set(false);
        const fail = g.failPoint
          ? g.nodes.find((n) => n.id === g.failPoint)
          : null;
        const firstInteresting =
          fail ||
          g.nodes.find((n) => n.status === 'pending') ||
          g.nodes.find((n) => n.id === 'ai_gate') ||
          g.nodes[0] ||
          null;
        this.selected.set(firstInteresting);
      },
      error: (err) => {
        this.error.set(formatApiErr(err));
        this.loading.set(false);
      },
    });
  }

  onSelect(node: PipelineNode): void {
    this.selected.set(node);
  }

  clearSelected(): void {
    this.selected.set(null);
  }

  gateClass(gate: string): string {
    const g = (gate || '').toLowerCase();
    if (g === 'passed') return 'gate-passed';
    if (g === 'filtered') return 'gate-filtered';
    if (g === 'skipped') return 'gate-skipped';
    return 'gate-pending';
  }

  fmtNum(v: number | null | undefined, digits = 2): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toFixed(digits);
  }
}
