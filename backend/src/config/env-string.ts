/**
 * Normalize env values: trim and strip a single pair of surrounding quotes.
 * Prevents Google `invalid_client` when `.env` has GOOGLE_CLIENT_ID="....apps.googleusercontent.com".
 */
export function envString(raw: string | undefined): string {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (s.length >= 2) {
    const q = s[0];
    if ((q === '"' || q === "'") && s[s.length - 1] === q) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}
