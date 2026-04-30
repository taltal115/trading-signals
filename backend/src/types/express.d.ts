export {};

declare global {
  namespace Express {
    interface Request {
      sessionUser?: { uid: string; email: string; displayName: string };
    }
  }
}
