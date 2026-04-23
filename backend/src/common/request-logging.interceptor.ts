import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

const REDACT = [/authorization/i, /cookie/i, /token/i, /secret/i];

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly log = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      method: string;
      originalUrl: string;
      session?: unknown;
    }>();
    const start = Date.now();
    const path = req.originalUrl?.split('?')[0] || '';
    return next.handle().pipe(
      tap({
        next: () => {
          const res = context.switchToHttp().getResponse<{ statusCode: number }>();
          const ms = Date.now() - start;
          this.log.log(`${req.method} ${path} ${res.statusCode} ${ms}ms`);
        },
        error: (err: Error & { status?: number }) => {
          const ms = Date.now() - start;
          const status = err.status ?? 500;
          const msg = err.message?.slice(0, 200) || 'error';
          const quietMarketCandles =
            path === '/api/market/candles' && (status === 503 || status === 400);
          if (quietMarketCandles) {
            this.log.debug(`${req.method} ${path} ${status} ${ms}ms — ${msg}`);
          } else {
            this.log.warn(`${req.method} ${path} ${status} ${ms}ms — ${msg}`);
          }
        },
      })
    );
  }
}
