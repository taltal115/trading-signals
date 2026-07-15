import { Controller, Get, Query } from '@nestjs/common';
import { FirestoreService } from '../firebase/firestore.service';

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(n), 1), max);
}

/**
 * Flat `/api/ai-evals` routes (avoids nesting under `/api/signals/...`).
 * Kept in sync with SignalsController aliases for compatibility.
 */
@Controller('ai-evals')
export class AiEvalsController {
  constructor(private readonly firestore: FirestoreService) {}

  @Get('recent')
  async recent(@Query('limit') limitStr?: string) {
    const limit = parsePositiveInt(limitStr, 200, 500);
    const rows = await this.firestore.listAiEvalsRecent(limit);
    return { rows };
  }

  @Get()
  async list(
    @Query('signalDocId') signalDocId?: string,
    @Query('ticker') ticker?: string,
    @Query('limit') limitStr?: string,
  ) {
    const limit = parsePositiveInt(limitStr, 40, 100);
    const rows = await this.firestore.listAiEvalsForSignal(
      String(signalDocId || ''),
      String(ticker || ''),
      limit,
    );
    return { rows };
  }
}
