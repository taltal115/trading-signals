import { join } from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import configuration from './config/configuration';
import { RequestLoggingInterceptor } from './common/request-logging.interceptor';
import { FirebaseModule } from './firebase/firebase.module';
import { MonitorModule } from './monitor/monitor.module';
import { PositionsModule } from './positions/positions.module';
import { SignalsModule } from './signals/signals.module';
import { UniverseModule } from './universe/universe.module';
import { MarketModule } from './market/market.module';
import { GithubWorkflowModule } from './github-workflow/github-workflow.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // When you `cd backend && npm run start:dev`, load repo-root `.env` as well as `backend/.env`.
      envFilePath: [join(process.cwd(), '.env'), join(process.cwd(), '..', '.env')],
    }),
    FirebaseModule,
    AuthModule,
    UniverseModule,
    MarketModule,
    SignalsModule,
    PositionsModule,
    MonitorModule,
    GithubWorkflowModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
  ],
})
export class AppModule {}
