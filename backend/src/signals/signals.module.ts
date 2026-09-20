import { Module } from '@nestjs/common';
import { AiEvalsController } from './ai-evals.controller';
import { SignalsController } from './signals.controller';
import { SignalLifecycleService } from './signal-lifecycle.service';
import { NewsArticlesService } from './news-articles.service';

@Module({
  controllers: [AiEvalsController, SignalsController],
  providers: [SignalLifecycleService, NewsArticlesService],
})
export class SignalsModule {}
