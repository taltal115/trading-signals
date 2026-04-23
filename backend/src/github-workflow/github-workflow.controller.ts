import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { FirestoreService } from '../firebase/firestore.service';
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

  @Post('workflows/bot-scan')
  async botScan(@Body() body: { ticker?: string }) {
    const t = String(body?.ticker ?? '').trim();
    if (!t) throw new BadRequestException('ticker is required');
    const sym = t.toUpperCase().slice(0, 16);
    await this.workflows.dispatch('trading-bot-scan.yml', { ticker: sym });
    return { ok: true };
  }

  @Post('workflows/ai-stock-eval')
  async aiStockEval(
    @Req() req: Request,
    @Body() body: { ticker?: string; signal_doc_id?: string },
  ) {
    const uid = req.sessionUser!.uid;
    const ticker = String(body?.ticker ?? '').trim();
    const signalDocId = String(body?.signal_doc_id ?? '').trim();
    if (!ticker) throw new BadRequestException('ticker is required');
    if (!signalDocId) throw new BadRequestException('signal_doc_id is required');
    const sym = ticker.toUpperCase().slice(0, 16);
    const pos = await this.firestore.findOpenPositionForSignal(uid, sym, signalDocId);
    const inputs: Record<string, string> = {
      ticker: sym,
      signal_doc_id: signalDocId,
      position_id: pos?.id ?? '',
      owner_uid: pos ? uid : '',
    };
    await this.workflows.dispatch('ai-stock-eval.yml', inputs);
    return { ok: true };
  }
}
