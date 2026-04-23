/**
 * Used only when building with `--configuration=production` (see angular.json fileReplacements).
 * Keep allowlists aligned with Nest `ALLOWED_SIGN_IN_EMAILS` / `ALLOWED_AUTH_UIDS`.
 */
export const environment = {
  production: true,
  devAuthBypass: false,
  /**
   * One canonical origin must match Nest `FRONTEND_URL` / OAuth callback.
   * If Cloud Run uses `https://<id>.firebaseapp.com`, send users away from `<id>.web.app`.
   */
  canonicalFirebaseAppHost: 'trading-goals.web.app',
  canonicalSiteOrigin: 'https://trading-goals.firebaseapp.com',
  /**
   * '' = browser calls `/api/...` on the same host as the SPA.
   * That only returns JSON when Firebase Hosting rewrites `/api/**` to Cloud Run (see repo `firebase.json`).
   *
   * If Hosting is SPA-only, set this to your Nest Cloud Run origin, e.g. `https://trading-signals-api-xxxxx-uc.a.run.app`
   * (no trailing slash). Then set Nest `FRONTEND_URL` to your Hosting URL and `GOOGLE_CALLBACK_URL` to
   * `{apiOrigin}/api/auth/google/callback` on the API host.
   */
  apiBaseUrl: '',
  allowedSignInEmails: ['taltal115@gmail.com'],
  allowedAuthUids: ['tgIBRfrP1ibiEi6P2LMsVoyvNaM2'],
};
