/** Mirrored from backend/src/signals/dto/pipeline-lifecycle.dto.ts */

export type PipelineNodeStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'pending'
  | 'not_run'
  | 'degraded';

export type PipelineStageId =
  | 'universe'
  | 'scan'
  | 'hard_filters'
  | 'entry_queue'
  | 'news_context'
  | 'ai_entry'
  | 'ai_gate'
  | 'paper'
  | 'holding'
  | 'outcome';

export type PipelineTraceSource = 'persisted' | 'inferred' | 'mixed';

export interface PipelineCondition {
  id: string;
  label: string;
  pass: boolean;
  actual?: string | number | boolean | null;
  threshold?: string | number | boolean | null;
  detail?: string;
}

export interface PipelineChecklistItem {
  id: string;
  label: string;
  pass: boolean;
}

export interface PipelineNode {
  id: PipelineStageId;
  label: string;
  status: PipelineNodeStatus;
  summary: string;
  atUtc?: string;
  job?: string;
  conditions: PipelineCondition[];
  checklist?: PipelineChecklistItem[];
  detail?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface PipelineEdge {
  from: PipelineStageId;
  to: PipelineStageId;
}

export interface PipelineHeader {
  ticker: string;
  asofDate: string;
  docId: string;
  signalIndex: number;
  aiGate: string;
  confidence?: number | null;
  score?: number | null;
  close?: number | null;
  stop?: number | null;
  target?: number | null;
  holdDays?: number | null;
  notes?: string | null;
  paperStatus?: string | null;
  paperPositionId?: string | null;
}

export interface PipelineGraph {
  version: 1;
  traceSource: PipelineTraceSource;
  inferredBanner?: string;
  header: PipelineHeader;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  failPoint?: PipelineStageId;
}
