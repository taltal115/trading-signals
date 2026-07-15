import { Module } from '@nestjs/common';
import { AiEvalsController } from './ai-evals.controller';
import { SignalsController } from './signals.controller';

@Module({
  controllers: [AiEvalsController, SignalsController],
})
export class SignalsModule {}
