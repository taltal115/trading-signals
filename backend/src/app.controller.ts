import { Controller, Get } from '@nestjs/common';
import { getAppVersions } from './app-versions';

@Controller()
export class AppController {
  @Get('health')
  health() {
    return getAppVersions();
  }
}
