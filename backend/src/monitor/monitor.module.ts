import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MonitorController } from './monitor.controller';

@Module({
  imports: [AuthModule],
  controllers: [MonitorController],
})
export class MonitorModule {}
