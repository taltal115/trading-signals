import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { FirestoreService } from '../firebase/firestore.service';

@Controller('positions')
@UseGuards(SessionAuthGuard)
export class PositionsController {
  constructor(private readonly firestore: FirestoreService) {}

  @Get()
  async list(@Req() req: Request) {
    const uid = req.sessionUser!.uid;
    const docs = await this.firestore.listPositions(uid);
    return { docs };
  }

  @Get(':id/checks')
  async checks(@Req() req: Request, @Param('id') id: string) {
    const uid = req.sessionUser!.uid;
    const docs = await this.firestore.listPositionChecks(uid, id);
    return { docs };
  }

  @Get(':id')
  async one(@Req() req: Request, @Param('id') id: string) {
    const uid = req.sessionUser!.uid;
    const row = await this.firestore.getPosition(uid, id);
    if (!row) throw new NotFoundException();
    return { doc: row };
  }

  @Post()
  async create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const uid = req.sessionUser!.uid;
    const created_at_utc = new Date().toISOString();
    const payload = {
      ticker: body['ticker'],
      entry_price: body['entry_price'],
      quantity: body['quantity'] ?? null,
      stop_price: body['stop_price'] ?? null,
      target_price: body['target_price'] ?? null,
      signal_doc_id: body['signal_doc_id'] ?? null,
      signal_confidence: body['signal_confidence'] ?? null,
      hold_days_from_signal: body['hold_days_from_signal'] ?? null,
      signal_close_price: body['signal_close_price'] ?? null,
      bought_at: body['bought_at'] ?? null,
      sector: body['sector'] ?? null,
      industry: body['industry'] ?? null,
      estimated_hold_days: body['estimated_hold_days'] ?? null,
      notes: body['notes'] ?? null,
      status: 'open',
      created_at_utc,
    };
    return this.firestore.addPosition(uid, payload);
  }

  @Patch(':id')
  async patch(
    @Req() req: Request,
    @Param('id') id: string,
    @Body()
    body: {
      status?: string;
      exit_price?: number;
      exit_at_utc?: string;
      exit_notes?: string | null;
      pnl_pct?: number | null;
      closed_at_utc?: string;
    }
  ) {
    const uid = req.sessionUser!.uid;
    const patch: Record<string, unknown> = {};
    if (body.status != null) patch['status'] = body.status;
    if (body.exit_price != null) patch['exit_price'] = body.exit_price;
    if (body.exit_at_utc != null) patch['exit_at_utc'] = body.exit_at_utc;
    if (body.exit_notes !== undefined) patch['exit_notes'] = body.exit_notes;
    if (body.pnl_pct !== undefined) patch['pnl_pct'] = body.pnl_pct;
    if (body.closed_at_utc != null) patch['closed_at_utc'] = body.closed_at_utc;
    await this.firestore.updatePosition(uid, id, patch);
    return { ok: true };
  }
}
