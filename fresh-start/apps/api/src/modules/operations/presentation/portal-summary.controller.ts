import { Controller, Get } from '@nestjs/common';
import type { PortalQueue, PortalSummary } from '@jobwork/contracts';
import { DomainError } from '../../../platform/http/domain-error';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { PortalSummaryRepository, type QueueCount } from '../infrastructure/summary.repository';

interface ActorLike {
  isInternal: boolean;
  organizationId: string | null;
  organizationType: string | null;
}

/**
 * `GET /portal/summary` (F-CX.4) — the customer's counterpart of the operations command
 * center. Three questions, scoped to the caller's own organization: what is waiting on
 * me, what did I start and not finish, and what is under way.
 *
 * The unfinished-drafts count is the one that matters most: before this, a draft was a
 * dead end, and the portal never mentioned it again.
 */
@Controller('portal')
export class PortalSummaryController {
  constructor(private readonly repo: PortalSummaryRepository) {}

  @Get('summary')
  async summary(@CurrentActor() actor: ActorLike): Promise<PortalSummary> {
    if (actor.isInternal || actor.organizationType !== 'customer' || !actor.organizationId) {
      throw new DomainError('NOT_AUTHORIZED', 403, 'Customer organizations only');
    }
    const organizationId = actor.organizationId;
    const [questions, drafts, inProgress, quotations, orders, invoices, deliveries] = await Promise.all([
      this.repo.questionsAwaitingAnswer(organizationId),
      this.repo.draftsUnfinished(organizationId),
      this.repo.enquiriesInProgress(organizationId),
      this.repo.quotationsAwaitingDecision(organizationId),
      this.repo.ordersInProgress(organizationId),
      this.repo.invoicesUnpaid(organizationId),
      this.repo.deliveriesAwaitingYou(organizationId),
    ]);

    const queue = (
      key: PortalQueue['key'],
      label: string,
      detail: string,
      href: string,
      count: QueueCount,
    ): PortalQueue => ({
      key,
      label,
      detail,
      count: count.count,
      oldestWaitingSince: count.oldestWaitingSince ? count.oldestWaitingSince.toISOString() : null,
      href,
    });

    return {
      queues: [
        queue(
          'questions_awaiting_answer',
          'Questions waiting on you',
          'We cannot start sourcing until these are answered.',
          '/enquiries',
          questions,
        ),
        queue(
          'drafts_unfinished',
          'Enquiries you started',
          'Unfinished drafts. Pick one up where you left it, or discard it.',
          '/enquiries',
          drafts,
        ),
        queue(
          'enquiries_in_progress',
          'With JobWork',
          'Submitted and being worked on. We come back to you with questions or a quotation.',
          '/enquiries',
          inProgress,
        ),
        // Fixed keys with honest zeros until their increments count them (F-MX.5):
        // the home screen's quick actions read these and must never change shape.
        queue(
          'quotations_awaiting_decision',
          'Quotations to decide',
          'Offers from JobWork waiting for your acceptance, revision request or rejection.',
          '/quotations',
          quotations,
        ),
        queue(
          'orders_in_progress',
          'Orders in progress',
          'Accepted quotations being made and delivered.',
          '/orders',
          orders,
        ),
        queue(
          'invoices_unpaid',
          'Invoices to pay',
          'Issued by JobWork and not yet settled.',
          '/invoices',
          invoices,
        ),
        queue(
          'deliveries_awaiting_you',
          'Deliveries waiting on you',
          'Confirm where a delivery goes before it leaves, and accept or report one that arrived.',
          '/orders',
          deliveries,
        ),
      ],
      generatedAt: new Date().toISOString(),
    };
  }
}
