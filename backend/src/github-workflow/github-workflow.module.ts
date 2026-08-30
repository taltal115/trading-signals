import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirebaseModule } from '../firebase/firebase.module';
import { GithubWorkflowController } from './github-workflow.controller';
import { GithubWorkflowService } from './github-workflow.service';
import { ResearchLocalRunnerService } from './research-local-runner.service';

@Module({
  imports: [AuthModule, FirebaseModule],
  controllers: [GithubWorkflowController],
  providers: [GithubWorkflowService, ResearchLocalRunnerService],
})
export class GithubWorkflowModule {}
