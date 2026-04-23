import { Controller, Get } from '@nestjs/common';
import { FirestoreService } from '../firebase/firestore.service';

@Controller('universe')
export class UniverseController {
  constructor(private readonly firestore: FirestoreService) {}

  @Get()
  async list() {
    const docs = await this.firestore.listUniverse(30);
    return { docs };
  }
}
