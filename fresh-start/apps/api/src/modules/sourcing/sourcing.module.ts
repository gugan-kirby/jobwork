import { Module } from '@nestjs/common';
import { DmsModule } from '../dms';
import { IamModule } from '../iam';
import { SupplierModule } from '../supplier';
import { ApproveForSourcingCommand } from './application/approve-for-sourcing.command';
import { CancelEnquiryCommand } from './application/cancel-enquiry.command';
import { CopyEnquiryCommand } from './application/copy-enquiry.command';
import { DeclineEnquiryCommand } from './application/decline-enquiry.command';
import { RequestClarificationCommand } from './application/request-clarification.command';
import { SaveDraftCommand } from './application/save-draft.command';
import { StartTriageCommand } from './application/start-triage.command';
import { SubmitClarificationCommand } from './application/submit-clarification.command';
import { SubmitEnquiryCommand } from './application/submit-enquiry.command';
import { BidCommand } from './application/bid.command';
import { MatchSuppliersQuery } from './application/match-suppliers.query';
import { RfqDeadlineCommand } from './application/rfq-deadline.command';
import { RfqLifecycleCommand } from './application/rfq-lifecycle.command';
import { RfqView } from './application/rfq-view';
import { EnquiryRepository } from './infrastructure/enquiry.repository';
import { RfqRepository } from './infrastructure/rfq.repository';
import { InternalRfqController } from './presentation/internal-rfq.controller';
import { RfqsController } from './presentation/rfqs.controller';
import { SupplierRfqsController } from './presentation/supplier-rfqs.controller';
import { EnquiriesController } from './presentation/enquiries.controller';
import { IntakeController } from './presentation/intake.controller';

@Module({
  imports: [IamModule, DmsModule, SupplierModule],
  controllers: [
    EnquiriesController,
    IntakeController,
    // `supplier/rfqs` before `rfqs`: the supplier surface is its own controller so no
    // internal handler can ever answer a supplier's request by accident.
    SupplierRfqsController,
    RfqsController,
    InternalRfqController,
  ],
  providers: [
    EnquiryRepository,
    RfqRepository,
    RfqView,
    MatchSuppliersQuery,
    RfqLifecycleCommand,
    RfqDeadlineCommand,
    BidCommand,
    SaveDraftCommand,
    SubmitEnquiryCommand,
    CancelEnquiryCommand,
    CopyEnquiryCommand,
    StartTriageCommand,
    RequestClarificationCommand,
    SubmitClarificationCommand,
    ApproveForSourcingCommand,
    DeclineEnquiryCommand,
  ],
  exports: [EnquiryRepository, RfqRepository],
})
export class SourcingModule {}
