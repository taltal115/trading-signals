import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GithubWorkflowController } from './github-workflow.controller';
import { GithubWorkflowService } from './github-workflow.service';

@Module({
  imports: [AuthModule],
  controllers: [GithubWorkflowController],
  providers: [GithubWorkflowService],
})
export class GithubWorkflowModule {}
