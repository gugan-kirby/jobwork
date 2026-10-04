import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { ChangeClassification, ChangeOrigin, ChangeStatus, ImpactAnswer } from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';

type Queryable = Pool | PoolClient;

export interface ChangeRow {
  id: string;
  number: string;
  salesOrderId: string;
  salesOrderNumber: string;
  customerOrganizationId: string;
  currency: string;
  origin: ChangeOrigin;
  classification: ChangeClassification | null;
  urgency: 'normal' | 'urgent';
  title: string;
  reason: string;
  status: ChangeStatus;
  infoRequest: string | null;
  infoResponse: string | null;
  supplierBrief: string;
  customerApprovalRequired: boolean | null;
  approvalRequestId: string | null;
  candidateBaselineId: string | null;
  releasedBaselineId: string | null;
  contextDocumentVersionIds: string[];
  outcomeNote: string | null;
  proposedBy: string;
  proposedAt: Date;
  closedAt: Date | null;
  aggregateVersion: number;
}

export interface ImpactRow {
  versionNo: number;
  areas: Record<string, ImpactAnswer>;
  customerPriceDeltaMinor: number;
  deliveryDateDeltaDays: number;
  purchaseOrders: Array<{ purchaseOrderId: string; costDeltaMinor: number; leadTimeDeltaDays: number }>;
  wip: Array<{ purchaseOrderId: string; quantity: number; disposition: 'reuse' | 'rework' | 'scrap'; costMinor: number; note: string }>;
  recordedAt: Date;
}

export interface InterimRow {
  id: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  supplierOrganizationId: string;
  decision: 'stop' | 'continue';
  reason: string;
  expiresAt: Date;
  issuedAt: Date;
  liftedAt: Date | null;
  liftReason: string | null;
}

export interface PoAmendmentRow {
  id: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  supplierOrganizationId: string;
  transmittalId: string;
  currency: string;
  costDeltaMinor: number;
  leadTimeDeltaDays: number;
  acknowledgedAt: Date | null;
}

const num = (v: unknown): number => Number(v);

const CHANGE_SELECT = `
  SELECT c.id, c.number, c.sales_order_id AS "salesOrderId", so.number AS "salesOrderNumber",
         so.customer_organization_id AS "customerOrganizationId", so.currency, c.origin, c.classification, c.urgency,
         c.title, c.reason, c.status, c.info_request AS "infoRequest", c.info_response AS "infoResponse",
         c.supplier_brief AS "supplierBrief", c.customer_approval_required AS "customerApprovalRequired",
         c.approval_request_id AS "approvalRequestId", c.candidate_baseline_id AS "candidateBaselineId",
         c.released_baseline_id AS "releasedBaselineId", c.context_document_version_ids AS "contextDocumentVersionIds",
         c.outcome_note AS "outcomeNote", c.proposed_by AS "proposedBy", c.proposed_at AS "proposedAt",
         c.closed_at AS "closedAt", c.aggregate_version AS "aggregateVersion"
    FROM change.change_request c
    JOIN orders.sales_order so ON so.id = c.sales_order_id`;

