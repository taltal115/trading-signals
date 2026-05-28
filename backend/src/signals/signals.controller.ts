import { Controller, Get, Query } from '@nestjs/common';
import { FirestoreService } from '../firebase/firestore.service';

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(n), 1), max);
}

@Controller('signals')
export class SignalsController {
  constructor(private readonly firestore: FirestoreService) {}

  @Get()
  async list(
    @Query('limit') limitStr?: string,
    @Query('cursor') cursor?: string,
  ) {
    const limit = parsePositiveInt(limitStr, 10, 50);
    return this.firestore.listSignalInstancesPage(limit, cursor?.trim() || undefined);
  }
}
