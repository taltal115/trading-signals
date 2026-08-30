import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { FirestoreService } from '../firebase/firestore.service';
import { utcDatetimeLexId } from '../firebase/my-position-doc-id';
import { GithubWorkflowService } from './github-workflow.service';
import { ResearchLocalRunnerService } from './research-local-runner.service';

@Controller('github')
@UseGuards(SessionAuthGuard)
export class GithubWorkflowController {
  private readonly log = new Logger(GithubWorkflowController.name);

  constructor(
    private readonly workflows: GithubWorkflowService,
    private readonly firestore: FirestoreService,
    private readonly localResearch: ResearchLocalRunnerService,
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

    const preferLocal = this.localResearch.preferLocal();
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
      trigger: {
        source: 'ui',
        actor,
        runner: preferLocal ? 'local' : 'github_actions',
      },
    });

    const localParams = {
      runId,
      since,
      until: untilRaw || undefined,
      actionableOnly: actionable,
      includeImmature,
      limitRuns,
      notifySlack,
      actor,
    };

    if (preferLocal) {
      this.localResearch.start(localParams);
      return { ok: true, run_id: runId, runner: 'local' as const };
    }

    try {
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
      return { ok: true, run_id: runId, runner: 'github_actions' as const };
    } catch (e) {
      // Workflow not on remote main yet (or wrong repo) — fall back to local Python.
      if (e instanceof NotFoundException) {
        this.log.warn(
          `GHA research workflow missing; falling back to local runner for ${runId}`,
        );
        try {
          await this.firestore.createResearchRunQueued(runId, {
            trigger: { source: 'ui', actor, runner: 'local_fallback' },
          });
          this.localResearch.start(localParams);
          return { ok: true, run_id: runId, runner: 'local_fallback' as const };
        } catch (localErr) {
          await this.firestore.createResearchRunQueued(runId, {
            status: 'failed',
            finished_at_utc: new Date().toISOString(),
            error: String(
              localErr instanceof Error ? localErr.message : localErr,
            ).slice(0, 800),
          });
          throw localErr;
        }
      }
      await this.firestore.createResearchRunQueued(runId, {
        status: 'failed',
        finished_at_utc: new Date().toISOString(),
        error: String(e instanceof Error ? e.message : e).slice(0, 800),
      });
      throw e;
    }
  }
}
