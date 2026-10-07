import { Module } from '@nestjs/common';
import { CommercialModule } from '../commercial';
import { IamModule } from '../iam';
import { LogisticsModule } from '../logistics';
import { OrdersModule } from '../orders';
import { CaseCommand } from './application/case.command';
import { SupportRepository } from './infrastructure/support.repository';
import { CasesController, CustomerCasesController } from './presentation/support.controller';

/**
 * Support cases (IN-18 F-18.2; doc 04 §5 support module; doc 06 §15). It owns the case and its
 * timeline; every remedy is carried out by the module that owns it — orders' finance for money,
 * logistics for goods — through their exported services, inside the case's own transaction.
 */
@Module({
  imports: [IamModule, CommercialModule, OrdersModule, LogisticsModule],
  controllers: [CustomerCasesController, CasesController],
  providers: [SupportRepository, CaseCommand],
})
export class SupportModule {}
