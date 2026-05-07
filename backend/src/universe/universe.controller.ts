import { Controller, Get, Param, Query } from '@nestjs/common';
import { FirestoreService } from '../firebase/firestore.service';

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(n), 1), max);
}

function parseNonNegInt(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(n), 0), max);
}

@Controller('universe')
export class UniverseController {
  constructor(private readonly firestore: FirestoreService) {}

  /** Snapshot list: lightweight rows + `nextCursor` (last doc id) for the next page. */
  @Get()
  async list(
    @Query('limit') limitStr?: string,
    @Query('cursor') cursor?: string,
  ) {
    const limit = parsePositiveInt(limitStr, 5, 50);
    return this.firestore.listUniversePage(limit, cursor?.trim() || undefined);
  }

  /** Symbol rows for one snapshot — paginated; avoids sending the full symbol table to the client at once. */
  @Get(':id/symbols')
  async symbolPage(
    @Param('id') id: string,
    @Query('offset') offsetStr?: string,
    @Query('limit') limitStr?: string,
  ) {
    const offset = parseNonNegInt(offsetStr, 0, 500_000);
    const limit = parsePositiveInt(limitStr, 3, 100);
    return this.firestore.getUniverseSymbolPage(id, offset, limit);
  }
}
