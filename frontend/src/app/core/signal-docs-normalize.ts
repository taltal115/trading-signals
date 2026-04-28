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
