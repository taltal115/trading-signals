/** Firestore signal run document shape (`signals`; subset). */
export interface SignalDoc {
  asof_date?: string;
  signals?: Record<string, unknown>[];
  ts_utc?: string;
}

/** Coerce legacy / alternate Firestore shapes to `signals[]` for the table. */
export function signalsRowsFromRaw(raw: Record<string, unknown>): Record<string, unknown>[] | null {
  const sigs = raw['signals'];
  if (Array.isArray(sigs) && sigs.length > 0) {
    return sigs as Record<string, unknown>[];
  }
  if (sigs && typeof sigs === 'object' && !Array.isArray(sigs)) {
    const vals = Object.values(sigs as Record<string, unknown>).filter(
      (v) => v != null && typeof v === 'object' && !Array.isArray(v)
    ) as Record<string, unknown>[];
    if (vals.length > 0) return vals;
  }
  const buys = raw['buys'];
  if (Array.isArray(buys) && buys.length > 0) {
    return buys as Record<string, unknown>[];
  }
  return null;
}

/** Map Firestore run docs to the shape the table expects (`signals[]` BUY rows). */
export function normalizeSignalDocs(
  docs: { id: string; data: SignalDoc }[]
): { id: string; data: SignalDoc }[] {
  return docs.map((doc) => {
    const data = doc.data;
    const raw = data as Record<string, unknown>;
    const fromArr = signalsRowsFromRaw(raw);
    if (fromArr) {
      return { id: doc.id, data: { ...data, signals: fromArr } };
    }
    const ticker = String(raw['ticker'] || '')
      .trim()
      .toUpperCase();
    const action = String(raw['action'] || '')
      .trim()
      .toUpperCase();
    if (ticker && action === 'BUY') {
      const one: Record<string, unknown> = {
        ticker,
        confidence: raw['confidence'],
        score: raw['score'],
        close: raw['close'],
        stop: raw['stop'] ?? raw['suggested_stop'],
        target: raw['target'] ?? raw['suggested_target'],
        hold_days: raw['hold_days'] ?? raw['max_hold_days'],
        sector: raw['sector'],
        industry: raw['industry'],
        estimated_hold_days: raw['estimated_hold_days'],
      };
      return {
        id: doc.id,
        data: {
          asof_date: raw['asof_date'] as string | undefined,
          ts_utc: raw['ts_utc'] as string | undefined,
          signals: [one],
        },
      };
    }
    return doc;
  });
}

/** One flattened BUY line for paginated `/api/signals` responses. */
export interface SignalInstanceRow {
  docId: string;
  asofDate: string;
  docTsUtc: string;
  docTsMs: number;
  signalIndex: number;
  signal: Record<string, unknown>;
}

export type SignalDocRow = { id: string; data: SignalDoc };

function signalSortKeyMs(s: Record<string, unknown>, index: number): number {
  for (const k of ['ts_utc', 'signal_ts', 'updated_at', 'created_at']) {
    const v = s[k];
    if (typeof v === 'string' && v.trim()) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return index;
}

export function docTimestampMs(data: SignalDoc): number {
  const raw = data.ts_utc;
  if (typeof raw === 'string' && raw.trim()) {
    const t = Date.parse(raw.trim());
    if (Number.isFinite(t)) return t;
  }
  const ad = String(data.asof_date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(ad)) {
    const t = Date.parse(`${ad}T12:00:00.000Z`);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

export function flattenSignalDocsToInstanceRows(docs: SignalDocRow[]): SignalInstanceRow[] {
  const out: SignalInstanceRow[] = [];
  for (const doc of docs) {
    const asofDate = String(doc.data.asof_date || '');
    const docTsUtc = String(doc.data.ts_utc || '');
    const docTsMs = docTimestampMs(doc.data);
    const arr = Array.isArray(doc.data.signals) ? doc.data.signals : [];
    for (let signalIndex = 0; signalIndex < arr.length; signalIndex++) {
      const signal = arr[signalIndex] as Record<string, unknown>;
      const tickerU = String(signal['ticker'] || '')
        .trim()
        .toUpperCase();
      if (!tickerU) continue;
      out.push({
        docId: doc.id,
        asofDate,
        docTsUtc,
        docTsMs,
        signalIndex,
        signal,
      });
    }
  }
  return out;
}

export function compareSignalInstanceRows(a: SignalInstanceRow, b: SignalInstanceRow): number {
  if (b.docTsMs !== a.docTsMs) return b.docTsMs - a.docTsMs;
  const aSort = signalSortKeyMs(a.signal, a.signalIndex);
  const bSort = signalSortKeyMs(b.signal, b.signalIndex);
  const d = bSort - aSort;
  if (d !== 0) return d;
  if (b.signalIndex !== a.signalIndex) return b.signalIndex - a.signalIndex;
  return a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0;
}

function encodeInstanceCursor(row: SignalInstanceRow): string {
  return `${row.docId}\t${row.signalIndex}`;
}

/** Accept new `{ rows }` API or legacy `{ docs }` (client-side slice for local dev). */
export function normalizeSignalsApiResponse(
  raw: unknown,
  pageSize: number,
  cursor?: string,
): {
  rows: SignalInstanceRow[];
  nextCursor: string | null;
  latestRun: SignalDocRow | null;
} {
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r['rows'])) {
    return {
      rows: r['rows'] as SignalInstanceRow[],
      nextCursor: typeof r['nextCursor'] === 'string' ? r['nextCursor'] : null,
      latestRun: (r['latestRun'] as SignalDocRow | null) ?? null,
    };
  }

  const docs = normalizeSignalDocs((r['docs'] as SignalDocRow[]) ?? []);
  const sorted = flattenSignalDocsToInstanceRows(docs).sort(compareSignalInstanceRows);
  let start = 0;
  const cur = cursor?.trim();
  if (cur) {
    const idx = sorted.findIndex((row) => encodeInstanceCursor(row) === cur);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const rows = sorted.slice(start, start + pageSize);
  const nextCursor =
    rows.length === pageSize && start + pageSize < sorted.length
      ? encodeInstanceCursor(rows[rows.length - 1])
      : null;
  const latestRun = docs.length > 0 ? docs[0] : null;
  return { rows, nextCursor, latestRun };
}
