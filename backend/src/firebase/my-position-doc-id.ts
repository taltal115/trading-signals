/**
 * Lex-sortable ids matching Python `signals_bot.storage.firestore.utc_datetime_lex_id`
 * (`YYYY-MM-DDTHH-MM-SS.FFFFFFZ`; clock segments use `-` not `:`).
 */
export function utcDatetimeLexId(d: Date): string {
  if (!Number.isFinite(d.getTime())) {
    throw new Error('utcDatetimeLexId: invalid Date');
  }
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const datePart = `${y}-${mo}-${day}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const clock = `${hh}-${mi}-${ss}`;
  const ms = d.getUTCMilliseconds();
  const frac = `${String(ms).padStart(3, '0')}000`;
  return `${datePart}T${clock}.${frac}Z`;
}