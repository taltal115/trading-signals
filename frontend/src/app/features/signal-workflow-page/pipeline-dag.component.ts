import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { PipelineGraph, PipelineNode, PipelineNodeStatus } from '../../core/pipeline-lifecycle.types';

@Component({
  selector: 'app-pipeline-dag',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './pipeline-dag.component.html',
  styleUrl: './pipeline-dag.component.css',
})
export class PipelineDagComponent {
  @Input({ required: true }) graph!: PipelineGraph;
  @Input() selectedId: string | null = null;
  @Output() readonly nodeSelect = new EventEmitter<PipelineNode>();

  statusIcon(status: PipelineNodeStatus): string {
    switch (status) {
      case 'passed':
        return '✓';
      case 'failed':
        return '✕';
      case 'skipped':
        return '↷';
      case 'pending':
        return '…';
      case 'degraded':
        return '!';
      default:
        return '–';
    }
  }

  onNodeClick(node: PipelineNode): void {
    this.nodeSelect.emit(node);
  }

  trackNode(_i: number, n: PipelineNode): string {
    return n.id;
  }
}
