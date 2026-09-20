import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { HealthService } from './health.service';
import { HealthStatusResponse, IntegrationHealth } from './dto/health-status.dto';

@Controller('health')
@UseGuards(SessionAuthGuard)
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('status')
  async getStatus(): Promise<HealthStatusResponse> {
    return this.healthService.getHealthStatus();
  }

  /** Re-check a single provider (Health page row Refresh). */
  @Get('status/:id')
  async getProvider(@Param('id') id: string): Promise<IntegrationHealth> {
    return this.healthService.getIntegrationHealth(id);
  }
}
