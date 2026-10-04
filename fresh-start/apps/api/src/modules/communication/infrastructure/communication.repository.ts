import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type {
  ConversationContextType,
  ExternalAudience,
  LeakageFinding,
  LeakageReviewStatus,
  MessageAudience,
  MessageParty,
} from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';

type Db = Pool | PoolClient;

export interface MessageRecord {
  id: string;
  conversationId: string;
  contextType: ConversationContextType;
  contextId: string;
  audience: MessageAudience;
  counterpartOrganizationId: string | null;
  counterpartName: string | null;
  authorUserId: string;
  authorName: string;
  authorOrganizationId: string;
  authorOrganizationName: string;
  authorParty: MessageParty;
  body: string;
  status: 'visible' | 'held' | 'rejected' | 'superseded';
  derivedFromMessageId: string | null;
  derivation: 'redacted' | 'shared' | null;
  postedAt: Date;
  aggregateVersion: number;
  reviewId: string | null;
  reviewStatus: LeakageReviewStatus | null;
  reviewAction: 'warn' | 'quarantine' | null;
}

export interface ReviewRecord {
  id: string;
  status: LeakageReviewStatus;
  action: 'warn' | 'quarantine';
  findings: LeakageFinding[];
  createdAt: Date;
  aggregateVersion: number;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  derivedMessageId: string | null;
  message: MessageRecord;
}

const MESSAGE_COLUMNS = `
  m.id, m.conversation_id, c.context_type, c.context_id, m.audience, m.counterpart_organization_id,
  cp.display_name AS counterpart_name, m.author_user_id, au.display_name AS author_name,
  m.author_organization_id, ao.display_name AS author_organization_name, m.author_party, m.body, m.status,
  m.derived_from_message_id, m.derivation, m.posted_at, m.aggregate_version,
  lr.id AS review_id, lr.status AS review_status, lr.action AS review_action`;

/** Context, author and counterpart of message `m`; the caller joins its review as `lr`. */
const MESSAGE_JOINS = `
  JOIN communication.conversation c ON c.id = m.conversation_id
  JOIN iam.user_account au ON au.id = m.author_user_id
  JOIN iam.organization ao ON ao.id = m.author_organization_id
  LEFT JOIN iam.organization cp ON cp.id = m.counterpart_organization_id`;

const WITH_REVIEW = `LEFT JOIN communication.leakage_review lr ON lr.message_id = m.id`;

interface MessageRow {
  id: string; conversation_id: string; context_type: ConversationContextType; context_id: string; audience: MessageAudience;
  counterpart_organization_id: string | null; counterpart_name: string | null; author_user_id: string; author_name: string;
  author_organization_id: string; author_organization_name: string; author_party: MessageParty; body: string;
  status: MessageRecord['status']; derived_from_message_id: string | null; derivation: MessageRecord['derivation'];
  posted_at: Date; aggregate_version: number; review_id: string | null; review_status: LeakageReviewStatus | null;
  review_action: 'warn' | 'quarantine' | null;
}

