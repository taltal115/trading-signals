import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { GithubWorkflowService } from './github-workflow.service';

@Controller('github')
@UseGuards(SessionAuthGuard)
export class GithubWorkflowController {
  constructor(private readonly workflows: GithubWorkflowService) {}

  @Post('workflows/position-monitor')
  async positionMonitor(@Body() body: { ticker?: string }) {
    const t = String(body?.ticker ?? '').trim();
    if (!t) throw new BadRequestException('ticker is required');
    const sym = t.toUpperCase().slice(0, 16);
    await this.workflows.dispatch('position-monitor.yml', { ticker: sym });
    return { ok: true };
  }
}
