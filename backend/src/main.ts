import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  if (config.get<string>('nodeEnv') === 'production') {
    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.set('trust proxy', 1);
  }

  app.setGlobalPrefix('api');

  app.use(cookieParser());
  app.use(
    session({
      name: 'signals.sid',
      secret: config.getOrThrow<string>('sessionSecret'),
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 7 * 24 * 3600 * 1000,
        httpOnly: true,
        secure: config.get<string>('nodeEnv') === 'production',
        sameSite: 'lax',
      },
    })
  );

  const frontendUrl = config.get<string>('frontendUrl') || 'http://localhost:4200';
  app.enableCors({
    origin: [frontendUrl, /^https?:\/\/localhost(?::\d+)?$/],
    credentials: true,
  });

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
  logger.log(`API listening on http://localhost:${port}/api (CORS: ${frontendUrl})`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
