import 'express-session';

declare module 'express-session' {
  interface SessionData {
    /** Older sessions omitted displayName until multi-user rollout. */
    user?: { uid: string; email: string; displayName?: string };
  }
}
