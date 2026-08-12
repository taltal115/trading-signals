import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { FirestoreService } from '../firebase/firestore.service';

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(n), 1), max);
}

@Controller('research')
@UseGuards(SessionAuthGuard)
export class ResearchController {
  constructor(private readonly firestore: FirestoreService) {}

  @Get('runs')
  async list(@Query('limit') limitStr?: string) {
    const limit = parsePositiveInt(limitStr, 30, 100);
    const rows = await this.firestore.listResearchRuns(limit);
    return { rows };
  }

  @Get('runs/:id')
  async get(@Param('id') id: string) {
    const row = await this.firestore.getResearchRun(id);
    if (!row) {
      throw new NotFoundException(`research run ${id} not found`);
    }
    return row;
  }
}
