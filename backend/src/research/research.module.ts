import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirebaseModule } from '../firebase/firebase.module';
import { ResearchController } from './research.controller';

@Module({
  imports: [AuthModule, FirebaseModule],
  controllers: [ResearchController],
})
export class ResearchModule {}
