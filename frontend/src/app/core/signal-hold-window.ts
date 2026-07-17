import { DateTime } from 'luxon';

import { addTradingDays } from './positions-logic';

const NY_TZ = 'America/New_York';

/** Fixed hold window for signal price charts: 3 NYSE sessions after asof. */
export const SIGNAL_HOLD_TRADING_DAYS = 3;

export interface SignalHoldWindow {
  /** Start of asof_date regular session (09:30 ET) — include signal-day bars. */
  fetchFromMs: number;
  /** End of asof_date regular session (16:00 ET) — signal entry / suggestion. */
  entryMs: number;
  /** End of 3rd NYSE session after asof_date (16:00 ET). */
  exitMs: number;
  /** Whether wall-clock now is still before planned exit. */
  inProgress: boolean;
  /** Fetch end: min(now, exit). */
  fetchToMs: number;
}

/**
 * Entry = asof_date 16:00 ET (signal suggestion / EOD close).
 * Exit = 16:00 ET on the 3rd NYSE session strictly after asof_date.
 * Fetch from asof 09:30 ET so the signal day appears on the chart.
 */
export function computeSignalHoldWindow(asofDateIso: string, nowMs: number = Date.now()): SignalHoldWindow {
  const iso = String(asofDateIso || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error('Invalid asof_date for hold window');
  }
  const sessionOpen = DateTime.fromISO(`${iso}T09:30:00`, { zone: NY_TZ });
  const entry = DateTime.fromISO(`${iso}T16:00:00`, { zone: NY_TZ });
  if (!sessionOpen.isValid || !entry.isValid) {
    throw new Error('Invalid asof_date for hold window');
  }
  const exitDate = addTradingDays(entry.toJSDate(), SIGNAL_HOLD_TRADING_DAYS);
  const exit = DateTime.fromJSDate(exitDate).setZone(NY_TZ).set({
    hour: 16,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const fetchFromMs = sessionOpen.toMillis();
  const entryMs = entry.toMillis();
  const exitMs = exit.toMillis();
  const inProgress = nowMs < exitMs;
  const fetchToMs = Math.min(nowMs, exitMs);
  return { fetchFromMs, entryMs, exitMs, inProgress, fetchToMs };
}
