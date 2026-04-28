import { DateTime } from 'luxon';

import { isNyseSessionIsoDate } from '../../generated/nyse-session-set.generated';

const NY_ZONE = 'America/New_York';

/** NYSE regular session (cash equities); 9:30–16:00 ET ignores early-close shortening. */

export interface NyseMarketClockState {
  /** Green when NYSE regular session is active (9:30–16:00 ET on an XNYS session day). */
  isOpen: boolean;
  headline: string;
  detail: string;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function formatDurationMs(msTotal: number): string {
  if (!Number.isFinite(msTotal) || msTotal < 0) return '—';
  const secs = Math.floor(msTotal / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${pad(m)}:${pad(s)}`;
}

/**
 * Next regular-session open strictly after `now` (handles weekends/holidays via generated XNYS set).
 */
export function nextNyseRegularOpen(now: DateTime): DateTime {
  for (let delta = 0; delta < 450; delta++) {
    const day = now.startOf('day').plus({ days: delta });
    const iso = day.toISODate();
    if (!iso || !isNyseSessionIsoDate(iso)) continue;
    const open = DateTime.fromISO(`${iso}T09:30:00`, { zone: NY_ZONE });
    if (open.toMillis() > now.toMillis()) return open;
  }
  throw new Error('NYSE session calendar: could not find next open (extend generated range)');
}

function sameDayRegularClose(now: DateTime): DateTime {
  const iso = now.toISODate();
  if (!iso) throw new Error('NYSE clock: invalid local date');
  return DateTime.fromISO(`${iso}T16:00:00`, { zone: NY_ZONE });
}

export function computeNyseMarketClock(now: DateTime): NyseMarketClockState {
  const iso = now.toISODate();
  if (!iso) {
    return {
      isOpen: false,
      headline: 'Market',
      detail: '—',
    };
  }

  if (!isNyseSessionIsoDate(iso)) {
    const target = nextNyseRegularOpen(now);
    const ms = Math.max(0, target.diff(now).as('milliseconds'));
    return {
      isOpen: false,
      headline: 'Market closed',
      detail: `Opens in ${formatDurationMs(ms)} · ${target.toFormat('ccc MMM d')} 9:30 ET`,
    };
  }

  const open = DateTime.fromISO(`${iso}T09:30:00`, { zone: NY_ZONE });
  const close = sameDayRegularClose(now);

  if (now.toMillis() < open.toMillis()) {
    const ms = Math.max(0, open.diff(now).as('milliseconds'));
    return {
      isOpen: false,
      headline: 'Market closed',
      detail: `Opens in ${formatDurationMs(ms)} · 9:30 ET`,
    };
  }

  if (now.toMillis() >= open.toMillis() && now.toMillis() < close.toMillis()) {
    const ms = Math.max(0, close.diff(now).as('milliseconds'));
    return {
      isOpen: true,
      headline: 'Market open',
      detail: `Closes in ${formatDurationMs(ms)} · 4:00 ET`,
    };
  }

  const target = nextNyseRegularOpen(now);
  const ms = Math.max(0, target.diff(now).as('milliseconds'));
  return {
    isOpen: false,
    headline: 'Market closed',
    detail: `Opens in ${formatDurationMs(ms)} · ${target.toFormat('ccc MMM d')} 9:30 ET`,
  };
}
