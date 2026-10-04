import { Module } from '@nestjs/common';
import { IamModule } from '../iam';
import { InspectionCommand } from './application/inspection.command';
import { InstrumentCommand } from './application/instrument.command';
import { QualityPlanCommand } from './application/quality-plan.command';
import { QualityRepository } from './infrastructure/quality.repository';
import { InspectionController, InstrumentController, QualityPlanController, SupplierInspectionController } from './presentation/quality.controller';

/** Quality plans, inspections and instruments (IN-14): it reads work packages and baselines, and owns only its own records. */
@Module({
  imports: [IamModule],
  controllers: [QualityPlanController, InspectionController, SupplierInspectionController, InstrumentController],
  providers: [QualityRepository, QualityPlanCommand, InstrumentCommand, InspectionCommand],
})
export class QualityModule {}
