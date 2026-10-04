import { Controller, Get } from '@nestjs/common';
import type { OperationsSummary, WorkQueue } from '@jobwork/contracts';
import { DomainError } from '../../../platform/http/domain-error';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { SummaryRepository, type QueueCount } from '../infrastructure/summary.repository';

/** Platform-shaped actor: the summary needs roles, not the whole identity module. */
interface ActorLike {
  isInternal: boolean;
  roles: string[];
}

interface QueueDefinition {
  key: WorkQueue['key'];
  label: string;
  detail: string;
  href: string;
  /** Roles that may act on this queue. A count nobody can act on is noise or a leak. */
  roles: readonly string[];
  load: (repo: SummaryRepository) => Promise<QueueCount>;
}

const QUEUES: QueueDefinition[] = [
  {
    key: 'enquiries_awaiting_triage',
    label: 'Enquiries awaiting triage',
    detail: 'Submitted by a customer and not yet reviewed.',
    href: '/intake',
    roles: ['jobwork_sourcing', 'jobwork_engineering', 'platform_admin'],
    load: (repo) => repo.enquiriesAwaitingTriage(),
  },
  {
    key: 'clarifications_awaiting_customer',
    label: 'Clarifications with the customer',
    detail: 'Asked and unanswered. Chase before the enquiry goes cold.',
    href: '/intake',
    roles: ['jobwork_sourcing', 'jobwork_engineering', 'platform_admin'],
    load: (repo) => repo.clarificationsAwaitingCustomer(),
  },
  {
    key: 'supplier_files_awaiting_decision',
    label: 'Supplier files awaiting a decision',
    detail: 'Complete files a supplier has sent for admission.',
    href: '/suppliers?status=submitted',
    roles: ['jobwork_sourcing', 'platform_admin'],
    load: (repo) => repo.supplierFilesAwaitingDecision(),
  },
  {
    key: 'supplier_applications_received',
    label: 'Workshops asking to join',
    detail: 'Applications from the public form, not yet admitted or declined.',
    href: '/suppliers/applications',
    roles: ['jobwork_sourcing', 'platform_admin'],
    load: (repo) => repo.supplierApplicationsReceived(),
  },
  {
    key: 'supplier_evidence_awaiting_review',
    label: 'Evidence awaiting review',
    detail: 'GST, PAN, bank and certificates waiting on a reviewer.',
    href: '/suppliers/verification',
    roles: ['jobwork_sourcing', 'jobwork_quality', 'platform_admin'],
    load: (repo) => repo.supplierEvidenceAwaitingReview(),
  },
  {
    key: 'suppliers_unmatchable',
    label: 'Admitted suppliers not matchable',
    detail: 'In the network but out of matching — usually lapsed evidence.',
    href: '/suppliers?excludedOnly=true',
    roles: ['jobwork_sourcing', 'platform_admin'],
    load: (repo) => repo.suppliersUnmatchable(),
  },
  {
    key: 'rfqs_in_evaluation',
    label: 'Rounds to evaluate',
    detail: 'Closed with bids in; waiting on a comparison and an award.',
    href: '/rfqs?status=evaluation',
    roles: ['jobwork_sourcing', 'jobwork_sales'],
    load: (repo) => repo.rfqsInEvaluation(),
  },
  {
    key: 'approvals_pending',
    label: 'Approvals waiting',
    detail: 'Awards, cost sheets and quotations that need a second pair of eyes.',
    href: '/approvals',
    roles: ['jobwork_sourcing', 'jobwork_sales', 'jobwork_finance'],
    load: (repo) => repo.approvalsPending(),
  },
  {
    key: 'orders_awaiting_release',
    label: 'Orders waiting on payment or credit',
    detail: 'Accepted quotations whose advance has not arrived and no credit covers them yet.',
    href: '/sales-orders?status=pending_commercial_release',
    roles: ['jobwork_finance', 'jobwork_sales'],
    load: (repo) => repo.ordersAwaitingRelease(),
  },
  {
    key: 'purchase_orders_to_issue',
    label: 'Purchase orders to issue',
    detail: 'Accepted orders whose awarded suppliers have no purchase order yet.',
    href: '/sales-orders',
    roles: ['jobwork_sourcing'],
    load: (repo) => repo.purchaseOrdersToIssue(),
  },
  {
    key: 'payments_unmatched',
    label: 'Receipts in suspense',
    detail: 'Money received that is not yet tied to an invoice. Allocate it, with a colleague’s approval.',
    href: '/finance',
    roles: ['jobwork_finance'],
    load: (repo) => repo.paymentsUnmatched(),
  },
  {
    key: 'baselines_to_release',
    label: 'Baselines to release',
    detail: 'Purchase orders are out but no technical baseline has been released to manufacture to.',
    href: '/sales-orders',
    roles: ['jobwork_engineering', 'jobwork_sourcing'],
    load: (repo) => repo.baselinesToRelease(),
  },
  {
    key: 'work_packages_to_release',
    label: 'Work packages waiting for release',
    detail: 'Planned work that cannot start until every release gate is green.',
    href: '/sales-orders',
    roles: ['jobwork_sourcing', 'jobwork_engineering'],
    load: (repo) => repo.workPackagesToRelease(),
  },
  {
    key: 'milestones_to_verify',
    label: 'Milestone evidence to verify',
    detail: 'Suppliers have submitted evidence. Submitted is not verified.',
    href: '/production',
    roles: ['jobwork_quality'],
    load: (repo) => repo.milestonesToVerify(),
  },
  {
    key: 'leakage_reviews_open',
    label: 'Messages held for review',
    detail: 'They may name a party or carry contact details; nobody outside sees them until decided.',
    href: '/leakage-reviews',
    roles: ['jobwork_support', 'jobwork_sourcing'],
    load: (repo) => repo.leakageReviewsOpen(),
  },
  {
    key: 'invitations_pending',
    label: 'Invitations not yet accepted',
    detail: 'People who cannot sign in yet. Resend if the link went stale.',
    href: '/organizations',
    roles: ['platform_admin', 'security_admin'],
    load: (repo) => repo.invitationsPending(),
  },
];

/**
 * `GET /operations/summary` — what is waiting, how much of it, and how old the oldest
 * item is (F-OPS.2). Role-filtered by construction: a queue the actor cannot act on is
 * absent from the payload rather than present as a zero.
 */
@Controller('operations')
export class OperationsSummaryController {
  constructor(private readonly repo: SummaryRepository) {}

  @Get('summary')
  async summary(@CurrentActor() actor: ActorLike): Promise<OperationsSummary> {
    if (!actor.isInternal) {
      throw new DomainError('NOT_AUTHORIZED', 403, 'Internal audience only');
    }
    const mine = QUEUES.filter((queue) => queue.roles.some((role) => actor.roles.includes(role)));
    const queues = await Promise.all(
      mine.map(async (queue): Promise<WorkQueue> => {
        const { count, oldestWaitingSince } = await queue.load(this.repo);
        return {
          key: queue.key,
          label: queue.label,
          detail: queue.detail,
          count,
          oldestWaitingSince: oldestWaitingSince ? oldestWaitingSince.toISOString() : null,
          href: queue.href,
        };
      }),
    );
    return { queues, generatedAt: new Date().toISOString() };
  }
}
