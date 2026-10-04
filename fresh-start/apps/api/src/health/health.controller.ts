import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@jobwork/contracts';
import { ConfigService } from '../platform/config/config.service';
import { DatabaseService } from '../platform/database/database.service';
import { Public } from '../platform/http/public.decorator';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
  ) {}

  @Get()
  async health(): Promise<HealthResponse> {
    const dbOk = await this.db.ping();
    return {
      status: dbOk ? 'ok' : 'degraded',
      service: 'api',
      version: this.config.buildVersion,
      time: new Date().toISOString(),
      db: dbOk ? 'ok' : 'fail',
    };
  }
}
