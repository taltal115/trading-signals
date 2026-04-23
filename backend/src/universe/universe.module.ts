import { Module } from '@nestjs/common';
import { UniverseController } from './universe.controller';

@Module({
  controllers: [UniverseController],
})
export class UniverseModule {}
