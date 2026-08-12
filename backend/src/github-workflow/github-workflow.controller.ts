import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { FirestoreService } from '../firebase/firestore.service';
import { utcDatetimeLexId } from '../firebase/my-position-doc-id';
import { GithubWorkflowService } from './github-workflow.service';

@Controller('github')
@UseGuards(SessionAuthGuard)
export class GithubWorkflowController {
  constructor(
    private readonly workflows: GithubWorkflowService,
    private readonly firestore: FirestoreService,
  ) {}

  @Post('workflows/position-monitor')
  async positionMonitor(@Body() body: { ticker?: string }) {
    const t = String(body?.ticker ?? '').trim();
    if (!t) throw new BadRequestException('ticker is required');
    const sym = t.toUpperCase().slice(0, 16);
    await this.workflows.dispatch('position-monitor.yml', { ticker: sym });
    return { ok: true };
  }

  @Post('workflows/profit-hold-research')
  async profitHoldResearch(
    @Body()
    body: {
      since?: string;
      until?: string;
      actionable_only?: boolean;
      include_immature?: boolean;
      limit_runs?: number | string;
      notify_slack?: boolean;
    },
    @Req() req: Request,
  ) {
    const since = String(body?.since ?? '2026-08-04').trim() || '2026-08-04';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      throw new BadRequestException('since must be YYYY-MM-DD');
    }
    const untilRaw = String(body?.until ?? '').trim();
    if (untilRaw && !/^\d{4}-\d{2}-\d{2}$/.test(untilRaw)) {
      throw new BadRequestException('until must be YYYY-MM-DD');
    }
    const limitRuns = Math.min(
      Math.max(Number.parseInt(String(body?.limit_runs ?? '200'), 10) || 200, 20),
      500,
    );
    const actionable = Boolean(body?.actionable_only);
    const includeImmature = Boolean(body?.include_immature);
    const notifySlack = body?.notify_slack !== false;
    const runId = utcDatetimeLexId(new Date());
    const actor =
      String((req as { user?: { email?: string; uid?: string } }).user?.email || '').trim() ||
      String((req as { user?: { uid?: string } }).user?.uid || '').trim() ||
      null;

    await this.firestore.createResearchRunQueued(runId, {
      status: 'queued',
      created_at_utc: new Date().toISOString(),
      params: {
        since,
        until: untilRaw || null,
        actionable_only: actionable,
        include_immature: includeImmature,
        limit_runs: limitRuns,
      },
      trigger: { source: 'ui', actor },
    });

    await this.workflows.dispatch('profit-hold-research.yml', {
      since,
      until: untilRaw,
      actionable_only: actionable ? 'true' : 'false',
      include_immature: includeImmature ? 'true' : 'false',
      limit_runs: String(limitRuns),
      run_id: runId,
      trigger_source: 'ui',
      notify_slack: notifySlack ? 'true' : 'false',
    });

    return { ok: true, run_id: runId };
  }
}
