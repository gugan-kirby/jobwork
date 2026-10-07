import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { CaseKind, CaseStatus, ResolutionActionKind } from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';

type Queryable = Pool | PoolClient;

export interface CaseRow {
  id: string;
  number: string;
  kind: CaseKind;
  salesOrderId: string;
  orderNumber: string;
  customerOrganizationId: string;
  customerDisplayName: string;
  shipmentId: string | null;
  shipmentNumber: string;
  purchaseOrderId: string | null;
  title: string;
  description: string;
  status: CaseStatus;
  openedBy: string;
  openedByParty: 'customer' | 'jobwork';
  approvalRequestId: string | null;
  closedAt: Date | null;
  createdAt: Date;
  aggregateVersion: number;
}

export interface ActionRow {
  id: string;
  caseId: string;
  seq: number;
  kind: ResolutionActionKind;
  description: string;
  amountMinor: number | null;
  quantity: string | null;
  stockLotId: string | null;
  status: 'planned' | 'done' | 'verified' | 'cancelled';
  result: Record<string, unknown>;
  doneBy: string | null;
  doneAt: Date | null;
  verifiedAt: Date | null;
}

const CASE_COLUMNS = `c.id, c.number, c.kind, c.sales_order_id AS "salesOrderId", so.number AS "orderNumber", c.customer_organization_id AS "customerOrganizationId",
  o.display_name AS "customerDisplayName", c.shipment_id AS "shipmentId", COALESCE(s.number, '') AS "shipmentNumber", c.purchase_order_id AS "purchaseOrderId",
  c.title, c.description, c.status, c.opened_by AS "openedBy", c.opened_by_party AS "openedByParty", c.approval_request_id AS "approvalRequestId",
  c.closed_at AS "closedAt", c.created_at AS "createdAt", c.aggregate_version AS "aggregateVersion"`;
const CASE_FROM = `FROM support.case c JOIN orders.sales_order so ON so.id = c.sales_order_id JOIN iam.organization o ON o.id = c.customer_organization_id
  LEFT JOIN logistics.shipment s ON s.id = c.shipment_id`;
const ACTION_COLUMNS = `id, case_id AS "caseId", seq, kind, description, amount_minor::int AS "amountMinor", quantity::text AS quantity, stock_lot_id AS "stockLotId", status, result,
  done_by AS "doneBy", done_at AS "doneAt", verified_at AS "verifiedAt"`;

