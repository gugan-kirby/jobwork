import { Module } from '@nestjs/common';
import { IamModule } from '../iam';
import { InspectionCommand } from './application/inspection.command';
import { InstrumentCommand } from './application/instrument.command';
import { NcrCommand } from './application/ncr.command';
import { QualityPlanCommand } from './application/quality-plan.command';
import { NcrRepository } from './infrastructure/ncr.repository';
import { QualityRepository } from './infrastructure/quality.repository';
import { InspectionController, InstrumentController, NcrController, QualityPlanController, SupplierInspectionController, SupplierNcrController } from './presentation/quality.controller';

/** Quality plans, inspections and instruments (IN-14): it reads work packages and baselines, and owns only its own records. */
@Module({
  imports: [IamModule],
  controllers: [QualityPlanController, InspectionController, SupplierInspectionController, InstrumentController, NcrController, SupplierNcrController],
  providers: [QualityRepository, NcrRepository, QualityPlanCommand, InstrumentCommand, InspectionCommand, NcrCommand],
})
export class QualityModule {}
