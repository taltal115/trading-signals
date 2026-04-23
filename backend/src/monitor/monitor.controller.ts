import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { FirestoreService } from '../firebase/firestore.service';

@Controller('monitor')
@UseGuards(SessionAuthGuard)
export class MonitorController {
  constructor(private readonly firestore: FirestoreService) {}

  @Get('checks')
  async checks(@Req() req: Request) {
    const uid = req.sessionUser!.uid;
    const docs = await this.firestore.listMonitorChecks(uid);
    return { docs };
  }
}
