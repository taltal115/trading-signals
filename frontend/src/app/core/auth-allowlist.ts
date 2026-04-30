export interface AuthUser {
  uid: string;
  email: string | null;
  /** Best-effort display name from Google / Firebase; null when unknown. */
  displayName?: string | null;
}

export function allowedEmailsList(allowedSignInEmails: string[]): string[] {
  return allowedSignInEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
}

export function allowedAuthUidsList(allowedAuthUids: string[]): string[] {
  return allowedAuthUids.map((u) => String(u).trim()).filter(Boolean);
}

export function primaryAccountEmail(user: AuthUser | null): string {
  if (!user) return '';
  return String(user.email || '')
    .trim()
    .toLowerCase();
}

export function isUserAllowed(
  user: AuthUser | null,
  allowedSignInEmails: string[],
  allowedAuthUids: string[]
): boolean {
  if (!user) return false;
  const uids = allowedAuthUidsList(allowedAuthUids);
  if (uids.length > 0 && uids.includes(user.uid)) return true;
  const allow = allowedEmailsList(allowedSignInEmails);
  if (allow.length === 0) return true;
  const email = primaryAccountEmail(user);
  return Boolean(email && allow.includes(email));
}
