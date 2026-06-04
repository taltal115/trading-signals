import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { FirestoreService } from '../firebase/firestore.service';

@Controller('events')
@UseGuards(SessionAuthGuard)
export class EventsController {
  constructor(private readonly firestore: FirestoreService) {}

  @Get('latest')
  async latest(@Req() _req: Request) {
    return this.firestore.getLatestStockEvents();
  }
}
