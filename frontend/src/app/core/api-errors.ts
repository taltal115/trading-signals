import { HttpErrorResponse } from '@angular/common/http';

export function formatApiErr(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { message?: string | string[]; error?: string } | null;
    if (typeof body?.message === 'string') return body.message;
    if (Array.isArray(body?.message)) return body.message.join(', ');
    if (typeof body?.error === 'string') return body.error;
    return err.message || `HTTP ${err.status}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