/** Persistence for engineering changes (IN-13). Every judgement is a new row; only the change's own state moves. */
@Injectable()
export class ChangeRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  async allocateNumber(now: Date, tx: Queryable): Promise<string> {
    const year = now.getUTCFullYear();
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('change.change_request.number'))`);
    const res = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(NULLIF(split_part(number, '-', 3), '')::int), 0) + 1 AS next FROM change.change_request WHERE number LIKE $1`,
      [`CR-${year}-%`],
    );
    return `CR-${year}-${String(res.rows[0]!.next).padStart(4, '0')}`;
  }

  async create(
    input: { number: string; salesOrderId: string; origin: ChangeOrigin; urgency: 'normal' | 'urgent'; title: string; reason: string; contextDocumentVersionIds: string[]; proposedBy: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO change.change_request (number, sales_order_id, origin, urgency, title, reason, context_document_version_ids, proposed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[],$8) RETURNING id`,
      [input.number, input.salesOrderId, input.origin, input.urgency, input.title, input.reason, input.contextDocumentVersionIds, input.proposedBy],
    );
    return res.rows[0]!.id;
  }

  async find(id: string, tx?: Queryable, forUpdate = false): Promise<ChangeRow | null> {
    const res = await this.q(tx).query(`${CHANGE_SELECT} WHERE c.id = $1 ${forUpdate ? 'FOR UPDATE OF c' : ''}`, [id]);
    return (res.rows[0] as ChangeRow | undefined) ?? null;
  }

  async list(filter: { salesOrderId?: string; customerOrganizationId?: string; statuses?: ChangeStatus[] }, limit = 200): Promise<ChangeRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.salesOrderId) where.push(`c.sales_order_id = $${args.push(filter.salesOrderId)}`);
    if (filter.customerOrganizationId) where.push(`so.customer_organization_id = $${args.push(filter.customerOrganizationId)}`);
    if (filter.statuses) where.push(`c.status = ANY($${args.push(filter.statuses)}::text[])`);
    const res = await this.db.pool.query(`${CHANGE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.proposed_at DESC LIMIT ${Math.min(limit, 500)}`, args);
    return res.rows as ChangeRow[];
  }

  /** Changes a supplier is part of: one of its POs is stopped, invited to give impact, or amended. */
  async listForSupplier(supplierOrganizationId: string): Promise<ChangeRow[]> {
    const res = await this.db.pool.query(
      `${CHANGE_SELECT}
        WHERE EXISTS (SELECT 1 FROM orders.purchase_order p WHERE p.sales_order_id = c.sales_order_id AND p.supplier_organization_id = $1 AND p.status <> 'cancelled')
          AND (c.status IN ('impact_analysis', 'commercial_approval', 'approved', 'released', 'implemented', 'verified', 'closed')
               OR EXISTS (SELECT 1 FROM change.interim_decision d JOIN orders.purchase_order p ON p.id = d.purchase_order_id
                           WHERE d.change_request_id = c.id AND p.supplier_organization_id = $1))
          AND (c.classification IS NULL OR c.classification <> 'clarification')
        ORDER BY c.proposed_at DESC LIMIT 200`,
      [supplierOrganizationId],
    );
    return res.rows as ChangeRow[];
  }

  /** Moves the change's own state; bumps its version. Only named fields are written. */
  async update(
    id: string,
    fields: Partial<{
      status: ChangeStatus;
      classification: ChangeClassification;
      infoRequest: string | null;
      infoResponse: string | null;
      supplierBrief: string;
      customerApprovalRequired: boolean;
      approvalRequestId: string | null;
      candidateBaselineId: string | null;
      releasedBaselineId: string;
      outcomeNote: string;
      closedAt: Date;
    }>,
    tx: Queryable,
  ): Promise<number> {
    const columns: Record<string, string> = {
      status: 'status',
      classification: 'classification',
      infoRequest: 'info_request',
      infoResponse: 'info_response',
      supplierBrief: 'supplier_brief',
      customerApprovalRequired: 'customer_approval_required',
      approvalRequestId: 'approval_request_id',
      candidateBaselineId: 'candidate_baseline_id',
      releasedBaselineId: 'released_baseline_id',
      outcomeNote: 'outcome_note',
      closedAt: 'closed_at',
    };
    const sets: string[] = [];
    const args: unknown[] = [id];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      sets.push(`${columns[key]} = $${args.push(value)}`);
    }
    const res = await tx.query<{ aggregate_version: number }>(
      `UPDATE change.change_request SET ${[...sets, 'aggregate_version = aggregate_version + 1', 'updated_at = now()'].join(', ')} WHERE id = $1 RETURNING aggregate_version`,
      args,
    );
    return res.rows[0]!.aggregate_version;
  }

  // ----------------------------------------------------------------- impact

  async latestImpact(changeId: string, tx?: Queryable): Promise<ImpactRow | null> {
    const res = await this.q(tx).query(
      `SELECT version_no AS "versionNo", areas, customer_price_delta_minor AS "customerPriceDeltaMinor", delivery_date_delta_days AS "deliveryDateDeltaDays",
              purchase_orders AS "purchaseOrders", wip, recorded_at AS "recordedAt"
         FROM change.impact_version WHERE change_request_id = $1 ORDER BY version_no DESC LIMIT 1`,
      [changeId],
    );
    const row = res.rows[0] as ImpactRow | undefined;
    return row ? { ...row, customerPriceDeltaMinor: num(row.customerPriceDeltaMinor) } : null;
  }

  async insertImpact(
    input: { changeId: string; areas: Record<string, ImpactAnswer>; customerPriceDeltaMinor: number; deliveryDateDeltaDays: number; purchaseOrders: ImpactRow['purchaseOrders']; wip: ImpactRow['wip']; recordedBy: string },
    tx: Queryable,
  ): Promise<number> {
    const res = await tx.query<{ version_no: number }>(
      `INSERT INTO change.impact_version (change_request_id, version_no, areas, customer_price_delta_minor, delivery_date_delta_days, purchase_orders, wip, recorded_by)
       SELECT $1, COALESCE(MAX(version_no), 0) + 1, $2::jsonb, $3, $4, $5::jsonb, $6::jsonb, $7 FROM change.impact_version WHERE change_request_id = $1
       RETURNING version_no`,
      [input.changeId, JSON.stringify(input.areas), input.customerPriceDeltaMinor, input.deliveryDateDeltaDays, JSON.stringify(input.purchaseOrders), JSON.stringify(input.wip), input.recordedBy],
    );
    return res.rows[0]!.version_no;
  }

  async supplierImpacts(changeId: string, tx?: Queryable): Promise<Array<{ purchaseOrderId: string; supplierOrganizationId: string; supplierDisplayName: string; costDeltaMinor: number; leadTimeDeltaDays: number; wip: Array<Record<string, unknown>>; note: string; submittedAt: Date }>> {
    const res = await this.q(tx).query(
      `SELECT s.purchase_order_id AS "purchaseOrderId", s.supplier_organization_id AS "supplierOrganizationId", o.display_name AS "supplierDisplayName",
              s.cost_delta_minor AS "costDeltaMinor", s.lead_time_delta_days AS "leadTimeDeltaDays", s.wip, s.note, s.submitted_at AS "submittedAt"
         FROM change.supplier_impact s JOIN iam.organization o ON o.id = s.supplier_organization_id
        WHERE s.change_request_id = $1 ORDER BY s.submitted_at`,
      [changeId],
    );
    return res.rows.map((r: Record<string, unknown>) => ({ ...(r as { purchaseOrderId: string; supplierOrganizationId: string; supplierDisplayName: string; leadTimeDeltaDays: number; wip: Array<Record<string, unknown>>; note: string; submittedAt: Date }), costDeltaMinor: num(r['costDeltaMinor']) }));
  }

  async insertSupplierImpact(
    input: { changeId: string; purchaseOrderId: string; supplierOrganizationId: string; costDeltaMinor: number; leadTimeDeltaDays: number; wip: unknown[]; note: string; submittedBy: string },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO change.supplier_impact (change_request_id, purchase_order_id, supplier_organization_id, cost_delta_minor, lead_time_delta_days, wip, note, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [input.changeId, input.purchaseOrderId, input.supplierOrganizationId, input.costDeltaMinor, input.leadTimeDeltaDays, JSON.stringify(input.wip), input.note, input.submittedBy],
    );
  }

  // ----------------------------------------------------------------- interim decisions

  async interimDecisions(changeId: string, tx?: Queryable): Promise<InterimRow[]> {
    const res = await this.q(tx).query(
      `SELECT d.id, d.purchase_order_id AS "purchaseOrderId", p.number AS "purchaseOrderNumber", p.supplier_organization_id AS "supplierOrganizationId",
              d.decision, d.reason, d.expires_at AS "expiresAt", d.issued_at AS "issuedAt", d.lifted_at AS "liftedAt", d.lift_reason AS "liftReason"
         FROM change.interim_decision d JOIN orders.purchase_order p ON p.id = d.purchase_order_id
        WHERE d.change_request_id = $1 ORDER BY d.issued_at`,
      [changeId],
    );
    return res.rows as InterimRow[];
  }

  async insertInterim(input: { changeId: string; purchaseOrderId: string; decision: 'stop' | 'continue'; reason: string; expiresAt: Date; issuedBy: string }, tx: Queryable): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO change.interim_decision (change_request_id, purchase_order_id, decision, reason, expires_at, issued_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.changeId, input.purchaseOrderId, input.decision, input.reason, input.expiresAt, input.issuedBy],
    );
    return res.rows[0]!.id;
  }

  async liftInterim(input: { id: string; by: string; reason: string }, tx: Queryable): Promise<boolean> {
    const res = await tx.query(`UPDATE change.interim_decision SET lifted_at = now(), lifted_by = $2, lift_reason = $3 WHERE id = $1 AND lifted_at IS NULL`, [input.id, input.by, input.reason]);
    return (res.rowCount ?? 0) > 0;
  }

  async liftAllForChange(input: { changeId: string; by: string; reason: string }, tx: Queryable): Promise<number> {
    const res = await tx.query(`UPDATE change.interim_decision SET lifted_at = now(), lifted_by = $2, lift_reason = $3 WHERE change_request_id = $1 AND lifted_at IS NULL`, [input.changeId, input.by, input.reason]);
    return res.rowCount ?? 0;
  }

  // ----------------------------------------------------------------- customer decision

  async customerDecision(changeId: string, tx?: Queryable): Promise<{ decision: 'approved' | 'rejected'; reason: string; decidedAt: Date } | null> {
    const res = await this.q(tx).query(`SELECT decision, reason, decided_at AS "decidedAt" FROM change.customer_decision WHERE change_request_id = $1`, [changeId]);
    return (res.rows[0] as { decision: 'approved' | 'rejected'; reason: string; decidedAt: Date } | undefined) ?? null;
  }

  async insertCustomerDecision(
    input: { changeId: string; decision: 'approved' | 'rejected'; reason: string; decidedBy: string; membershipId: string; authoritySnapshot: Record<string, unknown> },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO change.customer_decision (change_request_id, decision, reason, decided_by, membership_id, authority_snapshot) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [input.changeId, input.decision, input.reason, input.decidedBy, input.membershipId, JSON.stringify(input.authoritySnapshot)],
    );
  }

  /** `change_acceptance` limit for this approver (no row: no limit, as for quotes). */
  async changeApprovalLimit(membershipId: string, currency: string, tx: Queryable): Promise<number | null> {
    const res = await tx.query<{ amount_minor: string }>(
      `SELECT amount_minor FROM iam.approval_limit
        WHERE membership_id = $1 AND limit_type = 'change_acceptance' AND currency = $2
          AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
        ORDER BY valid_from DESC LIMIT 1`,
      [membershipId, currency],
    );
    return res.rows[0] ? num(res.rows[0].amount_minor) : null;
  }

  // ----------------------------------------------------------------- amendments

  async amendments(changeId: string, tx?: Queryable): Promise<PoAmendmentRow[]> {
    const res = await this.q(tx).query(
      `SELECT a.id, a.purchase_order_id AS "purchaseOrderId", p.number AS "purchaseOrderNumber", p.supplier_organization_id AS "supplierOrganizationId",
              a.transmittal_id AS "transmittalId", a.currency, a.cost_delta_minor AS "costDeltaMinor", a.lead_time_delta_days AS "leadTimeDeltaDays",
              a.acknowledged_at AS "acknowledgedAt"
         FROM orders.purchase_order_amendment a JOIN orders.purchase_order p ON p.id = a.purchase_order_id
        WHERE a.change_request_id = $1 ORDER BY p.number`,
      [changeId],
    );
    return res.rows.map((r: Record<string, unknown>) => ({ ...(r as unknown as PoAmendmentRow), costDeltaMinor: num(r['costDeltaMinor']) }));
  }

  async insertPoAmendment(
    input: { purchaseOrderId: string; changeId: string; transmittalId: string; currency: string; costDeltaMinor: number; leadTimeDeltaDays: number },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO orders.purchase_order_amendment (purchase_order_id, change_request_id, transmittal_id, currency, cost_delta_minor, lead_time_delta_days) VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.purchaseOrderId, input.changeId, input.transmittalId, input.currency, input.costDeltaMinor, input.leadTimeDeltaDays],
    );
  }

  async acknowledgePoAmendment(input: { purchaseOrderId: string; changeId: string; by: string; note: string }, tx: Queryable): Promise<boolean> {
    const res = await tx.query(
      `UPDATE orders.purchase_order_amendment SET acknowledged_at = now(), acknowledged_by = $3, acknowledgment_note = $4
        WHERE purchase_order_id = $1 AND change_request_id = $2 AND acknowledged_at IS NULL`,
      [input.purchaseOrderId, input.changeId, input.by, input.note],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** A positive customer price delta becomes its own installment, invoiced by finance. */
  async addChangeInstallment(input: { salesOrderId: string; label: string; amountMinor: number; currency: string }, tx: Queryable): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO finance.installment (sales_order_id, seq, kind, label, amount_minor, currency, trigger)
       SELECT $1, COALESCE(MAX(seq), 0) + 1, 'change', $2, $3, $4, 'on_acceptance' FROM finance.installment WHERE sales_order_id = $1
       RETURNING id`,
      [input.salesOrderId, input.label, input.amountMinor, input.currency],
    );
    return res.rows[0]!.id;
  }

  async insertOrderAmendment(
    input: { salesOrderId: string; changeId: string; currency: string; priceDeltaMinor: number; deliveryDateDeltaDays: number; installmentId: string | null; createdBy: string },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO orders.order_amendment (sales_order_id, change_request_id, currency, price_delta_minor, delivery_date_delta_days, installment_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.salesOrderId, input.changeId, input.currency, input.priceDeltaMinor, input.deliveryDateDeltaDays, input.installmentId, input.createdBy],
    );
  }

  /** Every released baseline document version a new revision of `documentId` would replace, per open order. */
  async ordersBaseliningDocument(documentId: string, tx: Queryable): Promise<Array<{ salesOrderId: string; baselineNumber: string }>> {
    const res = await tx.query<{ salesOrderId: string; baselineNumber: string }>(
      `SELECT DISTINCT b.sales_order_id AS "salesOrderId", b.number AS "baselineNumber"
         FROM dms.baseline b
         JOIN dms.baseline_item i ON i.baseline_id = b.id
         JOIN dms.document_version v ON v.id = i.document_version_id
         JOIN orders.sales_order so ON so.id = b.sales_order_id
        WHERE v.document_id = $1 AND b.status = 'released' AND so.status NOT IN ('closed', 'cancelled')`,
      [documentId],
    );
    return res.rows;
  }
}
