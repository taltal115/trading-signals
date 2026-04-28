import { DateTime } from 'luxon';

import { isNyseSessionIsoDate } from '../../generated/nyse-session-set.generated';

const NY_TZ = 'America/New_York';

/** Firestore my_positions document shape (subset used by UI). */
export interface PositionData {
  ticker?: string;
  status?: string;
  entry_price?: number | null;
  exit_price?: number | null;
  exit_at_utc?: string | null;
  quantity?: number | null;
  stop_price?: number | null;
  target_price?: number | null;
  last_spot?: number | null;
  last_alert_ts_utc?: string | null;
  last_alert_kind?: string | null;
  sector?: string | null;
  industry?: string | null;
  hold_days_from_signal?: number | null;
  estimated_hold_days?: number | null;
  bought_at?: string | null;
  created_at_utc?: string | null;
  closed_at_utc?: string | null;
  pnl_pct?: number | null;
  signal_doc_id?: string | null;
  /** Snapshot of signal confidence at open (from bot row); optional on legacy docs. */
  signal_confidence?: number | null;
  signal_close_price?: number | null;
  notes?: string | null;
  exit_notes?: string | null;
  /** `user` = manual exit in UI; `position_monitor` = auto-closed when monitor saw TARGET_HIT/STOP_HIT. */
  exit_origin?: string | null;
  /** When exit_origin is position_monitor: TARGET_HIT or STOP_HIT. */
  monitor_close_kind?: string | null;
}

export interface PositionRow {
  id: string;
  data: PositionData;
}

/**
 * Shares used for P/L when Firestore omits `quantity` or it is non-positive.
 * Matches historical UI behavior (implicit 1 share).
 */
export function effectiveQuantity(d: PositionData): number {
  const q = d.quantity != null ? Number(d.quantity) : NaN;
  if (Number.isFinite(q) && q > 0) return q;
  return 1;
}

/** True when {@link effectiveQuantity} is not taken from a stored positive quantity. */
export function quantityWasInferred(d: PositionData): boolean {
  const q = d.quantity != null ? Number(d.quantity) : NaN;
  return !Number.isFinite(q) || q <= 0;
}

/**
 * Move forward by `tradingDays` **NYSE sessions** (XNYS; early-close days count as one).
 * Uses Luxon in `America/New_York` to mirror `scripts/monitor_open_positions.py` + codegen.
 */
export function addTradingDays(startDate: Date, tradingDays: number): Date {
  if (tradingDays <= 0) {
    return new Date(startDate.getTime());
  }
  let cur = DateTime.fromJSDate(startDate).setZone(NY_TZ);
  let added = 0;
  while (added < tradingDays) {
    cur = cur.plus({ days: 1 });
    const iso = cur.toISODate();
    if (iso && isNyseSessionIsoDate(iso)) {
      added++;
    }
  }
  return cur.toJSDate();
}

/**
 * Sessions strictly after `startDate` through `endDate` while stepping one NY calendar day per
 * iteration (matches monitor + generated XNYS calendar data).
 */
export function countTradingDaysBetween(startDate: Date, endDate: Date): number {
  if (endDate <= startDate) return 0;
  let cur = DateTime.fromJSDate(startDate).setZone(NY_TZ);
  const end = DateTime.fromJSDate(endDate).setZone(NY_TZ);
  let count = 0;
  while (cur < end) {
    cur = cur.plus({ days: 1 });
    const iso = cur.toISODate();
    if (iso && isNyseSessionIsoDate(iso)) {
      count++;
    }
  }
  return count;
}

/** Max fractional digits for prices, percentages, and spot values in the UI. */
export const UI_MAX_DECIMALS = 3;

export function roundUi(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  const f = 10 ** UI_MAX_DECIMALS;
  return Math.round(n * f) / f;
}

/** Trimmed decimal string (max {@link UI_MAX_DECIMALS} places); `—` if not finite. */
export function fmtUiDecimal(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const r = roundUi(n);
  return r.toFixed(UI_MAX_DECIMALS).replace(/\.?0+$/, '');
}

/** Unsigned USD for tables and live price (e.g. `$6.19`). */
export function fmtUsd(x: unknown): string {
  if (x == null || x === '') return '—';
  const n = Number(x);
  return Number.isFinite(n) ? '$' + fmtUiDecimal(n) : '—';
}

/** Signed USD for PnL totals (e.g. `+$12.34`, `-$1.2`). */
export function fmtSignedUsd(x: number): string {
  if (!Number.isFinite(x)) return '—';
  return (x >= 0 ? '+$' : '-$') + fmtUiDecimal(Math.abs(x));
}

export function formatNum(x: unknown): string {
  if (x == null || x === '') return '—';
  const n = Number(x);
  return Number.isFinite(n) ? fmtUiDecimal(n) : '—';
}

export function rowPnlClass(d: PositionData): string {
  if (d.status !== 'closed') return 'row-open';
  let p = d.pnl_pct;
  if (p == null && d.exit_price != null && d.entry_price != null) {
    const e = Number(d.entry_price);
    const x = Number(d.exit_price);
    if (e > 0) p = ((x - e) / e) * 100;
  }
  if (p == null || !Number.isFinite(Number(p))) return 'row-flat';
  p = Number(p);
  if (p > 0.0001) return 'row-profit';
  if (p < -0.0001) return 'row-loss';
  return 'row-flat';
}

