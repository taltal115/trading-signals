const envFlagFalse = (v: string | undefined): boolean =>
  ['false', '0', 'no', 'off'].includes((v || '').trim().toLowerCase());

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  /** When false, `/api/market/quote` and `/api/market/candles` return 503 and no external providers are called. */
  marketDataEnabled: !envFlagFalse(process.env.MARKET_DATA_ENABLED),
  sessionSecret: process.env.SESSION_SECRET || 'dev-session-secret-change-me',
  authBypassLocal: process.env.AUTH_BYPASS_LOCAL === 'true',
  devOwnerUid: process.env.DEV_OWNER_UID || '',
  devUserEmail: process.env.DEV_USER_EMAIL || 'dev@localhost',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:4200',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleCallbackUrl:
    process.env.GOOGLE_CALLBACK_URL ||
    `${process.env.FRONTEND_URL || 'http://localhost:4200'}/api/auth/google/callback`,
  allowedEmails: (process.env.ALLOWED_SIGN_IN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  allowedUids: (process.env.ALLOWED_AUTH_UIDS || '')
    .split(',')
    .map((s) => s.trim())
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
});
