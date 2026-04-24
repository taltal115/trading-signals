import { envString } from './env-string';

const envFlagFalse = (v: string | undefined): boolean =>
  ['false', '0', 'no', 'off'].includes((v || '').trim().toLowerCase());

/** Cloud Run sets `K_SERVICE`; default to production so cookies/sessions match deployment. */
const defaultNodeEnv = (): string =>
  process.env.NODE_ENV || (process.env.K_SERVICE ? 'production' : 'development');

/**
 * The other default Firebase Hosting hostname so we can 307 to FRONTEND_URL (session + OAuth one origin).
 * FRONTEND_URL may be either `*.web.app` or `*.firebaseapp.com`.
 */
function altHostingHostname(): string {
  const override = envString(process.env.ALT_HOSTING_HOSTNAME);
  if (override === '-') return '';
  if (override) return override.toLowerCase();
  const fe = envString(process.env.FRONTEND_URL);
  const web = fe.match(/^https:\/\/([a-z0-9-]+)\.web\.app\/?$/i);
  if (web) return `${web[1].toLowerCase()}.firebaseapp.com`;
  const fb = fe.match(/^https:\/\/([a-z0-9-]+)\.firebaseapp\.com\/?$/i);
  if (fb) return `${fb[1].toLowerCase()}.web.app`;
  return '';
}

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: defaultNodeEnv(),
  /** When false, `/api/market/quote` and `/api/market/candles` return 503 and no external providers are called. */
  marketDataEnabled: !envFlagFalse(process.env.MARKET_DATA_ENABLED),
  sessionSecret: process.env.SESSION_SECRET || 'dev-session-secret-change-me',
  /** Firebase Hosting only forwards a cookie named `__session` to Cloud Run rewrites (not arbitrary names). */
  sessionCookieName:
    envString(process.env.SESSION_COOKIE_NAME) ||
    (defaultNodeEnv() === 'production' ? '__session' : 'signals.sid'),
  authBypassLocal: process.env.AUTH_BYPASS_LOCAL === 'true',
  devOwnerUid: process.env.DEV_OWNER_UID || '',
  devUserEmail: process.env.DEV_USER_EMAIL || 'dev@localhost',
  frontendUrl: envString(process.env.FRONTEND_URL) || 'http://localhost:4200',
  /** e.g. trading-goals.firebaseapp.com — requests with this Host get 307 to frontendUrl */
  altHostingHostname: altHostingHostname(),
  googleClientId: envString(process.env.GOOGLE_CLIENT_ID),
  googleClientSecret: envString(process.env.GOOGLE_CLIENT_SECRET),
  googleCallbackUrl:
    envString(process.env.GOOGLE_CALLBACK_URL) ||
    `${envString(process.env.FRONTEND_URL) || 'http://localhost:4200'}/api/auth/google/callback`,
  allowedEmails: (process.env.ALLOWED_SIGN_IN_EMAILS || '')
    .split(',')
    .map((s) => envString(s).toLowerCase())
    .filter(Boolean),
  allowedUids: (process.env.ALLOWED_AUTH_UIDS || '')
    .split(',')
    .map((s) => envString(s))
    .filter(Boolean),
  /** Server-side only — browser calls `/api/market/*` (avoids Finnhub 403/CORS from the client). */
  finnhubApiKey: (process.env.FINNHUB_API_KEY || '').trim(),
  twelveDataApiKey: (process.env.TWELVE_DATA_API_KEY || '').trim(),
  /** Daily candles fallback (TIME_SERIES_DAILY); keep key server-side only. */
  alphaVantageApiKey: (
    process.env.ALPHA_VANTAGE_API_KEY ||
    process.env.ALPHAVANTAGE_API_KEY ||
    ''
  ).trim(),
  /** PAT with `workflow` scope — dispatches Actions from POST /api/github/workflows/* (never sent to browser). */
  githubWorkflowToken: (
    process.env.GITHUB_PERSONAL_TOKEN ||
    process.env.GITHUB_TOKEN ||
    ''
  ).trim(),
  githubRepoOwner: (process.env.GITHUB_REPO_OWNER || 'taltal115').trim(),
  githubRepoName: (process.env.GITHUB_REPO_NAME || 'trading-signals').trim(),
  /** Firestore collection for bot signal runs (default signals_new). Set FIRESTORE_SIGNALS_COLLECTION=signals to use legacy. */
  firestoreSignalsCollection: (process.env.FIRESTORE_SIGNALS_COLLECTION || 'signals_new').trim(),
});