function toMessage(r: MessageRow): MessageRecord {
  return {
    id: r.id, conversationId: r.conversation_id, contextType: r.context_type, contextId: r.context_id, audience: r.audience,
    counterpartOrganizationId: r.counterpart_organization_id, counterpartName: r.counterpart_name,
    authorUserId: r.author_user_id, authorName: r.author_name || 'JobWork', authorOrganizationId: r.author_organization_id,
    authorOrganizationName: r.author_organization_name, authorParty: r.author_party, body: r.body, status: r.status,
    derivedFromMessageId: r.derived_from_message_id, derivation: r.derivation, postedAt: r.posted_at,
    aggregateVersion: r.aggregate_version, reviewId: r.review_id, reviewStatus: r.review_status, reviewAction: r.review_action,
  };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Communication persistence. Reads for an external reader take the audiences that reader
 * may see as a parameter and filter in SQL — the allowlist is the query (`BR-AUTH-06`),
 * never a filter applied to rows already fetched.
 */
@Injectable()
export class CommunicationRepository {
  constructor(private readonly db: DatabaseService) {}

  async conversationId(type: ConversationContextType, id: string, client: Db = this.db.pool): Promise<string | null> {
    const row = (await client.query<{ id: string }>(
      `SELECT id FROM communication.conversation WHERE context_type = $1 AND context_id = $2`,
      [type, id],
    )).rows[0];
    return row?.id ?? null;
  }

  /** Get-or-create under a race: the unique (type, id) settles who created it. */
  async ensureConversation(tx: PoolClient, type: ConversationContextType, id: string): Promise<string> {
    await tx.query(
      `INSERT INTO communication.conversation (context_type, context_id) VALUES ($1, $2)
       ON CONFLICT (context_type, context_id) DO NOTHING`,
      [type, id],
    );
    return (await this.conversationId(type, id, tx))!;
  }

  async addParticipant(tx: PoolClient, conversationId: string, organizationId: string, party: 'customer' | 'supplier'): Promise<void> {
    await tx.query(
      `INSERT INTO communication.participant (conversation_id, organization_id, party) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [conversationId, organizationId, party],
    );
  }

  async insertMessage(
    tx: PoolClient,
    m: {
      conversationId: string; audience: MessageAudience; counterpartOrganizationId: string | null; authorUserId: string;
      authorOrganizationId: string; authorParty: MessageParty; body: string; status: 'visible' | 'held';
      derivedFromMessageId?: string | null; derivation?: 'redacted' | 'shared' | null;
    },
  ): Promise<string> {
    const row = (await tx.query<{ id: string }>(
      `INSERT INTO communication.message
         (conversation_id, audience, counterpart_organization_id, author_user_id, author_organization_id, author_party,
          body, body_sha256, status, derived_from_message_id, derivation, released_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $9 = 'visible' THEN now() END)
       RETURNING id`,
      [
        m.conversationId, m.audience, m.counterpartOrganizationId, m.authorUserId, m.authorOrganizationId, m.authorParty,
        m.body, sha256(m.body), m.status, m.derivedFromMessageId ?? null, m.derivation ?? null,
      ],
    )).rows[0]!;
    return row.id;
  }

  async insertReview(
    tx: PoolClient,
    r: { messageId: string; action: 'warn' | 'quarantine'; findings: LeakageFinding[]; detectorVersion: string },
  ): Promise<string> {
    const row = (await tx.query<{ id: string }>(
      `INSERT INTO communication.leakage_review (message_id, action, findings, detector_version, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [r.messageId, r.action, JSON.stringify(r.findings), r.detectorVersion, r.action === 'warn' ? 'noted' : 'open'],
    )).rows[0]!;
    return row.id;
  }

  async message(id: string, client: Db = this.db.pool, lock = false): Promise<MessageRecord | null> {
    const row = (await client.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM communication.message m ${MESSAGE_JOINS} ${WITH_REVIEW} WHERE m.id = $1 ${lock ? 'FOR UPDATE OF m' : ''}`,
      [id],
    )).rows[0];
    return row ? toMessage(row) : null;
  }

  /** Every message of a conversation — JobWork's view only. */
  async internalMessages(conversationId: string): Promise<MessageRecord[]> {
    const rows = await this.db.pool.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM communication.message m ${MESSAGE_JOINS} ${WITH_REVIEW}
        WHERE m.conversation_id = $1 ORDER BY m.posted_at, m.id`,
      [conversationId],
    );
    return rows.rows.map(toMessage);
  }

  /**
   * What an external organization may read: messages in its audiences that are visible,
   * plus its own held messages (so an author sees "waiting for JobWork", never silence).
   * A supplier-audience message must be addressed to the reader's organization.
   */
  async externalMessages(
    conversationId: string,
    reader: { organizationId: string; audiences: ExternalAudience[] },
  ): Promise<MessageRecord[]> {
    const rows = await this.db.pool.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM communication.message m ${MESSAGE_JOINS} ${WITH_REVIEW}
        WHERE m.conversation_id = $1
          AND m.audience = ANY($2::text[])
          AND (m.audience <> 'supplier' OR m.counterpart_organization_id = $3)
          AND (m.status = 'visible' OR (m.status = 'held' AND m.author_organization_id = $3))
        ORDER BY m.posted_at, m.id`,
      [conversationId, reader.audiences, reader.organizationId],
    );
    return rows.rows.map(toMessage);
  }

  async setMessageStatus(tx: PoolClient, id: string, status: 'visible' | 'rejected' | 'superseded'): Promise<void> {
    await tx.query(
      `UPDATE communication.message
          SET status = $2, released_at = CASE WHEN $2 = 'visible' THEN now() ELSE released_at END,
              aggregate_version = aggregate_version + 1
        WHERE id = $1`,
      [id, status],
    );
  }

  // ---------------------------------------------------------------- reviews

  async reviews(status: 'open' | 'decided'): Promise<ReviewRecord[]> {
    const rows = await this.db.pool.query<ReviewRow>(
      `SELECT ${REVIEW_COLUMNS} FROM communication.leakage_review lr
         JOIN communication.message m ON m.id = lr.message_id ${MESSAGE_JOINS}
         LEFT JOIN iam.user_account du ON du.id = lr.decided_by
        WHERE ${status === 'open' ? `lr.status = 'open'` : `lr.status IN ('released', 'released_redacted', 'rejected')`}
        ORDER BY ${status === 'open' ? 'lr.created_at ASC' : 'lr.decided_at DESC'}
        LIMIT 200`,
    );
    return rows.rows.map(toReview);
  }

  async review(id: string, client: Db = this.db.pool, lock = false): Promise<ReviewRecord | null> {
    const row = (await client.query<ReviewRow>(
      `SELECT ${REVIEW_COLUMNS} FROM communication.leakage_review lr
         JOIN communication.message m ON m.id = lr.message_id ${MESSAGE_JOINS}
         LEFT JOIN iam.user_account du ON du.id = lr.decided_by
        WHERE lr.id = $1 ${lock ? 'FOR UPDATE OF lr, m' : ''}`,
      [id],
    )).rows[0];
    return row ? toReview(row) : null;
  }

  async decideReview(
    tx: PoolClient,
    id: string,
    d: { status: 'released' | 'released_redacted' | 'rejected'; decidedBy: string; reason: string; derivedMessageId: string | null },
  ): Promise<void> {
    await tx.query(
      `UPDATE communication.leakage_review
          SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4, derived_message_id = $5,
              aggregate_version = aggregate_version + 1
        WHERE id = $1`,
      [id, d.status, d.decidedBy, d.reason, d.derivedMessageId],
    );
  }

  async openReviewCount(): Promise<{ count: number; oldest: Date | null }> {
    const row = (await this.db.pool.query<{ n: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, min(created_at) AS oldest FROM communication.leakage_review WHERE status = 'open'`,
    )).rows[0]!;
    return { count: row.n, oldest: row.oldest };
  }
}

const REVIEW_COLUMNS = `${MESSAGE_COLUMNS},
  lr.findings AS r_findings, lr.created_at AS r_created_at, lr.aggregate_version AS r_version,
  du.display_name AS r_decided_by_name, lr.decided_at AS r_decided_at, lr.decision_reason AS r_reason,
  lr.derived_message_id AS r_derived`;

interface ReviewRow extends MessageRow {
  r_findings: LeakageFinding[];
  r_created_at: Date; r_version: number; r_decided_by_name: string | null; r_decided_at: Date | null;
  r_reason: string | null; r_derived: string | null;
}

function toReview(r: ReviewRow): ReviewRecord {
  return {
    id: r.review_id!, status: r.review_status!, action: r.review_action!, findings: r.r_findings, createdAt: r.r_created_at,
    aggregateVersion: r.r_version, decidedByName: r.r_decided_by_name, decidedAt: r.r_decided_at,
    decisionReason: r.r_reason, derivedMessageId: r.r_derived, message: toMessage(r),
  };
}
