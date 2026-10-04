import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../platform/database/database.service';

export interface QueueCount {
  count: number;
  oldestWaitingSince: Date | null;
}

const EMPTY: QueueCount = { count: 0, oldestWaitingSince: null };

/**
 * The counts behind the command center (F-OPS.2). Each query mirrors the filter its own
 * screen uses, so a number here can never disagree with the queue it links to — the way
 * a badge loses trust is by saying three when the page shows two.
 */
@Injectable()
export class SummaryRepository {
  constructor(private readonly db: DatabaseService) {}

  private async count(sql: string, params: unknown[] = []): Promise<QueueCount> {
    const res = await this.db.pool.query<{ n: number; oldest: Date | null }>(sql, params);
    const row = res.rows[0];
    return row ? { count: Number(row.n), oldestWaitingSince: row.oldest ?? null } : EMPTY;
  }

  /** Submitted or under review: waiting on a JobWork reviewer, oldest submission first. */
  enquiriesAwaitingTriage(): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(submitted_at) AS oldest
         FROM sourcing.enquiry
        WHERE status IN ('submitted', 'under_review')`,
    );
  }

  /** Asked and unanswered: waiting on the customer, so it ages against JobWork's promise. */
  clarificationsAwaitingCustomer(): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(updated_at) AS oldest
         FROM sourcing.enquiry
        WHERE status = 'clarification_required'`,
    );
  }

  supplierFilesAwaitingDecision(): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(submitted_for_approval_at) AS oldest
         FROM supplier.supplier_profile
        WHERE status = 'submitted'`,
    );
  }

  supplierApplicationsReceived(): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(created_at) AS oldest
         FROM supplier.network_application
        WHERE status = 'received'`,
    );
  }

  rfqsInEvaluation(): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(closed_at) AS oldest
         FROM sourcing.rfq WHERE status = 'evaluation'`,
    );
  }

  approvalsPending(): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(requested_at) AS oldest
         FROM commercial.approval_request WHERE status = 'pending'`,
    );
  }

  /** Accepted and waiting on the advance or a credit decision (doc 06 §7 commercial gate). */
  ordersAwaitingRelease(): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(created_at) AS oldest
         FROM orders.sales_order WHERE status = 'pending_commercial_release'`,
    );
  }

  /** Orders with an approved award behind them and no purchase order issued yet. */
  purchaseOrdersToIssue(): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(o.created_at) AS oldest
         FROM orders.sales_order o
        WHERE o.status NOT IN ('cancelled', 'closed')
          AND NOT EXISTS (SELECT 1 FROM orders.purchase_order p WHERE p.sales_order_id = o.id)`,
    );
  }

  /** Receipts nobody can tie to an invoice yet: suspense is a liability until it is cleared. */
  paymentsUnmatched(): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(received_at) AS oldest
         FROM finance.payment_transaction WHERE status = 'suspense'`,
    );
  }

  /** Orders with purchase orders out and no released production baseline yet. */
  baselinesToRelease(): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(o.created_at) AS oldest
         FROM orders.sales_order o
        WHERE o.status NOT IN ('cancelled', 'closed')
          AND EXISTS (SELECT 1 FROM orders.purchase_order p WHERE p.sales_order_id = o.id)
          AND NOT EXISTS (SELECT 1 FROM dms.baseline b WHERE b.sales_order_id = o.id AND b.status = 'released')`,
    );
  }

  workPackagesToRelease(): Promise<QueueCount> {
    return this.count(`SELECT count(*)::int AS n, min(created_at) AS oldest FROM orders.work_package WHERE status = 'planned'`);
  }

  milestonesToVerify(): Promise<QueueCount> {
    return this.count(`SELECT count(*)::int AS n, min(submitted_at) AS oldest FROM orders.milestone WHERE status = 'evidence_submitted'`);
  }

  supplierEvidenceAwaitingReview(): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(submitted_at) AS oldest
         FROM supplier.verification_item
        WHERE status IN ('submitted', 'under_review')`,
    );
  }

  /**
   * Admitted suppliers that cannot currently be matched — expired evidence, a suspension,
   * nothing published. Not a queue anyone submitted to, which is exactly why it needs a
   * number: nobody is going to notice it on their own.
   */
  suppliersUnmatchable(): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(p.updated_at) AS oldest
         FROM supplier.supplier_profile p
         JOIN iam.organization o ON o.id = p.organization_id
        WHERE p.status IN ('active', 'paused')
          AND (
            p.status <> 'active'
            OR o.status <> 'active'
            OR NOT EXISTS (
              SELECT 1 FROM supplier.supplier_capability sc
               WHERE sc.supplier_profile_id = p.id AND sc.status = 'published'
            )
            OR (
              SELECT count(DISTINCT v.kind) FROM supplier.verification_item v
               WHERE v.supplier_profile_id = p.id
                 AND v.kind IN ('gst', 'pan', 'bank_account')
                 AND v.status IN ('verified', 'expiring')
                 AND (v.expires_at IS NULL OR v.expires_at > now())
            ) < 3
          )`,
    );
  }

  /** Invitations nobody has accepted: an organization sitting empty is a stalled onboarding. */
  invitationsPending(): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(created_at) AS oldest
         FROM iam.invitation
        WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    );
  }
}

/**
 * The customer's own three questions (F-CX.4): what is waiting on me, what did I not
 * finish, and what is in progress. Scoped to one organization, always — a count is a
 * disclosure like any other read.
 */
@Injectable()
export class PortalSummaryRepository {
  constructor(private readonly db: DatabaseService) {}

  private async count(sql: string, params: unknown[]): Promise<QueueCount> {
    const res = await this.db.pool.query<{ n: number; oldest: Date | null }>(sql, params);
    const row = res.rows[0];
    return row ? { count: Number(row.n), oldestWaitingSince: row.oldest ?? null } : EMPTY;
  }

  questionsAwaitingAnswer(organizationId: string): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(c.asked_at) AS oldest
         FROM sourcing.clarification c
         JOIN sourcing.enquiry e ON e.id = c.enquiry_id
        WHERE e.customer_organization_id = $1 AND c.status = 'open'`,
      [organizationId],
    );
  }

  draftsUnfinished(organizationId: string): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(created_at) AS oldest
         FROM sourcing.enquiry
        WHERE customer_organization_id = $1 AND status = 'draft'`,
      [organizationId],
    );
  }

  /** Sent and undecided: the customer's quotation inbox (IN-07). */
  quotationsAwaitingDecision(organizationId: string): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(q.updated_at) AS oldest
         FROM commercial.customer_quote q
        WHERE q.customer_organization_id = $1 AND q.status = 'sent'`,
      [organizationId],
    );
  }

  /** Accepted and not yet finished, from the customer's side. */
  ordersInProgress(organizationId: string): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(created_at) AS oldest
         FROM orders.sales_order
        WHERE customer_organization_id = $1 AND status NOT IN ('customer_accepted', 'closed', 'cancelled')`,
      [organizationId],
    );
  }

  invoicesUnpaid(organizationId: string): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(due_at) AS oldest
         FROM finance.invoice
        WHERE customer_organization_id = $1 AND status IN ('issued', 'partially_paid')`,
      [organizationId],
    );
  }

  enquiriesInProgress(organizationId: string): Promise<QueueCount> {
    return this.count(
      `SELECT count(*)::int AS n, min(submitted_at) AS oldest
         FROM sourcing.enquiry
        WHERE customer_organization_id = $1
          AND status IN ('submitted', 'under_review', 'approved_for_sourcing')`,
      [organizationId],
    );
  }
}
