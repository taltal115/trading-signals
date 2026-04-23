import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import { FirestoreSessionStore } from './auth/firestore-session.store';
import { AppModule } from './app.module';
import { FirestoreService } from './firebase/firestore.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  if (config.get<string>('nodeEnv') === 'production') {
    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.set('trust proxy', 1);
    const altHost = (config.get<string>('altHostingHostname') || '').toLowerCase();
    const fe = (config.get<string>('frontendUrl') || '').replace(/\/$/, '');
    if (altHost && fe && !fe.includes('localhost')) {
      expressApp.use((req: Request, res: Response, next: NextFunction) => {
        const raw = (req.get('x-forwarded-host') || req.hostname || '')
          .split(',')[0]
          .trim()
          .toLowerCase();
        if (raw === altHost) {
          const path = req.originalUrl || req.url || '';
          return res.redirect(307, `${fe}${path}`);
        }
        next();
      });
      logger.log(`Alt host ${altHost} → 307 to ${fe} (single origin for session cookie)`);
    }
  }

  app.setGlobalPrefix('api');

  const sessionMaxAgeMs = 7 * 24 * 3600 * 1000;
  const nodeEnv = config.get<string>('nodeEnv');
  const sessionStore =
    nodeEnv === 'production'
      ? new FirestoreSessionStore(app.get(FirestoreService), sessionMaxAgeMs)
      : undefined;
  if (sessionStore) {
    logger.log('Sessions stored in Firestore (_nest_sessions) for Cloud Run multi-instance');
  }

  const sessionCookieName = config.get<string>('sessionCookieName') || 'signals.sid';

  app.use(cookieParser());
  app.use(
    session({
      name: sessionCookieName,
      secret: config.getOrThrow<string>('sessionSecret'),
      resave: false,
      saveUninitialized: false,
      store: sessionStore,
      proxy: nodeEnv === 'production',
      cookie: {
        maxAge: sessionMaxAgeMs,
        httpOnly: true,
        secure: nodeEnv === 'production',
        sameSite: 'lax',
      },
    })
  );

  const frontendUrl = config.get<string>('frontendUrl') || 'http://localhost:4200';
  if (process.env.K_SERVICE && frontendUrl.includes('localhost')) {
    logger.error(
      'Cloud Run: FRONTEND_URL is still localhost — OAuth redirect_uri will be wrong. Set FRONTEND_URL to your HTTPS Hosting origin (e.g. https://trading-goals.web.app) and redeploy.',
    );
  }
  const alt = (config.get<string>('altHostingHostname') || '').trim();
  const corsOrigins: (string | RegExp)[] = [
    frontendUrl,
    /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/,
  ];
  if (alt) {
    corsOrigins.splice(1, 0, `https://${alt}`);
  }
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
  logger.log(`API listening on http://localhost:${port}/api (CORS: ${frontendUrl})`);
  const gid = config.get<string>('googleClientId') || '';
  const gsec = config.get<string>('googleClientSecret') || '';
  if (gid && gsec) {
    logger.log(`Google OAuth client_id loaded (prefix ${gid.split('-')[0]?.slice(0, 12) || '?'}…)`);
    const cb = config.get<string>('googleCallbackUrl') || '';
    if (cb) {
      logger.log(
        `Google OAuth callback URL is "${cb}" — add this exact URI to the Web client Authorized redirect URIs in Google Cloud Console.`,
      );
    }
  } else {
    const missing = [!gid && 'GOOGLE_CLIENT_ID', !gsec && 'GOOGLE_CLIENT_SECRET'].filter(Boolean).join(', ');
    logger.warn(
      `Google OAuth incomplete (missing ${missing}) — /api/auth/google returns 503 until both are set (local .env or Cloud Run env/secrets).`,
    );
  }
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