/** The support module's SQL (IN-18 F-18.2). */
@Injectable()
export class SupportRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  async allocateNumber(now: Date, tx: Queryable): Promise<string> {
    const year = now.getUTCFullYear();
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('support.case.number'))`);
    const res = await tx.query<{ next: number }>(`SELECT COALESCE(MAX(NULLIF(split_part(number, '-', 3), '')::int), 0) + 1 AS next FROM support.case WHERE number LIKE $1`, [`CASE-${year}-%`]);
    return `CASE-${year}-${String(res.rows[0]!.next).padStart(4, '0')}`;
  }

  async insertCase(
    input: { number: string; kind: CaseKind; salesOrderId: string; customerOrganizationId: string; shipmentId: string | null; purchaseOrderId: string | null; title: string; description: string; by: string; party: 'customer' | 'jobwork' },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO support.case (number, kind, sales_order_id, customer_organization_id, shipment_id, purchase_order_id, title, description, opened_by, opened_by_party)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [input.number, input.kind, input.salesOrderId, input.customerOrganizationId, input.shipmentId, input.purchaseOrderId, input.title, input.description, input.by, input.party],
    );
    return res.rows[0]!.id;
  }

  async find(id: string, tx?: Queryable, forUpdate = false): Promise<CaseRow | null> {
    const res = await this.q(tx).query<CaseRow>(`SELECT ${CASE_COLUMNS} ${CASE_FROM} WHERE c.id = $1 ${forUpdate ? 'FOR UPDATE OF c' : ''}`, [id]);
    return res.rows[0] ?? null;
  }

  async findByApproval(approvalRequestId: string, tx: Queryable): Promise<CaseRow | null> {
    const res = await tx.query<CaseRow>(`SELECT ${CASE_COLUMNS} ${CASE_FROM} WHERE c.approval_request_id = $1 FOR UPDATE OF c`, [approvalRequestId]);
    return res.rows[0] ?? null;
  }

  async list(filter: { customerOrganizationId?: string; salesOrderId?: string; open?: boolean }, tx?: Queryable): Promise<CaseRow[]> {
    const res = await this.q(tx).query<CaseRow>(
      `SELECT ${CASE_COLUMNS} ${CASE_FROM}
        WHERE ($1::uuid IS NULL OR c.customer_organization_id = $1) AND ($2::uuid IS NULL OR c.sales_order_id = $2)
          AND ($3::boolean IS NULL OR (c.status NOT IN ('closed', 'rejected', 'withdrawn')) = $3)
        ORDER BY c.created_at DESC LIMIT 200`,
      [filter.customerOrganizationId ?? null, filter.salesOrderId ?? null, filter.open ?? null],
    );
    return res.rows;
  }

  async update(id: string, fields: Partial<{ status: CaseStatus; ownerId: string; approvalRequestId: string; closeNote: string; closed: boolean }>, tx: Queryable): Promise<number> {
    const res = await tx.query<{ aggregate_version: number }>(
      `UPDATE support.case SET status = COALESCE($2, status), owner_id = COALESCE($3, owner_id), approval_request_id = COALESCE($4, approval_request_id),
              close_note = COALESCE($5, close_note), closed_at = CASE WHEN $6 THEN now() ELSE closed_at END, aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1 RETURNING aggregate_version`,
      [id, fields.status ?? null, fields.ownerId ?? null, fields.approvalRequestId ?? null, fields.closeNote ?? null, fields.closed ?? false],
    );
    return res.rows[0]!.aggregate_version;
  }

  async addEvent(input: { caseId: string; audience: 'customer' | 'internal'; kind: string; note: string; evidence: string[]; by: string | null; party: 'customer' | 'jobwork' | 'system' }, tx: Queryable): Promise<void> {
    await tx.query(
      `INSERT INTO support.case_event (case_id, audience, kind, note, evidence_document_version_ids, author_id, author_party) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.caseId, input.audience, input.kind, input.note, input.evidence, input.by, input.party],
    );
  }

  async events(caseId: string, customerOnly: boolean, tx?: Queryable): Promise<Array<{ kind: string; note: string; audience: 'customer' | 'internal'; authorParty: 'customer' | 'jobwork' | 'system'; evidence: string[]; createdAt: Date }>> {
    const res = await this.q(tx).query<{ kind: string; note: string; audience: 'customer' | 'internal'; authorParty: 'customer' | 'jobwork' | 'system'; evidence: string[]; createdAt: Date }>(
      `SELECT kind, note, audience, author_party AS "authorParty", evidence_document_version_ids AS evidence, created_at AS "createdAt"
         FROM support.case_event WHERE case_id = $1 AND (NOT $2 OR audience = 'customer') ORDER BY created_at, id`,
      [caseId, customerOnly],
    );
    return res.rows;
  }

  /** A new proposal replaces the actions still only planned; what was done stays. */
  async replacePlanned(caseId: string, actions: Array<{ kind: ResolutionActionKind; description: string; amountMinor: number | null; quantity: string | null; stockLotId: string | null }>, tx: Queryable): Promise<void> {
    await tx.query(`DELETE FROM support.resolution_action WHERE case_id = $1 AND status = 'planned'`, [caseId]);
    const base = await tx.query<{ n: number }>(`SELECT COALESCE(MAX(seq), 0)::int AS n FROM support.resolution_action WHERE case_id = $1`, [caseId]);
    let seq = base.rows[0]!.n;
    for (const a of actions) {
      seq += 1;
      await tx.query(
        `INSERT INTO support.resolution_action (case_id, seq, kind, description, amount_minor, quantity, stock_lot_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [caseId, seq, a.kind, a.description, a.amountMinor, a.quantity, a.stockLotId],
      );
    }
  }

  async actions(caseId: string, tx?: Queryable): Promise<ActionRow[]> {
    const res = await this.q(tx).query<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM support.resolution_action WHERE case_id = $1 ORDER BY seq`, [caseId]);
    return res.rows;
  }

  async findAction(id: string, tx: Queryable): Promise<ActionRow | null> {
    const res = await tx.query<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM support.resolution_action WHERE id = $1 FOR UPDATE`, [id]);
    return res.rows[0] ?? null;
  }

  async markAction(id: string, fields: { status: 'done' | 'verified' | 'cancelled'; result?: Record<string, unknown>; by: string }, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE support.resolution_action
          SET status = $2, result = COALESCE($3::jsonb, result),
              done_by = CASE WHEN $2 = 'done' THEN $4 ELSE done_by END, done_at = CASE WHEN $2 = 'done' THEN now() ELSE done_at END,
              verified_by = CASE WHEN $2 = 'verified' THEN $4 ELSE verified_by END, verified_at = CASE WHEN $2 = 'verified' THEN now() ELSE verified_at END
        WHERE id = $1`,
      [id, fields.status, fields.result ? JSON.stringify(fields.result) : null, fields.by],
    );
  }

  async linkedExceptions(caseId: string, tx?: Queryable): Promise<Array<{ number: string; kind: string }>> {
    const res = await this.q(tx).query<{ number: string; kind: string }>(`SELECT number, kind FROM logistics.delivery_exception WHERE case_id = $1 ORDER BY number`, [caseId]);
    return res.rows;
  }

  async ownCleanVersion(documentVersionId: string, organizationId: string, tx?: Queryable): Promise<boolean> {
    const res = await this.q(tx).query(
      `SELECT 1 FROM dms.document_version v JOIN dms.document d ON d.id = v.document_id JOIN dms.file_object f ON f.id = v.file_object_id
        WHERE v.id = $1 AND d.owning_organization_id = $2 AND v.status = 'available' AND f.scan_state = 'clean'`,
      [documentVersionId, organizationId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
