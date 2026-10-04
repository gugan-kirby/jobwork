import { Module } from '@nestjs/common';
import { IamModule } from '../iam';
import { SourcingModule } from '../sourcing';
import { DecideApprovalCommand } from './application/approval.command';
import { ApprovalEffectRegistry } from './application/approval-effects';
import { ProposeAwardCommand } from './application/award.command';
import { CommercialView } from './application/commercial-view';
import { CostSheetCommand } from './application/cost-sheet.command';
import { CreateEvaluationCommand } from './application/evaluate.command';
import { QuoteCommand } from './application/quote.command';
import { CommercialRepository } from './infrastructure/commercial.repository';
import { CustomerQuotesController } from './presentation/customer-quotes.controller';
import {
  ApprovalsController,
  CostSheetsController,
  EvaluationAwardController,
  InternalQuotesController,
  QuotesController,
} from './presentation/internal.controller';

/**
 * Evaluation, award, cost sheet, customer quote (IN-07). Depends on sourcing for the
 * bids it evaluates and the RFQ it closes; nothing in sourcing depends on it.
 */
@Module({
  imports: [IamModule, SourcingModule],
  controllers: [
    // The customer surface is its own controller so no internal handler can answer a
    // customer's request by accident (doc 03 §7).
    CustomerQuotesController,
    InternalQuotesController,
    QuotesController,
    ApprovalsController,
    CostSheetsController,
    EvaluationAwardController,
  ],
  providers: [
    CommercialRepository,
    CommercialView,
    ApprovalEffectRegistry,
    CreateEvaluationCommand,
    ProposeAwardCommand,
    DecideApprovalCommand,
    CostSheetCommand,
    QuoteCommand,
  ],
  exports: [CommercialRepository, CommercialView, ApprovalEffectRegistry],
})
export class CommercialModule {}
