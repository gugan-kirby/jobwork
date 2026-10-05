import { Module } from '@nestjs/common';
import { CommercialModule } from '../commercial';
import { IamModule } from '../iam';
import { DeviationCommand } from './application/deviation.command';
import { InspectionCommand } from './application/inspection.command';
import { InstrumentCommand } from './application/instrument.command';
import { NcrCommand } from './application/ncr.command';
import { QualityPlanCommand } from './application/quality-plan.command';
import { QualityReleaseCommand } from './application/quality-release.command';
import { NcrRepository } from './infrastructure/ncr.repository';
import { QualityRepository } from './infrastructure/quality.repository';
import { ReleaseRepository } from './infrastructure/release.repository';
import {
  CustomerDeviationController,
  DeviationController,
  InspectionController,
  InstrumentController,
  NcrController,
  QualityPlanController,
  QualityReleaseController,
  SupplierInspectionController,
  SupplierNcrController,
} from './presentation/quality.controller';

/** Quality plans, inspections and instruments (IN-14): it reads work packages and baselines, and owns only its own records. */
@Module({
  imports: [IamModule, CommercialModule],
  controllers: [QualityPlanController, InspectionController, SupplierInspectionController, InstrumentController, NcrController, SupplierNcrController, DeviationController, CustomerDeviationController, QualityReleaseController],
  exports: [QualityReleaseCommand],
  providers: [QualityRepository, NcrRepository, ReleaseRepository, QualityReleaseCommand, QualityPlanCommand, InstrumentCommand, InspectionCommand, NcrCommand, DeviationCommand],
})
export class QualityModule {}
