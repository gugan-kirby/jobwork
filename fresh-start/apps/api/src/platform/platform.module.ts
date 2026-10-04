import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditWriter } from './commands/audit.writer';
import { CommandExecutor } from './commands/execute';
import { OutboxWriter } from './commands/outbox.writer';
import { ConfigService } from './config/config.service';
import { DatabaseService } from './database/database.service';
import { AuditController } from './presentation/audit.controller';
import { ServicePrincipalGuard } from './http/service-principal.guard';
import { RateLimitInterceptor } from './http/rate-limit/rate-limit.interceptor';
import { MetricsService } from './metrics/metrics.service';

@Global()
@Module({
  controllers: [AuditController],
  providers: [
    ConfigService,
    DatabaseService,
    MetricsService,
    AuditWriter,
    OutboxWriter,
    CommandExecutor,
    { provide: APP_GUARD, useClass: ServicePrincipalGuard },
    RateLimitInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: RateLimitInterceptor },
  ],
  exports: [ConfigService, DatabaseService, MetricsService, RateLimitInterceptor, AuditWriter, OutboxWriter, CommandExecutor],
})
export class PlatformModule {}
