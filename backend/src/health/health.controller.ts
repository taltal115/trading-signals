import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { HealthService } from './health.service';
import { HealthStatusResponse } from './dto/health-status.dto';

@Controller('health')
@UseGuards(SessionAuthGuard)
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('status')
  async getStatus(): Promise<HealthStatusResponse> {
    return this.healthService.getHealthStatus();
  }
}
