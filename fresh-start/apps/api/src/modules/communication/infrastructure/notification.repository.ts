import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { NotificationItem } from '@jobwork/contracts';
import type { TemplateVersion } from '../domain/templates';
import { DatabaseService } from '../../../platform/database/database.service';

export interface OutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  organizationId: string | null;
  actor: { type?: string; id?: string | null };
  correlationId: string;
  data: Record<string, unknown>;
}

/** Who should hear about an event: a party, its organizations (external), and the roles that act on it. */
export interface RecipientAudience {
  party: 'customer' | 'supplier' | 'internal';
  organizationIds?: string[];
  roles: readonly string[];
  /** Narrows to these people, who must still hold one of the roles (F-11.1 assignee). */
  userIds?: string[];
}

export interface Recipient {
  userId: string;
  email: string;
  organizationId: string;
}

/**
 * The delivery id for one notification on one channel: derived, so every retry of the
 * same delivery carries the same id and a provider (or we) can deduplicate on it.
 */
export function deliveryIdFor(notificationId: string, channel: string): string {
  const h = createHash('sha256').update(`${notificationId}:${channel}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Retries per delivery before the attempt history is left for a person to look at. */
export const MAX_DELIVERY_ATTEMPTS = 5;

@Injectable()
export class NotificationRepository {
  constructor(private readonly db: DatabaseService) {}

  async outboxEvent(id: string): Promise<OutboxEvent | null> {
    const row = (await this.db.pool.query<{
      id: string; event_type: string; aggregate_type: string; aggregate_id: string; organization_id: string | null;
      actor: OutboxEvent['actor']; correlation_id: string; data: Record<string, unknown>;
    }>(
      `SELECT id, event_type, aggregate_type, aggregate_id, organization_id, actor, correlation_id, data
         FROM platform.outbox_event WHERE id = $1`,
      [id],
    )).rows[0];
    return row
      ? {
          id: row.id, eventType: row.event_type, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
          organizationId: row.organization_id, actor: row.actor, correlationId: row.correlation_id, data: row.data,
        }
      : null;
  }

  /** Active people in the audience who hold one of the roles — never the person who acted. */
  async recipients(audience: RecipientAudience, excludeUserId: string | null): Promise<Recipient[]> {
    if (audience.party !== 'internal' && (audience.organizationIds ?? []).length === 0) return [];
    const rows = await this.db.pool.query<{ user_id: string; email: string; organization_id: string }>(
      `SELECT DISTINCT u.id AS user_id, u.email, m.organization_id
         FROM iam.user_account u
         JOIN iam.membership m ON m.user_id = u.id AND m.status = 'active'
         JOIN iam.organization o ON o.id = m.organization_id AND o.status = 'active'
         JOIN iam.membership_role mr ON mr.membership_id = m.id
         JOIN iam.role r ON r.id = mr.role_id
        WHERE u.status = 'active'
          AND r.key = ANY($1::text[])
          AND o.type = $2
          AND ($2 = 'internal' OR o.id = ANY($3::uuid[]))
          AND ($4::uuid IS NULL OR u.id <> $4::uuid)
          AND ($5::uuid[] IS NULL OR u.id = ANY($5::uuid[]))
        ORDER BY u.email`,
      [audience.roles, audience.party, audience.organizationIds ?? [], excludeUserId, audience.userIds ?? null],
    );
    return rows.rows.map((r) => ({ userId: r.user_id, email: r.email, organizationId: r.organization_id }));
  }

  /** The current version of a template on each channel. */
  async templates(templateKey: string, locale = 'en-IN'): Promise<{ inApp: TemplateVersion | null; email: TemplateVersion | null }> {
    const rows = await this.db.pool.query<{ id: string; template_key: string; version: number; channel: string; subject: string; body: string; variables: string[] }>(
      `SELECT DISTINCT ON (channel) id, template_key, version, channel, subject, body, variables
         FROM communication.template_version
        WHERE template_key = $1 AND locale = $2 AND channel IN ('in_app', 'email')
        ORDER BY channel, version DESC`,
      [templateKey, locale],
    );
    const pick = (channel: string): TemplateVersion | null => {
      const r = rows.rows.find((x) => x.channel === channel);
      return r ? { id: r.id, templateKey: r.template_key, version: r.version, subject: r.subject, body: r.body, variables: r.variables } : null;
    };
    return { inApp: pick('in_app'), email: pick('email') };
  }

  /** Insert-or-find under the (event, recipient, template) key; returns the row id and whether it was new. */
  async upsertNotification(
    tx: PoolClient,
    n: {
      recipient: Recipient; templateKey: string; templateVersionId: string; locale: string;
      title: string; body: string; link: string; sourceEventId: string; correlationId: string;
    },
  ): Promise<string> {
    await tx.query(
      `INSERT INTO communication.notification
         (recipient_user_id, recipient_organization_id, template_key, template_version_id, locale, consent_basis,
          title, body, link, source_event_id, correlation_id)
       VALUES ($1, $2, $3, $4, $5, 'transactional', $6, $7, $8, $9, $10)
       ON CONFLICT (source_event_id, recipient_user_id, template_key) DO NOTHING`,
      [n.recipient.userId, n.recipient.organizationId, n.templateKey, n.templateVersionId, n.locale, n.title, n.body, n.link, n.sourceEventId, n.correlationId],
    );
    const row = (await tx.query<{ id: string }>(
      `SELECT id FROM communication.notification
        WHERE source_event_id = $1 AND recipient_user_id = $2 AND template_key = $3
        FOR UPDATE`,
      [n.sourceEventId, n.recipient.userId, n.templateKey],
    )).rows[0]!;
    return row.id;
  }

  /**
   * Opens the next attempt of a delivery, or returns null when it already succeeded or
   * has used its attempts. The caller holds the notification row lock, so two
   * dispatches of the same event cannot open the same attempt twice.
   */
  async openAttempt(
    tx: PoolClient,
    a: { notificationId: string; channel: 'email'; templateVersionId: string; destination: string },
  ): Promise<{ deliveryId: string; attemptNo: number } | null> {
    const deliveryId = deliveryIdFor(a.notificationId, a.channel);
    const history = (await tx.query<{ sent: boolean; attempts: number }>(
      `SELECT bool_or(status = 'sent') AS sent, count(*)::int AS attempts
         FROM communication.delivery_attempt WHERE delivery_id = $1`,
      [deliveryId],
    )).rows[0]!;
    if (history.sent || history.attempts >= MAX_DELIVERY_ATTEMPTS) return null;
    // An attempt left `sending` by a worker that died mid-send is closed as unknown; the
    // provider sees the same delivery id on the retry and can drop a duplicate.
    await tx.query(
      `UPDATE communication.delivery_attempt SET status = 'failed', error_code = 'outcome_unknown', completed_at = now()
        WHERE delivery_id = $1 AND status = 'sending'`,
      [deliveryId],
    );
    const attemptNo = history.attempts + 1;
    await tx.query(
      `INSERT INTO communication.delivery_attempt
         (delivery_id, notification_id, channel, template_version_id, destination, attempt_no, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'sending')`,
      [deliveryId, a.notificationId, a.channel, a.templateVersionId, a.destination, attemptNo],
    );
    return { deliveryId, attemptNo };
  }

  /** Records a provider outcome. A second report of the same outcome changes nothing. */
  async completeAttempt(
    deliveryId: string,
    r: { attemptNo: number; status: 'sent' | 'failed'; providerReference: string | null; errorCode: string | null },
  ): Promise<'recorded' | 'already_recorded' | 'unknown'> {
    return this.db.withTransaction(async (tx) => {
      const existing = (await tx.query<{ status: string }>(
        `SELECT status FROM communication.delivery_attempt WHERE delivery_id = $1 AND attempt_no = $2 FOR UPDATE`,
        [deliveryId, r.attemptNo],
      )).rows[0];
      if (!existing) return 'unknown';
      if (existing.status !== 'sending') return 'already_recorded';
      const alreadySent = (await tx.query(`SELECT 1 FROM communication.delivery_attempt WHERE delivery_id = $1 AND status = 'sent'`, [deliveryId])).rowCount;
      const status = r.status === 'sent' && alreadySent ? 'failed' : r.status;
      await tx.query(
        `UPDATE communication.delivery_attempt
            SET status = $3, provider_reference = $4, error_code = $5, completed_at = now()
          WHERE delivery_id = $1 AND attempt_no = $2`,
        [deliveryId, r.attemptNo, status, r.providerReference, status === r.status ? r.errorCode : 'duplicate_of_earlier_success'],
      );
      return 'recorded';
    });
  }

  // ---------------------------------------------------------------- feed

  async feed(userId: string, limit: number): Promise<{ notifications: NotificationItem[]; unread: number }> {
    const rows = await this.db.pool.query<{ id: string; title: string; body: string; link: string; created_at: Date; read_at: Date | null }>(
      `SELECT id, title, body, link, created_at, read_at FROM communication.notification
        WHERE recipient_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, limit],
    );
    return {
      notifications: rows.rows.map((r) => ({
        notificationId: r.id, title: r.title, body: r.body, link: r.link,
        createdAt: r.created_at.toISOString(), readAt: r.read_at ? r.read_at.toISOString() : null,
      })),
      unread: await this.unread(userId),
    };
  }

  async unread(userId: string): Promise<number> {
    return (await this.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM communication.notification WHERE recipient_user_id = $1 AND read_at IS NULL`,
      [userId],
    )).rows[0]!.n;
  }

  /** Marks one of the user's own notifications read; false when it is not theirs. */
  async markRead(userId: string, notificationId: string): Promise<boolean> {
    const owned = await this.db.pool.query(
      `SELECT 1 FROM communication.notification WHERE id = $1 AND recipient_user_id = $2`,
      [notificationId, userId],
    );
    if (!owned.rowCount) return false;
    await this.db.pool.query(
      `UPDATE communication.notification SET read_at = now() WHERE id = $1 AND recipient_user_id = $2 AND read_at IS NULL`,
      [notificationId, userId],
    );
    return true;
  }

  async markAllRead(userId: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE communication.notification SET read_at = now() WHERE recipient_user_id = $1 AND read_at IS NULL`,
      [userId],
    );
  }

  // ---------------------------------------------------------------- lookups for rules

  async enquiry(id: string): Promise<{ reference: string; customerOrganizationId: string } | null> {
    const row = (await this.db.pool.query<{ reference: string | null; customer_organization_id: string }>(
      `SELECT reference, customer_organization_id FROM sourcing.enquiry WHERE id = $1`,
      [id],
    )).rows[0];
    return row?.reference ? { reference: row.reference, customerOrganizationId: row.customer_organization_id } : null;
  }

  async rfq(id: string): Promise<{ reference: string; deadlineAt: Date | null; invitedOrganizationIds: string[] } | null> {
    const row = (await this.db.pool.query<{ reference: string; deadline_at: Date | null }>(
      `SELECT reference, deadline_at FROM sourcing.rfq WHERE id = $1`,
      [id],
    )).rows[0];
    if (!row) return null;
    const invited = await this.db.pool.query<{ supplier_organization_id: string }>(
      `SELECT supplier_organization_id FROM sourcing.rfq_supplier
        WHERE rfq_id = $1 AND status IN ('invited', 'acknowledged', 'clarifying', 'responded')`,
      [id],
    );
    return { reference: row.reference, deadlineAt: row.deadline_at, invitedOrganizationIds: invited.rows.map((r) => r.supplier_organization_id) };
  }

  async quoteReference(customerQuoteId: string): Promise<string | null> {
    return (await this.db.pool.query<{ reference: string | null }>(`SELECT reference FROM commercial.customer_quote WHERE id = $1`, [customerQuoteId])).rows[0]?.reference ?? null;
  }

  async costSheetRfqReference(costSheetId: string): Promise<string | null> {
    return (await this.db.pool.query<{ reference: string }>(
      `SELECT r.reference FROM commercial.cost_sheet cs JOIN sourcing.rfq r ON r.id = cs.rfq_id WHERE cs.id = $1`,
      [costSheetId],
    )).rows[0]?.reference ?? null;
  }

  async transmittalPurchaseOrder(transmittalId: string): Promise<{ purchaseOrderId: string } | null> {
    const row = (await this.db.pool.query<{ purchase_order_id: string }>(
      `SELECT purchase_order_id FROM dms.transmittal WHERE id = $1`,
      [transmittalId],
    )).rows[0];
    return row ? { purchaseOrderId: row.purchase_order_id } : null;
  }

  async milestonePurchaseOrder(milestoneId: string): Promise<{ purchaseOrderId: string; number: string; supplierOrganizationId: string } | null> {
    const row = (await this.db.pool.query<{ id: string; number: string; supplier_organization_id: string }>(
      `SELECT po.id, po.number, po.supplier_organization_id
         FROM orders.milestone m
         JOIN orders.work_package wp ON wp.id = m.work_package_id
         JOIN orders.purchase_order po ON po.id = wp.purchase_order_id
        WHERE m.id = $1`,
      [milestoneId],
    )).rows[0];
    return row ? { purchaseOrderId: row.id, number: row.number, supplierOrganizationId: row.supplier_organization_id } : null;
  }
}
