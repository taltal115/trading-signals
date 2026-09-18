import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirebaseModule } from '../firebase/firebase.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [AuthModule, FirebaseModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