export function fmtPnlHtml(d: PositionData): string {
  if (d.status !== 'closed') return '—';
  let p = d.pnl_pct;
  if (p == null && d.exit_price != null && d.entry_price != null) {
    const e = Number(d.entry_price);
    const x = Number(d.exit_price);
    if (e > 0) p = ((x - e) / e) * 100;
  }
  if (p == null || !Number.isFinite(Number(p))) return '—';
  p = Number(p);
  const cls = p > 0.0001 ? 'pnl-profit' : p < -0.0001 ? 'pnl-loss' : 'pnl-flat';
  const sign = p > 0 ? '+' : '';
  return '<span class="' + cls + '">' + sign + fmtUiDecimal(p) + '%</span>';
}

export function calculatePnlForPosition(
  d: PositionData,
  livePrices: Record<string, number>
): { pnlValue: number; pnlPct: number; investment: number; currentPrice: number } {
  const entry = d.entry_price != null ? Number(d.entry_price) : null;
  const qty = effectiveQuantity(d);
  if (entry == null || entry === 0) return { pnlValue: 0, pnlPct: 0, investment: 0, currentPrice: entry || 0 };

  const currentPriceRaw = livePrices[d.ticker || ''] ?? d.last_spot;
  const exitOrSpot =
    d.status === 'closed' && d.exit_price != null
      ? Number(d.exit_price)
      : currentPriceRaw != null
        ? Number(currentPriceRaw)
        : entry;

  const pnlValue = (exitOrSpot - entry) * qty;
  const pnlPct = ((exitOrSpot - entry) / entry) * 100;
  return { pnlValue, pnlPct, investment: entry * qty, currentPrice: exitOrSpot };
}

export function calculateDailyPnl(
  positions: PositionRow[],
  livePrices: Record<string, number>,
  previousDayPrices: Record<string, number>
): { pnlValue: number; pnlPct: number } {
  let dailyPnl = 0;
  let dailyInvestment = 0;

  for (const pos of positions) {
    const d = pos.data;
    if (d.status !== 'open') continue;
    const entry = d.entry_price != null ? Number(d.entry_price) : null;
    const qty = effectiveQuantity(d);
    if (entry == null || entry === 0) continue;

    const currentPrice = livePrices[d.ticker || ''] ?? d.last_spot;
    if (currentPrice == null) continue;

    let prevClose = previousDayPrices[d.ticker || ''];
    if (prevClose == null) prevClose = entry;

    const dayChange = (Number(currentPrice) - prevClose) * qty;
    dailyPnl += dayChange;
    dailyInvestment += prevClose * qty;
  }

  const dailyPct = dailyInvestment > 0 ? (dailyPnl / dailyInvestment) * 100 : 0;
  return { pnlValue: dailyPnl, pnlPct: dailyPct };
}

/** Table label for how a closed position was exited (manual vs position monitor). */
export function exitViaLabel(d: PositionData): string {
  const o = String(d.exit_origin || '').toLowerCase();
  if (o === 'position_monitor') {
    const k = String(d.monitor_close_kind || '');
    if (k === 'TARGET_HIT') return 'Monitor · target';
    if (k === 'STOP_HIT') return 'Monitor · stop';
    return 'Monitor';
  }
  if (d.status === 'closed') return 'Manual';
  return '—';
}

export function getFilteredPositions(positions: PositionRow[], hideClosed: boolean): PositionRow[] {
  if (!hideClosed) return positions;
  return positions.filter((p) => p.data.status === 'open');
}

export function sortPositionsData(positions: PositionRow[], key: string, dir: 'asc' | 'desc', livePrices: Record<string, number>): PositionRow[] {
  return positions.slice().sort((a, b) => {
    let aVal: string | number = a.data[key as keyof PositionData] as string | number;
    let bVal: string | number = b.data[key as keyof PositionData] as string | number;

    if (key === 'hold') {
      aVal = a.data.hold_days_from_signal ?? a.data.estimated_hold_days ?? 0;
      bVal = b.data.hold_days_from_signal ?? b.data.estimated_hold_days ?? 0;
    }
    if (key === 'pnl_pct') {
      aVal = calculatePnlForPosition(a.data, livePrices).pnlPct;
      bVal = calculatePnlForPosition(b.data, livePrices).pnlPct;
    }
    if (key === 'exit_via') {
      aVal = exitViaLabel(a.data);
      bVal = exitViaLabel(b.data);
    }

    if (aVal == null) aVal = '';
    if (bVal == null) bVal = '';

    if (typeof aVal === 'string') aVal = aVal.toLowerCase();
    if (typeof bVal === 'string') bVal = bVal.toLowerCase();

    if (aVal < bVal) return dir === 'asc' ? -1 : 1;
    if (aVal > bVal) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

export interface BracketPct {
  stopPct: number;
  targetPct: number;
}

export function extractBracketPctsFromSignal(s: Record<string, unknown>): BracketPct | null {
  if (!s) return null;
  const sp = s['stop_pct'];
  const tp = s['target_pct'];
  if (sp != null && tp != null && Number.isFinite(Number(sp)) && Number.isFinite(Number(tp))) {
    return { stopPct: Number(sp), targetPct: Number(tp) };
  }
  const close = Number(s['close']);
  const stop = s['stop'] != null ? Number(s['stop']) : NaN;
  const target = s['target'] != null ? Number(s['target']) : NaN;
  if (Number.isFinite(close) && close !== 0 && Number.isFinite(stop) && Number.isFinite(target)) {
    return {
      stopPct: ((stop - close) / close) * 100,
      targetPct: ((target - close) / close) * 100,
    };
  }
  return null;
}

export function fmtMoneyInput(x: number): string {
  if (!Number.isFinite(x)) return '';
  return fmtUiDecimal(x);
}
