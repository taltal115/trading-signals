import { Module } from '@nestjs/common';
import { SignalsController } from './signals.controller';

@Module({
  controllers: [SignalsController],
})
export class SignalsModule {}
