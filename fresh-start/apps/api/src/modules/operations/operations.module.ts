import { Module } from '@nestjs/common';
import { PortalSummaryRepository, SummaryRepository } from './infrastructure/summary.repository';
import { OperationsSummaryController } from './presentation/summary.controller';
import { PortalSummaryController } from './presentation/portal-summary.controller';

/** Both audiences' view of their own workload: operations, and the customer portal. */
@Module({
  controllers: [OperationsSummaryController, PortalSummaryController],
  providers: [SummaryRepository, PortalSummaryRepository],
})
export class OperationsModule {}
