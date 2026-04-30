export const environment = {
  production: false,
  /** Dev: no redirect. Prod sets both so `firebaseapp.com` → `web.app` (one cookie origin). */
  canonicalFirebaseAppHost: null as string | null,
  canonicalSiteOrigin: null as string | null,
  /**
   * Non-production builds: shell skips Google login (pair with Nest `AUTH_BYPASS_LOCAL` + `DEV_OWNER_UID`).
   * Do not rely on hostname: `ng serve --host 0.0.0.0` / LAN IP must still work.
   * `environment.prod.ts` sets this to `false`.
   */
  devAuthBypass: true,
  apiBaseUrl: '',
  allowedSignInEmails: [
    'taltal115@gmail.com',
    'tal.david.shitrit@gmail.com',
  ],
  allowedAuthUids: [
    'tgIBRfrP1ibiEi6P2LMsVoyvNaM2',
    // 'TEAMMATE_FIREBASE_UID',
  ],
};
