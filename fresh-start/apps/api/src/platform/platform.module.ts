import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditWriter } from './commands/audit.writer';
import { CommandExecutor } from './commands/execute';
import { OutboxWriter } from './commands/outbox.writer';
import { ConfigService } from './config/config.service';
import { DatabaseService } from './database/database.service';
import { AuditController } from './presentation/audit.controller';
import { ServicePrincipalGuard } from './http/service-principal.guard';

@Global()
@Module({
  controllers: [AuditController],
  providers: [
    ConfigService,
    DatabaseService,
    AuditWriter,
    OutboxWriter,
    CommandExecutor,
    { provide: APP_GUARD, useClass: ServicePrincipalGuard },
  ],
  exports: [ConfigService, DatabaseService, AuditWriter, OutboxWriter, CommandExecutor],
})
export class PlatformModule {}
