import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../platform/database/database.service';

export interface QueueCount {
  count: number;
  oldestWaitingSince: Date | null;
}

const EMPTY: QueueCount = { count: 0, oldestWaitingSince: null };

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
