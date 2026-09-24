import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { FirestoreService } from '../firebase/firestore.service';

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(n), 1), max);
}

function parseTag(raw: string | undefined): 'all' | 'WAIT' | 'SELL' {
  const v = String(raw || 'all')
    .trim()
    .toUpperCase();
  if (v === 'WAIT' || v === 'SELL') return v;
  return 'all';
}

function parseAiAdvice(raw: string | undefined): 'all' | 'has' | 'none' {
  const v = String(raw || 'all')
    .trim()
    .toLowerCase();
  if (v === 'has' || v === 'none') return v;
  return 'all';
}

@Controller('monitor')
@UseGuards(SessionAuthGuard)
export class MonitorController {
  constructor(private readonly firestore: FirestoreService) {}

  @Get('checks')
  async checks(
    @Req() req: Request,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursor?: string,
    @Query('tag') tagRaw?: string,
    @Query('aiAdvice') aiAdviceRaw?: string,
  ) {
    const uid = req.sessionUser!.uid;
    const limit = parsePositiveInt(limitStr, 20, 50);
    return this.firestore.listMonitorChecksPage(uid, {
      limit,
      cursor: cursor?.trim() || undefined,
      tag: parseTag(tagRaw),
      aiAdvice: parseAiAdvice(aiAdviceRaw),
    });
  }
}
