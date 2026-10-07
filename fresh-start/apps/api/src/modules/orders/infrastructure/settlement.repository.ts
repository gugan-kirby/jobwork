import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { BillMatch, SettlementStatus, SupplierBillStatus } from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';

type Queryable = Pool | PoolClient;

export interface BillRow {
  id: string;
  number: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  supplierOrganizationId: string;
  supplierDisplayName: string;
  supplierReference: string;
  billDate: string;
  currency: string;
  quantity: string;
  taxableMinor: number;
  taxMinor: number;
  totalMinor: number;
  status: SupplierBillStatus;
  matchSnapshot: BillMatch | null;
  approvalRequestId: string | null;
  decisionNote: string;
  submittedAt: Date;
  aggregateVersion: number;
}

export interface SettlementRow {
  id: string;
  supplierBillId: string;
  status: SettlementStatus;
  eligibility: { pass: boolean; reasons: string[]; computedAt: string };
  scheduledFor: string | null;
  paidAt: Date | null;
  paymentReference: string;
  aggregateVersion: number;
}

const BILL_COLUMNS = `b.id, b.number, b.purchase_order_id AS "purchaseOrderId", p.number AS "purchaseOrderNumber", b.supplier_organization_id AS "supplierOrganizationId",
  o.display_name AS "supplierDisplayName", b.supplier_reference AS "supplierReference", b.bill_date::text AS "billDate", b.currency, b.quantity::text AS quantity,
  b.taxable_minor::int AS "taxableMinor", b.tax_minor::int AS "taxMinor", b.total_minor::int AS "totalMinor", b.status, b.match_snapshot AS "matchSnapshot",
  b.approval_request_id AS "approvalRequestId", b.decision_note AS "decisionNote", b.submitted_at AS "submittedAt", b.aggregate_version AS "aggregateVersion"`;
const BILL_FROM = `FROM finance.supplier_bill b JOIN orders.purchase_order p ON p.id = b.purchase_order_id JOIN iam.organization o ON o.id = b.supplier_organization_id`;

/**
 * Bills, settlements and the facts a match and an eligibility read (IN-18 F-18.1). The receipt and
 * quality facts are read from the logistics and quality records by query: those modules import this
 * one, so the facts come by SQL rather than by import, and nothing here writes to them.
 */
