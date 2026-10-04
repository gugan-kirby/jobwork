import { Module } from '@nestjs/common';
import { QueueService } from './application/queue.command';
import { SlaConfigService } from './application/sla-config.command';
import { SlaSweep } from './application/sla-sweep.command';
import { IamModule } from '../iam';
import { ControlsRepository } from './infrastructure/controls.repository';
import { OperationsMetrics } from './infrastructure/operations.metrics';
import { QueueRepository } from './infrastructure/queue.repository';
import { PortalSummaryRepository } from './infrastructure/summary.repository';
import { InternalSlaController, QueuesController, SlaController } from './presentation/queues.controller';
import { OperationsControlsController } from './presentation/controls.controller';
import { OperationsSummaryController } from './presentation/summary.controller';
import { PortalSummaryController } from './presentation/portal-summary.controller';

/**
 * Both audiences' view of their own workload — operations and the customer portal —
 * the work queues with their service targets (F-11.1), and the business-control panel
 * and gauges (F-11.3).
 */
@Module({
  imports: [IamModule],
  controllers: [OperationsSummaryController, OperationsControlsController, PortalSummaryController, QueuesController, SlaController, InternalSlaController],
  providers: [PortalSummaryRepository, QueueRepository, QueueService, SlaConfigService, SlaSweep, ControlsRepository, OperationsMetrics],
})
export class OperationsModule {}
