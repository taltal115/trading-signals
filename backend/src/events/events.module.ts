import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EventsController } from './events.controller';

@Module({
  imports: [AuthModule],
  controllers: [EventsController],
})
export class EventsModule {}
