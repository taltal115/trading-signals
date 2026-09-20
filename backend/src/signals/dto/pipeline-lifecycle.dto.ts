/** Shared Nest ↔ Angular shapes for the per-signal lifecycle DAG. */

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
  /** One-line teaser on the DAG box. */
  summary: string;
  atUtc?: string;
  job?: string;
  conditions: PipelineCondition[];
  checklist?: PipelineChecklistItem[];
  /** Extra payload for the drawer (AI verdict, provider_status, etc.). */
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
  /** Banner when thresholds came from current defaults rather than a persisted snapshot. */
  inferredBanner?: string;
  header: PipelineHeader;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  /** First terminal failed/skipped stage, if any. */
  failPoint?: PipelineStageId;
}

/** Defaults matching config.yaml (used when inferring historical rows). */
export interface PipelineThresholds {
  continuation_ret_5d_min_pct: number;
  continuation_ret_5d_max_pct: number;
  continuation_vol_ratio_min: number;
  continuation_vol_ratio_max: number;
  hard_reject_ret_5d_min_pct: number;
  hard_reject_vol_ratio_min: number;
  hard_reject_confidence_min: number;
  require_continuation_band: boolean;
  ret_5d_min_pct: number;
  ret_10d_min_pct: number;
  vol_ratio_min: number;
  min_buy_confidence: number;
  entry_min_total: number;
  entry_min_conviction: number;
}

export const DEFAULT_PIPELINE_THRESHOLDS: PipelineThresholds = {
  continuation_ret_5d_min_pct: 8.0,
  continuation_ret_5d_max_pct: 25.0,
  continuation_vol_ratio_min: 2.0,
  continuation_vol_ratio_max: 4.0,
  hard_reject_ret_5d_min_pct: 50.0,
  hard_reject_vol_ratio_min: 5.0,
  hard_reject_confidence_min: 0,
  require_continuation_band: true,
  ret_5d_min_pct: 8.0,
  ret_10d_min_pct: 12.0,
  vol_ratio_min: 2.0,
  min_buy_confidence: 70,
  entry_min_total: 70,
  entry_min_conviction: 0.7,
};

export const PIPELINE_STAGE_ORDER: PipelineStageId[] = [
  'universe',
  'scan',
  'hard_filters',
  'entry_queue',
  'news_context',
  'ai_entry',
  'ai_gate',
  'paper',
  'holding',
  'outcome',
];

export const PIPELINE_EDGES: PipelineEdge[] = [
  { from: 'universe', to: 'scan' },
  { from: 'scan', to: 'hard_filters' },
  { from: 'hard_filters', to: 'entry_queue' },
  { from: 'entry_queue', to: 'news_context' },
  { from: 'news_context', to: 'ai_entry' },
  { from: 'ai_entry', to: 'ai_gate' },
  { from: 'ai_gate', to: 'paper' },
  { from: 'paper', to: 'holding' },
  { from: 'holding', to: 'outcome' },
];
