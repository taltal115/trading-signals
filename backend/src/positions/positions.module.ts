import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PositionsController } from './positions.controller';

@Module({
  imports: [AuthModule],
  controllers: [PositionsController],
})
export class PositionsModule {}
