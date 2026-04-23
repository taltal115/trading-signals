import type { PositionRow } from './positions-logic';
import type { SignalDoc } from './signal-docs-normalize';

export type NormalizedSignalDoc = { id: string; data: SignalDoc };

export type SignalJoinEntry = {
  asofDate: string;
  byTicker: Map<string, Record<string, unknown>>;
};

/** Index signal run id → as-of date + map of ticker → signal row. */
export function buildSignalJoinIndex(docs: NormalizedSignalDoc[]): Map<string, SignalJoinEntry> {
  const m = new Map<string, SignalJoinEntry>();
  for (const d of docs) {
    const arr = Array.isArray(d.data.signals) ? d.data.signals : [];
    const byTicker = new Map<string, Record<string, unknown>>();
    for (const s of arr) {
      const t = String(s['ticker'] || '')
        .trim()
        .toUpperCase();
      if (t) byTicker.set(t, s as Record<string, unknown>);
    }
    m.set(d.id, {
      asofDate: String(d.data.asof_date || ''),
      byTicker,
    });
  }
  return m;
}

/** Match position to its signal row using `signal_doc_id` and ticker. */
export function findSignalRowForPosition(
  pos: PositionRow,
  index: Map<string, SignalJoinEntry>
): { asofDate: string; row: Record<string, unknown> } | null {
  const sid = String(pos.data.signal_doc_id || '').trim();
  if (!sid) return null;
  const entry = index.get(sid);
  if (!entry) return null;
  const t = String(pos.data.ticker || '')
    .trim()
    .toUpperCase();
  const row = entry.byTicker.get(t);
  if (!row) return null;
  return { asofDate: entry.asofDate, row };
}

/**
 * When `signal_doc_id` is missing or the run no longer matches the ticker row,
 * use the newest signal run (by `asof_date`, then doc id) that contains this ticker.
 * Fills reporting gaps for legacy / unlinked positions; prefer {@link findSignalRowForPosition} when it succeeds.
 */
export function findLatestSignalRowByTicker(
  pos: PositionRow,
  index: Map<string, SignalJoinEntry>
): { asofDate: string; row: Record<string, unknown> } | null {
  const t = String(pos.data.ticker || '')
    .trim()
    .toUpperCase();
  if (!t) return null;
  const matches: { asofDate: string; runId: string; row: Record<string, unknown> }[] = [];
  for (const [runId, entry] of index) {
    const row = entry.byTicker.get(t);
    if (row) matches.push({ asofDate: entry.asofDate, runId, row });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const byDate = b.asofDate.localeCompare(a.asofDate);
    if (byDate !== 0) return byDate;
    return b.runId.localeCompare(a.runId);
  });
  const best = matches[0];
  return { asofDate: best.asofDate, row: best.row };
}

export function resolveSignalRowForPosition(
  pos: PositionRow,
  index: Map<string, SignalJoinEntry>
): { asofDate: string; row: Record<string, unknown>; via: 'doc' | 'ticker' } | null {
  const direct = findSignalRowForPosition(pos, index);
  if (direct) return { ...direct, via: 'doc' };
  const fb = findLatestSignalRowByTicker(pos, index);
  if (fb) return { ...fb, via: 'ticker' };
  return null;
}
