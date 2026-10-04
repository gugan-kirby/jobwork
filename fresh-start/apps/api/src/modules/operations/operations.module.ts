import { Module } from '@nestjs/common';
import { QueueService } from './application/queue.command';
import { SlaConfigService } from './application/sla-config.command';
import { SlaSweep } from './application/sla-sweep.command';
import { QueueRepository } from './infrastructure/queue.repository';
import { PortalSummaryRepository } from './infrastructure/summary.repository';
import { InternalSlaController, QueuesController, SlaController } from './presentation/queues.controller';
import { OperationsSummaryController } from './presentation/summary.controller';
import { PortalSummaryController } from './presentation/portal-summary.controller';

/**
 * Both audiences' view of their own workload — operations and the customer portal —
 * and the work queues with their service targets (F-11.1).
 */
@Module({
  controllers: [OperationsSummaryController, PortalSummaryController, QueuesController, SlaController, InternalSlaController],
  providers: [PortalSummaryRepository, QueueRepository, QueueService, SlaConfigService, SlaSweep],
})
export class OperationsModule {}