@Injectable()
export class SettlementRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  async allocateNumber(prefix: 'SB' | 'CN', table: 'finance.supplier_bill' | 'finance.credit_note', now: Date, tx: Queryable): Promise<string> {
    const year = now.getUTCFullYear();
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${table}.number`]);
    const res = await tx.query<{ next: number }>(`SELECT COALESCE(MAX(NULLIF(split_part(number, '-', 3), '')::int), 0) + 1 AS next FROM ${table} WHERE number LIKE $1`, [`${prefix}-${year}-%`]);
    return `${prefix}-${year}-${String(res.rows[0]!.next).padStart(4, '0')}`;
  }

  // ----------------------------------------------------------------- facts

  async purchaseOrder(id: string, tx?: Queryable): Promise<{ id: string; number: string; status: string; salesOrderId: string; supplierOrganizationId: string; currency: string; totalMinor: number; quantity: number; workPackageId: string | null; workPackageStatus: string | null } | null> {
    const res = await this.q(tx).query<{ id: string; number: string; status: string; salesOrderId: string; supplierOrganizationId: string; currency: string; totalMinor: number; quantity: string; workPackageId: string | null; workPackageStatus: string | null }>(
      `SELECT p.id, p.number, p.status, p.sales_order_id AS "salesOrderId", p.supplier_organization_id AS "supplierOrganizationId", p.currency, p.total_minor::int AS "totalMinor",
              (SELECT COALESCE(SUM(quantity), 0)::text FROM orders.purchase_order_line WHERE purchase_order_id = p.id) AS quantity, w.id AS "workPackageId", w.status AS "workPackageStatus"
         FROM orders.purchase_order p LEFT JOIN orders.work_package w ON w.purchase_order_id = p.id WHERE p.id = $1`,
      [id],
    );
    const r = res.rows[0];
    return r ? { ...r, quantity: Number(r.quantity) } : null;
  }

  /** Everything of the work package that ever entered `JW-STOCK` from outside it (IN-16's "accepted"). */
  async acceptedQuantity(workPackageId: string, tx?: Queryable): Promise<number> {
    const res = await this.q(tx).query<{ q: string }>(
      `SELECT COALESCE(SUM(m.quantity), 0)::text AS q FROM logistics.stock_movement m JOIN logistics.stock_lot t ON t.id = m.lot_id
         JOIN logistics.custody_location c ON c.id = m.to_location_id
        WHERE t.work_package_id = $1 AND t.ownership = 'jobwork' AND c.code = 'JW-STOCK'
          AND m.from_location_id IS DISTINCT FROM (SELECT id FROM logistics.custody_location WHERE code = 'JW-STOCK')
          AND m.type <> 'return'`,
      [workPackageId],
    );
    return Number(res.rows[0]!.q);
  }

  async billedBefore(purchaseOrderId: string, excludeBillId: string | null, tx?: Queryable): Promise<{ quantity: number; taxableMinor: number }> {
    const res = await this.q(tx).query<{ quantity: string; taxable: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::text AS quantity, COALESCE(SUM(taxable_minor), 0)::text AS taxable FROM finance.supplier_bill
        WHERE purchase_order_id = $1 AND status IN ('matched', 'exception_approved') AND ($2::uuid IS NULL OR id <> $2)`,
      [purchaseOrderId, excludeBillId],
    );
    return { quantity: Number(res.rows[0]!.quantity), taxableMinor: Number(res.rows[0]!.taxable) };
  }

  async qualityReleased(workPackageId: string, tx?: Queryable): Promise<boolean> {
    const res = await this.q(tx).query(`SELECT 1 FROM quality.quality_release WHERE work_package_id = $1 LIMIT 1`, [workPackageId]);
    return (res.rowCount ?? 0) > 0;
  }

  async openNcrs(workPackageId: string, tx?: Queryable): Promise<string[]> {
    const res = await this.q(tx).query<{ number: string }>(`SELECT number FROM quality.ncr WHERE work_package_id = $1 AND status NOT IN ('closed', 'accepted_under_deviation') ORDER BY number`, [workPackageId]);
    return res.rows.map((r) => r.number);
  }

  async supplierStanding(organizationId: string, tx?: Queryable): Promise<{ active: boolean; bankVerified: boolean }> {
    const res = await this.q(tx).query<{ active: boolean; bank: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM supplier.supplier_profile WHERE organization_id = $1 AND status = 'active') AS active,
              EXISTS (SELECT 1 FROM supplier.verification_item v JOIN supplier.supplier_profile sp ON sp.id = v.supplier_profile_id
                       WHERE sp.organization_id = $1 AND v.kind = 'bank_account' AND v.status IN ('verified', 'expiring') AND (v.expires_at IS NULL OR v.expires_at > now())) AS bank`,
      [organizationId],
    );
    return { active: res.rows[0]!.active, bankVerified: res.rows[0]!.bank };
  }

  /** Open cases that hold a supplier's money on this PO: a dispute, or a recovery not yet verified. */
  async holdingCases(purchaseOrderId: string, tx?: Queryable): Promise<string[]> {
    const res = await this.q(tx).query<{ number: string }>(
      `SELECT c.number FROM support.case c
        WHERE c.purchase_order_id = $1 AND c.status NOT IN ('closed', 'rejected', 'withdrawn')
          AND (c.kind = 'dispute' OR EXISTS (SELECT 1 FROM support.resolution_action a WHERE a.case_id = c.id AND a.kind = 'supplier_recovery' AND a.status NOT IN ('verified', 'cancelled')))
        ORDER BY c.number`,
      [purchaseOrderId],
    );
    return res.rows.map((r) => r.number);
  }

  async ownCleanVersion(documentVersionId: string, organizationId: string, tx?: Queryable): Promise<boolean> {
    const res = await this.q(tx).query(
      `SELECT 1 FROM dms.document_version v JOIN dms.document d ON d.id = v.document_id JOIN dms.file_object f ON f.id = v.file_object_id
        WHERE v.id = $1 AND d.owning_organization_id = $2 AND v.status = 'available' AND f.scan_state = 'clean'`,
      [documentVersionId, organizationId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ----------------------------------------------------------------- bills

  async insertBill(
    input: { number: string; purchaseOrderId: string; supplierOrganizationId: string; supplierReference: string; billDate: string; currency: string; quantity: string; taxableMinor: number; taxMinor: number; documentVersionId: string | null; by: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO finance.supplier_bill (number, purchase_order_id, supplier_organization_id, supplier_reference, bill_date, currency, quantity, taxable_minor, tax_minor, total_minor, document_version_id, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8::bigint + $9::bigint, $10, $11) RETURNING id`,
      [input.number, input.purchaseOrderId, input.supplierOrganizationId, input.supplierReference, input.billDate, input.currency, input.quantity, input.taxableMinor, input.taxMinor, input.documentVersionId, input.by],
    );
    return res.rows[0]!.id;
  }

  async findBill(id: string, tx?: Queryable, forUpdate = false): Promise<BillRow | null> {
    const res = await this.q(tx).query<BillRow>(`SELECT ${BILL_COLUMNS} ${BILL_FROM} WHERE b.id = $1 ${forUpdate ? 'FOR UPDATE OF b' : ''}`, [id]);
    return res.rows[0] ?? null;
  }

  async findBillByApproval(approvalRequestId: string, tx: Queryable): Promise<BillRow | null> {
    const res = await tx.query<BillRow>(`SELECT ${BILL_COLUMNS} ${BILL_FROM} WHERE b.approval_request_id = $1 FOR UPDATE OF b`, [approvalRequestId]);
    return res.rows[0] ?? null;
  }

  async listBills(filter: { supplierOrganizationId?: string; status?: SupplierBillStatus; purchaseOrderId?: string }, tx?: Queryable): Promise<BillRow[]> {
    const res = await this.q(tx).query<BillRow>(
      `SELECT ${BILL_COLUMNS} ${BILL_FROM}
        WHERE ($1::uuid IS NULL OR b.supplier_organization_id = $1) AND ($2::text IS NULL OR b.status = $2) AND ($3::uuid IS NULL OR b.purchase_order_id = $3)
        ORDER BY b.submitted_at DESC LIMIT 200`,
      [filter.supplierOrganizationId ?? null, filter.status ?? null, filter.purchaseOrderId ?? null],
    );
    return res.rows;
  }

  async updateBill(id: string, fields: Partial<{ status: SupplierBillStatus; matchSnapshot: BillMatch; approvalRequestId: string; decidedBy: string; decisionNote: string; journalId: string }>, tx: Queryable): Promise<number> {
    const res = await tx.query<{ aggregate_version: number }>(
      `UPDATE finance.supplier_bill SET status = COALESCE($2, status), match_snapshot = COALESCE($3::jsonb, match_snapshot), approval_request_id = COALESCE($4, approval_request_id),
              decided_by = COALESCE($5, decided_by), decided_at = CASE WHEN $5::uuid IS NULL THEN decided_at ELSE now() END, decision_note = COALESCE($6, decision_note),
              journal_id = COALESCE($7, journal_id), aggregate_version = aggregate_version + 1
        WHERE id = $1 RETURNING aggregate_version`,
      [id, fields.status ?? null, fields.matchSnapshot ? JSON.stringify(fields.matchSnapshot) : null, fields.approvalRequestId ?? null, fields.decidedBy ?? null, fields.decisionNote ?? null, fields.journalId ?? null],
    );
    return res.rows[0]!.aggregate_version;
  }

  // ----------------------------------------------------------------- settlements

  async insertSettlement(input: { supplierBillId: string; status: SettlementStatus; eligibility: SettlementRow['eligibility'] }, tx: Queryable): Promise<string> {
    const res = await tx.query<{ id: string }>(`INSERT INTO finance.settlement (supplier_bill_id, status, eligibility) VALUES ($1, $2, $3) RETURNING id`, [input.supplierBillId, input.status, JSON.stringify(input.eligibility)]);
    return res.rows[0]!.id;
  }

  async settlementForBill(billId: string, tx?: Queryable, forUpdate = false): Promise<SettlementRow | null> {
    const res = await this.q(tx).query<SettlementRow>(
      `SELECT id, supplier_bill_id AS "supplierBillId", status, eligibility, scheduled_for::text AS "scheduledFor", paid_at AS "paidAt", payment_reference AS "paymentReference", aggregate_version AS "aggregateVersion"
         FROM finance.settlement WHERE supplier_bill_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [billId],
    );
    return res.rows[0] ?? null;
  }

  async updateSettlement(id: string, fields: Partial<{ status: SettlementStatus; eligibility: SettlementRow['eligibility']; scheduledFor: string; paymentReference: string; paidBy: string; journalId: string }>, tx: Queryable): Promise<number> {
    const res = await tx.query<{ aggregate_version: number }>(
      `UPDATE finance.settlement SET status = COALESCE($2, status), eligibility = COALESCE($3::jsonb, eligibility), scheduled_for = COALESCE($4::date, scheduled_for),
              payment_reference = COALESCE($5, payment_reference), paid_by = COALESCE($6, paid_by), paid_at = CASE WHEN $6::uuid IS NULL THEN paid_at ELSE now() END,
              journal_id = COALESCE($7, journal_id), aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1 RETURNING aggregate_version`,
      [id, fields.status ?? null, fields.eligibility ? JSON.stringify(fields.eligibility) : null, fields.scheduledFor ?? null, fields.paymentReference ?? null, fields.paidBy ?? null, fields.journalId ?? null],
    );
    return res.rows[0]!.aggregate_version;
  }

  // ----------------------------------------------------------------- order closure (doc 06 §7)

  /** Whether an accepted order has nothing left owed either way: every PO billed and paid, no case open. */
  async orderSettled(salesOrderId: string, tx?: Queryable): Promise<boolean> {
    const res = await this.q(tx).query<{ done: boolean }>(
      `SELECT NOT EXISTS (
                SELECT 1 FROM orders.purchase_order p WHERE p.sales_order_id = $1 AND p.status <> 'cancelled'
                   AND (NOT EXISTS (SELECT 1 FROM finance.supplier_bill b WHERE b.purchase_order_id = p.id AND b.status <> 'rejected')
                        OR EXISTS (SELECT 1 FROM finance.supplier_bill b LEFT JOIN finance.settlement s ON s.supplier_bill_id = b.id
                                    WHERE b.purchase_order_id = p.id AND b.status <> 'rejected' AND (s.status IS NULL OR s.status <> 'paid'))))
          AND NOT EXISTS (SELECT 1 FROM support.case c WHERE c.sales_order_id = $1 AND c.status NOT IN ('closed', 'rejected', 'withdrawn')) AS done`,
      [salesOrderId],
    );
    return res.rows[0]!.done;
  }

  // ----------------------------------------------------------------- credit notes (BR-FIN-06)

  async creditedOn(invoiceId: string, tx?: Queryable): Promise<number> {
    const res = await this.q(tx).query<{ total: string }>(`SELECT COALESCE(SUM(total_minor), 0)::text AS total FROM finance.credit_note WHERE invoice_id = $1`, [invoiceId]);
    return Number(res.rows[0]!.total);
  }

  async insertCreditNote(
    input: { number: string; invoiceId: string; salesOrderId: string; customerOrganizationId: string; currency: string; reason: string; taxableMinor: number; taxMinor: number; caseId: string | null; contentHash: string; journalId: string; by: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO finance.credit_note (number, invoice_id, sales_order_id, customer_organization_id, currency, reason, taxable_minor, tax_minor, total_minor, case_id, content_hash, journal_id, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7::bigint + $8::bigint, $9, $10, $11, $12) RETURNING id`,
      [input.number, input.invoiceId, input.salesOrderId, input.customerOrganizationId, input.currency, input.reason, input.taxableMinor, input.taxMinor, input.caseId, input.contentHash, input.journalId, input.by],
    );
    return res.rows[0]!.id;
  }
}
