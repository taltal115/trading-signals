import { Controller, Get } from '@nestjs/common';
import { FirestoreService } from '../firebase/firestore.service';

@Controller('signals')
export class SignalsController {
  constructor(private readonly firestore: FirestoreService) {}

  @Get()
  async list() {
    const docs = await this.firestore.listSignals(25);
    return { docs };
  }
}
