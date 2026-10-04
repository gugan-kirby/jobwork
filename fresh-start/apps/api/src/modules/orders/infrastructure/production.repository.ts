import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { BaselineCandidate, MilestoneStatus } from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';
import { parallelReads } from '../../../platform/database/parallel-reads';

type Queryable = Pool | PoolClient;

export interface BaselineItemRecord {
  documentId: string;
  documentVersionId: string;
  title: string;
  logicalType: string;
  versionNo: number;
  filename: string;
  fileSha256: string;
  purpose: 'governing' | 'reference' | 'inspection';
  governingPriority: number;
}

export interface BaselineRecord {
  id: string;
  number: string;
  salesOrderId: string;
  kind: 'production' | 'inspection';
  status: 'draft' | 'released' | 'superseded';
  note: string;
  manifestHash: string | null;
  releasedAt: Date | null;
  createdAt: Date;
  aggregateVersion: number;
  items: BaselineItemRecord[];
}

export interface TransmittalRecord {
  id: string;
  number: string;
  baselineId: string;
  baselineNumber: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  recipientOrganizationId: string;
  recipientDisplayName: string;
  manifestHash: string;
  status: 'issued' | 'acknowledged' | 'superseded' | 'revoked';
  acknowledgmentDueAt: Date;
  issuedAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  acknowledgmentNote: string;
  aggregateVersion: number;
}

export interface EvidenceRecord {
  id: string;
  milestoneId: string;
  documentId: string;
  documentVersionId: string;
  filename: string;
  fileSha256: string;
  scanState: string;
  observedAt: Date;
  submittedAt: Date;
  submittedBy: string;
  flagged: boolean;
  flagReason: string | null;
  note: string;
}

export interface ForecastRecord {
  revisionNo: number;
  forecastDate: string;
  reasonCode: 'machine' | 'material' | 'labour' | 'quality' | 'customer' | 'other';
  reason: string;
  recordedAt: Date;
}

export interface MilestoneRecord {
  id: string;
  workPackageId: string;
  seq: number;
  title: string;
  customerLabel: string | null;
  evidencePolicy: 'photo' | 'document' | 'none';
  minEvidence: number;
  verifierRole: string;
  status: MilestoneStatus;
  plannedDate: string;
  forecastDate: string;
  actualDate: string | null;
  startedAt: Date | null;
  submittedAt: Date | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionReason: string | null;
  backdateReason: string | null;
  aggregateVersion: number;
  forecasts: ForecastRecord[];
  evidence: EvidenceRecord[];
}

export interface ContainmentRecord {
  id: string;
  purchaseOrderId: string;
  workPackageId: string | null;
  kind: 'unauthorized_start' | 'subcontracting' | 'other';
  description: string;
  reportedAt: Date;
  disposition: string | null;
  disposedAt: Date | null;
}

export interface WorkPackageRecord {
  id: string;
  number: string;
  salesOrderId: string;
  salesOrderNumber: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  supplierOrganizationId: string;
  supplierDisplayName: string;
  status: 'planned' | 'released' | 'in_production' | 'completed' | 'cancelled';
  plannedStart: string | null;
  plannedFinish: string | null;
  qualityPlanPresent: boolean;
  planningNote: string;
  releaseSnapshot: Record<string, unknown> | null;
  releasedAt: Date | null;
  completedAt: Date | null;
  aggregateVersion: number;
  milestones: MilestoneRecord[];
}

const NUMBERED = {
  BL: 'dms.baseline',
  TR: 'dms.transmittal',
  WP: 'orders.work_package',
} as const;

/**
 * Persistence for baselines, transmittals, work packages, milestones and evidence.
 * Supplier reads are by purchase order and organization; nothing here joins the customer
 * into a supplier-facing row.
 */
@Injectable()
export class ProductionRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  async allocateNumber(kind: keyof typeof NUMBERED, now: Date, tx: Queryable): Promise<string> {
    const year = now.getUTCFullYear();
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${NUMBERED[kind]}.number`]);
    const res = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(NULLIF(split_part(number, '-', 3), '')::int), 0) + 1 AS next FROM ${NUMBERED[kind]} WHERE number LIKE $1`,
      [`${kind}-${year}-%`],
    );
    return `${kind}-${year}-${String(res.rows[0]!.next).padStart(4, '0')}`;
  }

  // ----------------------------------------------------------------- baseline candidates

  /** The order's enquiry documents and JobWork's own documents linked to nothing else. */
  async baselineCandidates(salesOrderId: string, tx?: Queryable): Promise<BaselineCandidate[]> {
    const res = await this.q(tx).query(
      `SELECT d.id AS "documentId", dv.id AS "documentVersionId", d.title, d.logical_type AS "logicalType", dv.version_no AS "versionNo",
              dv.original_filename AS filename, f.sha256 AS "fileSha256", dv.status, f.scan_state AS "scanState", ed.role AS source
         FROM orders.sales_order so
         JOIN sourcing.enquiry_document ed ON ed.enquiry_id = so.enquiry_id
         JOIN dms.document_version dv ON dv.id = ed.document_version_id
         JOIN dms.document d ON d.id = dv.document_id
         JOIN dms.file_object f ON f.id = dv.file_object_id
        WHERE so.id = $1
       UNION ALL
       SELECT d.id, dv.id, d.title, d.logical_type, dv.version_no, dv.original_filename, f.sha256, dv.status, f.scan_state, 'internal'
         FROM dms.document d
         JOIN iam.organization o ON o.id = d.owning_organization_id AND o.type = 'internal'
         JOIN dms.document_version dv ON dv.document_id = d.id AND dv.version_no = d.current_version_no
         JOIN dms.file_object f ON f.id = dv.file_object_id
       UNION ALL
       -- IN-13: the revisions an open change brings in (a customer's new drawing version).
       SELECT DISTINCT d.id, dv.id, d.title, d.logical_type, dv.version_no, dv.original_filename, f.sha256, dv.status, f.scan_state, 'change'
         FROM change.change_request c
         JOIN dms.document_version dv ON dv.id = ANY(c.context_document_version_ids)
         JOIN dms.document d ON d.id = dv.document_id
         JOIN dms.file_object f ON f.id = dv.file_object_id
        WHERE c.sales_order_id = $1 AND c.status NOT IN ('closed', 'withdrawn', 'rejected')
       ORDER BY 10, 3`,
      [salesOrderId],
    );
    return (res.rows as Array<Omit<BaselineCandidate, 'selectable' | 'reason'>>).map((row) => {
      const reason =
        row.status !== 'available'
          ? `Version is ${row.status}.`
          : row.scanState !== 'clean'
            ? `File is not scan-clean (${row.scanState}).`
            : row.source === 'assisted_photo'
              ? 'A reference photo is not a manufacturing document.'
              : null;
      return { ...row, selectable: reason === null, reason };
    });
  }

  // ----------------------------------------------------------------- baselines

  async findDraftBaseline(salesOrderId: string, tx: Queryable): Promise<{ id: string } | null> {
    const res = await tx.query<{ id: string }>(`SELECT id FROM dms.baseline WHERE sales_order_id = $1 AND status = 'draft' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [salesOrderId]);
    return res.rows[0] ?? null;
  }

  async createBaseline(input: { number: string; salesOrderId: string; note: string; createdBy: string }, tx: Queryable): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO dms.baseline (number, sales_order_id, note, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.number, input.salesOrderId, input.note, input.createdBy],
    );
    return res.rows[0]!.id;
  }

  async replaceBaselineItems(
    baselineId: string,
    note: string,
    items: Array<{ documentId: string; documentVersionId: string; fileSha256: string; purpose: string; governingPriority: number }>,
    tx: Queryable,
  ): Promise<void> {
    await tx.query(`DELETE FROM dms.baseline_item WHERE baseline_id = $1`, [baselineId]);
    for (const item of items) {
      await tx.query(
        `INSERT INTO dms.baseline_item (baseline_id, document_id, document_version_id, file_sha256, purpose, governing_priority) VALUES ($1,$2,$3,$4,$5,$6)`,
        [baselineId, item.documentId, item.documentVersionId, item.fileSha256, item.purpose, item.governingPriority],
      );
    }
    await tx.query(`UPDATE dms.baseline SET note = $2, aggregate_version = aggregate_version + 1 WHERE id = $1`, [baselineId, note]);
  }

  async findBaseline(id: string, tx?: Queryable, forUpdate = false): Promise<BaselineRecord | null> {
    const res = await this.q(tx).query(
      `SELECT id, number, sales_order_id AS "salesOrderId", kind, status, note, manifest_hash AS "manifestHash",
              released_at AS "releasedAt", created_at AS "createdAt", aggregate_version AS "aggregateVersion"
         FROM dms.baseline WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    const head = res.rows[0] as Omit<BaselineRecord, 'items'> | undefined;
    if (!head) return null;
    const items = await this.q(tx).query(
      `SELECT i.document_id AS "documentId", i.document_version_id AS "documentVersionId", d.title, d.logical_type AS "logicalType",
              dv.version_no AS "versionNo", dv.original_filename AS filename, i.file_sha256 AS "fileSha256", i.purpose,
              i.governing_priority AS "governingPriority"
         FROM dms.baseline_item i
         JOIN dms.document d ON d.id = i.document_id
         JOIN dms.document_version dv ON dv.id = i.document_version_id
        WHERE i.baseline_id = $1
        ORDER BY CASE i.purpose WHEN 'governing' THEN 0 WHEN 'inspection' THEN 1 ELSE 2 END, i.governing_priority, d.title`,
      [id],
    );
    return { ...head, items: items.rows as BaselineItemRecord[] };
  }

  async listBaselines(salesOrderId: string, tx?: Queryable): Promise<BaselineRecord[]> {
    const res = await this.q(tx).query<{ id: string }>(`SELECT id FROM dms.baseline WHERE sales_order_id = $1 ORDER BY created_at DESC`, [salesOrderId]);
    const out: BaselineRecord[] = [];
    for (const { id } of res.rows) {
      const b = await this.findBaseline(id, tx);
      if (b) out.push(b);
    }
    return out;
  }

  async releasedBaseline(salesOrderId: string, tx?: Queryable): Promise<BaselineRecord | null> {
    const res = await this.q(tx).query<{ id: string }>(`SELECT id FROM dms.baseline WHERE sales_order_id = $1 AND kind = 'production' AND status = 'released'`, [salesOrderId]);
    return res.rows[0] ? this.findBaseline(res.rows[0].id, tx) : null;
  }

  /** The baseline the supplier last acknowledged for this PO: what its work actually follows. */
  async acknowledgedBaselineId(purchaseOrderId: string, tx?: Queryable): Promise<string | null> {
    const res = await this.q(tx).query<{ baseline_id: string }>(
      `SELECT baseline_id FROM dms.transmittal
        WHERE purchase_order_id = $1 AND acknowledged_at IS NOT NULL
        ORDER BY acknowledged_at DESC LIMIT 1`,
      [purchaseOrderId],
    );
    return res.rows[0]?.baseline_id ?? null;
  }

  async recordWorkPackageBaseline(input: { workPackageId: string; baselineId: string; transmittalId: string; by: string }, tx: Queryable): Promise<void> {
    await tx.query(
      `INSERT INTO orders.work_package_baseline (work_package_id, baseline_id, transmittal_id, recorded_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (work_package_id, baseline_id) DO NOTHING`,
      [input.workPackageId, input.baselineId, input.transmittalId, input.by],
    );
  }

  async baselinesUsed(workPackageId: string, tx?: Queryable): Promise<Array<{ baselineId: string; number: string; transmittalNumber: string; effectiveFrom: Date }>> {
    const res = await this.q(tx).query(
      `SELECT h.baseline_id AS "baselineId", b.number, t.number AS "transmittalNumber", h.effective_from AS "effectiveFrom"
         FROM orders.work_package_baseline h
         JOIN dms.baseline b ON b.id = h.baseline_id
         JOIN dms.transmittal t ON t.id = h.transmittal_id
        WHERE h.work_package_id = $1 ORDER BY h.effective_from, b.number`,
      [workPackageId],
    );
    return res.rows as Array<{ baselineId: string; number: string; transmittalNumber: string; effectiveFrom: Date }>;
  }

  async supersedeReleasedBaselines(salesOrderId: string, tx: Queryable): Promise<string[]> {
    const res = await tx.query<{ id: string }>(
      `UPDATE dms.baseline SET status = 'superseded', aggregate_version = aggregate_version + 1
        WHERE sales_order_id = $1 AND kind = 'production' AND status = 'released' RETURNING id`,
      [salesOrderId],
    );
    return res.rows.map((r) => r.id);
  }

  async releaseBaseline(input: { baselineId: string; manifestHash: string; releasedBy: string; supersedes: string | null; changeRequestId?: string | null }, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE dms.baseline SET status = 'released', manifest_hash = $2, released_by = $3, released_at = now(), supersedes_baseline_id = $4,
              change_request_id = $5, aggregate_version = aggregate_version + 1
        WHERE id = $1`,
      [input.baselineId, input.manifestHash, input.releasedBy, input.supersedes, input.changeRequestId ?? null],
    );
  }

  /**
   * One purchase order's transmittal of a released baseline: supersedes its live one,
   * grants the supplier each exact version, and marks the PO as having its baseline.
   */
  async transmitBaseline(
    input: { baseline: BaselineRecord; purchaseOrderId: string; supplierOrganizationId: string; dueAt: Date; issuedBy: string; now: Date },
    tx: Queryable,
  ): Promise<{ transmittalId: string; number: string; grants: number; supersedes: string | null } | null> {
    const live = await this.liveTransmittal(input.purchaseOrderId, tx);
    if (live && live.baselineId === input.baseline.id) return null;
    const number = await this.allocateNumber('TR', input.now, tx);
    if (live) await tx.query(`UPDATE dms.transmittal SET status = 'superseded', aggregate_version = aggregate_version + 1 WHERE id = $1`, [live.id]);
    const transmittalId = await this.issueTransmittal(
      { number, baselineId: input.baseline.id, purchaseOrderId: input.purchaseOrderId, recipientOrganizationId: input.supplierOrganizationId, manifestHash: input.baseline.manifestHash!, dueAt: input.dueAt, issuedBy: input.issuedBy },
      tx,
    );
    if (live) await this.supersedeTransmittal(live.id, transmittalId, tx);
    let grants = 0;
    for (const item of input.baseline.items) {
      if (await this.grantVersion({ documentVersionId: item.documentVersionId, organizationId: input.supplierOrganizationId, grantedBy: input.issuedBy }, tx)) grants += 1;
    }
    await this.markPurchaseOrderBaselineReleased(input.purchaseOrderId, tx);
    return { transmittalId, number, grants, supersedes: live?.id ?? null };
  }

  /**
   * A supplier keeps no access to a drawing the new baseline dropped: it may not
   * manufacture from it. Evidence rows that referenced it keep referencing it.
   */
  async revokeStaleGrants(input: { organizationId: string; oldBaselineId: string; keepVersionIds: string[]; by: string }, tx: Queryable): Promise<number> {
    const res = await tx.query(
      `UPDATE dms.audience_grant SET revoked_at = now(), revoked_by = $4
        WHERE organization_id = $1 AND revoked_at IS NULL
          AND document_version_id IN (SELECT document_version_id FROM dms.baseline_item WHERE baseline_id = $2)
          AND NOT (document_version_id = ANY($3::uuid[]))`,
      [input.organizationId, input.oldBaselineId, input.keepVersionIds, input.by],
    );
    return res.rowCount ?? 0;
  }

  /** The interim stop in force on a purchase order, if any (IN-13). */
  async activeStop(purchaseOrderId: string, tx?: Queryable): Promise<{ changeNumber: string; reason: string; expiresAt: Date } | null> {
    const res = await this.q(tx).query<{ changeNumber: string; reason: string; expiresAt: Date }>(
      `SELECT c.number AS "changeNumber", d.reason, d.expires_at AS "expiresAt"
         FROM change.interim_decision d JOIN change.change_request c ON c.id = d.change_request_id
        WHERE d.purchase_order_id = $1 AND d.decision = 'stop' AND d.lifted_at IS NULL AND d.expires_at > now()
        ORDER BY d.issued_at DESC LIMIT 1`,
      [purchaseOrderId],
    );
    return res.rows[0] ?? null;
  }

  // ----------------------------------------------------------------- transmittals

  private readonly transmittalSelect = `
      SELECT t.id, t.number, t.baseline_id AS "baselineId", b.number AS "baselineNumber", t.purchase_order_id AS "purchaseOrderId",
             p.number AS "purchaseOrderNumber", t.recipient_organization_id AS "recipientOrganizationId", o.display_name AS "recipientDisplayName",
             t.manifest_hash AS "manifestHash", t.status, t.acknowledgment_due_at AS "acknowledgmentDueAt", t.issued_at AS "issuedAt",
             t.acknowledged_at AS "acknowledgedAt", t.acknowledged_by AS "acknowledgedBy", t.acknowledgment_note AS "acknowledgmentNote",
             t.aggregate_version AS "aggregateVersion"
        FROM dms.transmittal t
        JOIN dms.baseline b ON b.id = t.baseline_id
        JOIN orders.purchase_order p ON p.id = t.purchase_order_id
        JOIN iam.organization o ON o.id = t.recipient_organization_id`;

  async findTransmittal(id: string, tx?: Queryable, forUpdate = false): Promise<TransmittalRecord | null> {
    const res = await this.q(tx).query(`${this.transmittalSelect} WHERE t.id = $1 ${forUpdate ? 'FOR UPDATE OF t' : ''}`, [id]);
    return (res.rows[0] as TransmittalRecord | undefined) ?? null;
  }

  async liveTransmittal(purchaseOrderId: string, tx?: Queryable): Promise<TransmittalRecord | null> {
    const res = await this.q(tx).query(`${this.transmittalSelect} WHERE t.purchase_order_id = $1 AND t.status IN ('issued', 'acknowledged')`, [purchaseOrderId]);
    return (res.rows[0] as TransmittalRecord | undefined) ?? null;
  }

  async listTransmittalsForBaseline(baselineId: string, tx?: Queryable): Promise<TransmittalRecord[]> {
    const res = await this.q(tx).query(`${this.transmittalSelect} WHERE t.baseline_id = $1 ORDER BY t.number`, [baselineId]);
    return res.rows as TransmittalRecord[];
  }

  async issueTransmittal(
    input: { number: string; baselineId: string; purchaseOrderId: string; recipientOrganizationId: string; manifestHash: string; dueAt: Date; issuedBy: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO dms.transmittal (number, baseline_id, purchase_order_id, recipient_organization_id, manifest_hash, acknowledgment_due_at, issued_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.number, input.baselineId, input.purchaseOrderId, input.recipientOrganizationId, input.manifestHash, input.dueAt, input.issuedBy],
    );
    return res.rows[0]!.id;
  }

  async supersedeTransmittal(id: string, by: string, tx: Queryable): Promise<void> {
    await tx.query(`UPDATE dms.transmittal SET status = 'superseded', superseded_by_transmittal_id = $2, aggregate_version = aggregate_version + 1 WHERE id = $1`, [id, by]);
  }

  async acknowledgeTransmittal(input: { transmittalId: string; by: string; note: string }, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE dms.transmittal SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(), acknowledgment_note = $3,
              aggregate_version = aggregate_version + 1
        WHERE id = $1`,
      [input.transmittalId, input.by, input.note],
    );
  }

  /** BR-ENG-02: access to an exact version, for one organization, recorded as a grant. */
  async grantVersion(input: { documentVersionId: string; organizationId: string; grantedBy: string }, tx: Queryable): Promise<boolean> {
    const existing = await tx.query(
      `SELECT 1 FROM dms.audience_grant WHERE document_version_id = $1 AND organization_id = $2 AND revoked_at IS NULL`,
      [input.documentVersionId, input.organizationId],
    );
    if ((existing.rowCount ?? 0) > 0) return false;
    await tx.query(
      `INSERT INTO dms.audience_grant (document_version_id, audience_type, organization_id, actions, granted_by) VALUES ($1, 'organization', $2, '{view,download}', $3)`,
      [input.documentVersionId, input.organizationId, input.grantedBy],
    );
    return true;
  }

  async markPurchaseOrderBaselineReleased(purchaseOrderId: string, tx: Queryable): Promise<void> {
    await tx.query(`UPDATE orders.purchase_order SET baseline_status = 'baseline_released', aggregate_version = aggregate_version + 1, updated_at = now() WHERE id = $1`, [purchaseOrderId]);
  }

  // ----------------------------------------------------------------- work packages

  async createWorkPackage(
    input: { number: string; salesOrderId: string; purchaseOrderId: string; supplierOrganizationId: string; createdBy: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO orders.work_package (number, sales_order_id, purchase_order_id, supplier_organization_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [input.number, input.salesOrderId, input.purchaseOrderId, input.supplierOrganizationId, input.createdBy],
    );
    return res.rows[0]!.id;
  }

  async workPackageIdForPurchaseOrder(purchaseOrderId: string, tx?: Queryable): Promise<string | null> {
    const res = await this.q(tx).query<{ id: string }>(`SELECT id FROM orders.work_package WHERE purchase_order_id = $1`, [purchaseOrderId]);
    return res.rows[0]?.id ?? null;
  }

  async findWorkPackage(id: string, tx?: Queryable, forUpdate = false): Promise<WorkPackageRecord | null> {
    const res = await this.q(tx).query(
      `SELECT w.id, w.number, w.sales_order_id AS "salesOrderId", so.number AS "salesOrderNumber", w.purchase_order_id AS "purchaseOrderId",
              p.number AS "purchaseOrderNumber", w.supplier_organization_id AS "supplierOrganizationId", o.display_name AS "supplierDisplayName",
              w.status, w.planned_start AS "plannedStart", w.planned_finish AS "plannedFinish",
              -- IN-14: an approved quality plan written against the order's released baseline.
              EXISTS (SELECT 1 FROM quality.quality_plan qp JOIN dms.baseline qb ON qb.id = qp.baseline_id
                       WHERE qp.work_package_id = w.id AND qp.status = 'approved' AND qb.status = 'released') AS "qualityPlanPresent",
              w.planning_note AS "planningNote", w.release_snapshot AS "releaseSnapshot", w.released_at AS "releasedAt",
              w.completed_at AS "completedAt", w.aggregate_version AS "aggregateVersion"
         FROM orders.work_package w
         JOIN orders.sales_order so ON so.id = w.sales_order_id
         JOIN orders.purchase_order p ON p.id = w.purchase_order_id
         JOIN iam.organization o ON o.id = w.supplier_organization_id
        WHERE w.id = $1 ${forUpdate ? 'FOR UPDATE OF w' : ''}`,
      [id],
    );
    const head = res.rows[0] as Omit<WorkPackageRecord, 'milestones'> | undefined;
    if (!head) return null;
    return { ...head, milestones: await this.listMilestones(id, tx) };
  }

  async listWorkPackagesForOrder(salesOrderId: string, tx?: Queryable): Promise<WorkPackageRecord[]> {
    const res = await this.q(tx).query<{ id: string }>(`SELECT id FROM orders.work_package WHERE sales_order_id = $1 ORDER BY number`, [salesOrderId]);
    const out: WorkPackageRecord[] = [];
    for (const { id } of res.rows) {
      const w = await this.findWorkPackage(id, tx);
      if (w) out.push(w);
    }
    return out;
  }

  async updatePlan(
    input: { workPackageId: string; plannedStart: string; plannedFinish: string; planningNote: string },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `UPDATE orders.work_package SET planned_start = $2, planned_finish = $3, planning_note = $4,
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1`,
      [input.workPackageId, input.plannedStart, input.plannedFinish, input.planningNote],
    );
  }

  async replaceMilestones(
    workPackageId: string,
    milestones: Array<{ title: string; customerLabel: string | null; plannedDate: string; evidencePolicy: string; minEvidence: number }>,
    tx: Queryable,
  ): Promise<void> {
    await tx.query(`DELETE FROM orders.milestone WHERE work_package_id = $1`, [workPackageId]);
    let seq = 1;
    for (const m of milestones) {
      await tx.query(
        `INSERT INTO orders.milestone (work_package_id, seq, title, customer_label, evidence_policy, min_evidence, planned_date, forecast_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
        [workPackageId, seq, m.title, m.customerLabel, m.evidencePolicy, m.evidencePolicy === 'none' ? 0 : m.minEvidence, m.plannedDate],
      );
      seq += 1;
    }
  }

  async setWorkPackageStatus(
    input: { workPackageId: string; status: WorkPackageRecord['status']; release?: { snapshot: Record<string, unknown>; by: string } | undefined; completed?: boolean | undefined },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `UPDATE orders.work_package
          SET status = $2,
              release_snapshot = COALESCE($3::jsonb, release_snapshot),
              released_by = COALESCE($4, released_by),
              released_at = CASE WHEN $3::jsonb IS NULL THEN released_at ELSE now() END,
              completed_at = CASE WHEN $5 THEN now() ELSE completed_at END,
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1`,
      [input.workPackageId, input.status, input.release ? JSON.stringify(input.release.snapshot) : null, input.release?.by ?? null, input.completed ?? false],
    );
  }

  // ----------------------------------------------------------------- milestones

  async listMilestones(workPackageId: string, tx?: Queryable): Promise<MilestoneRecord[]> {
    const res = await this.q(tx).query<{ id: string }>(`SELECT id FROM orders.milestone WHERE work_package_id = $1 ORDER BY seq`, [workPackageId]);
    const out: MilestoneRecord[] = [];
    for (const { id } of res.rows) {
      const m = await this.findMilestone(id, tx);
      if (m) out.push(m);
    }
    return out;
  }

  async findMilestone(id: string, tx?: Queryable, forUpdate = false): Promise<MilestoneRecord | null> {
    const res = await this.q(tx).query(
      `SELECT id, work_package_id AS "workPackageId", seq, title, customer_label AS "customerLabel", evidence_policy AS "evidencePolicy",
              min_evidence AS "minEvidence", verifier_role AS "verifierRole", status, planned_date AS "plannedDate", forecast_date AS "forecastDate",
              actual_date AS "actualDate", started_at AS "startedAt", submitted_at AS "submittedAt", decided_at AS "decidedAt", decided_by AS "decidedBy",
              decision_reason AS "decisionReason", backdate_reason AS "backdateReason", aggregate_version AS "aggregateVersion"
         FROM orders.milestone WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    const head = res.rows[0] as Omit<MilestoneRecord, 'forecasts' | 'evidence'> | undefined;
    if (!head) return null;
    const [forecasts, evidence] = await parallelReads(tx, [
      () => this.q(tx).query(
        `SELECT revision_no AS "revisionNo", forecast_date AS "forecastDate", reason_code AS "reasonCode", reason, recorded_at AS "recordedAt"
           FROM orders.milestone_forecast WHERE milestone_id = $1 ORDER BY revision_no`,
        [id],
      ),
      () => this.q(tx).query(
        `SELECT e.id, e.milestone_id AS "milestoneId", dv.document_id AS "documentId", e.document_version_id AS "documentVersionId",
                dv.original_filename AS filename, e.file_sha256 AS "fileSha256", f.scan_state AS "scanState", e.observed_at AS "observedAt",
                e.submitted_at AS "submittedAt", e.submitted_by AS "submittedBy", e.flagged, e.flag_reason AS "flagReason", e.note
           FROM orders.milestone_evidence e
           JOIN dms.document_version dv ON dv.id = e.document_version_id
           JOIN dms.file_object f ON f.id = dv.file_object_id
          WHERE e.milestone_id = $1 ORDER BY e.submitted_at`,
        [id],
      ),
    ]);
    return { ...head, forecasts: forecasts.rows as ForecastRecord[], evidence: evidence.rows as EvidenceRecord[] };
  }

  async setMilestone(
    input: {
      milestoneId: string;
      status: MilestoneStatus;
      started?: string | undefined;
      submitted?: string | undefined;
      decided?: { by: string; reason: string | null; actualDate: string | null; backdateReason: string | null } | undefined;
    },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `UPDATE orders.milestone
          SET status = $2,
              started_by = COALESCE($3, started_by), started_at = CASE WHEN $3::uuid IS NULL THEN started_at ELSE now() END,
              submitted_by = COALESCE($4, submitted_by), submitted_at = CASE WHEN $4::uuid IS NULL THEN submitted_at ELSE now() END,
              decided_by = COALESCE($5, decided_by), decided_at = CASE WHEN $5::uuid IS NULL THEN decided_at ELSE now() END,
              decision_reason = CASE WHEN $5::uuid IS NULL THEN decision_reason ELSE $6 END,
              actual_date = COALESCE($7::date, actual_date),
              backdate_reason = COALESCE($8, backdate_reason),
              aggregate_version = aggregate_version + 1
        WHERE id = $1`,
      [
        input.milestoneId,
        input.status,
        input.started ?? null,
        input.submitted ?? null,
        input.decided?.by ?? null,
        input.decided?.reason ?? null,
        input.decided?.actualDate ?? null,
        input.decided?.backdateReason ?? null,
      ],
    );
  }

  async makeReady(workPackageId: string, seq: number, tx: Queryable): Promise<void> {
    await tx.query(`UPDATE orders.milestone SET status = 'ready', aggregate_version = aggregate_version + 1 WHERE work_package_id = $1 AND seq = $2 AND status = 'not_ready'`, [workPackageId, seq]);
  }

  async appendForecast(input: { milestoneId: string; forecastDate: string; reasonCode: string; reason: string; by: string }, tx: Queryable): Promise<number> {
    const next = await tx.query<{ n: number }>(`SELECT COALESCE(MAX(revision_no), 0) + 1 AS n FROM orders.milestone_forecast WHERE milestone_id = $1`, [input.milestoneId]);
    const revision = next.rows[0]!.n;
    await tx.query(
      `INSERT INTO orders.milestone_forecast (milestone_id, revision_no, forecast_date, reason_code, reason, recorded_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.milestoneId, revision, input.forecastDate, input.reasonCode, input.reason, input.by],
    );
    await tx.query(`UPDATE orders.milestone SET forecast_date = $2, aggregate_version = aggregate_version + 1 WHERE id = $1`, [input.milestoneId, input.forecastDate]);
    return revision;
  }

  /** A version the supplier organization itself uploaded, with its bytes' hash. */
  async supplierVersion(documentVersionId: string, organizationId: string, tx: Queryable): Promise<{ sha256: string; status: string; scanState: string; logicalType: string } | null> {
    const res = await tx.query<{ sha256: string; status: string; scanState: string; logicalType: string }>(
      `SELECT f.sha256, dv.status, f.scan_state AS "scanState", d.logical_type AS "logicalType"
         FROM dms.document_version dv
         JOIN dms.document d ON d.id = dv.document_id
         JOIN dms.file_object f ON f.id = dv.file_object_id
        WHERE dv.id = $1 AND d.owning_organization_id = $2`,
      [documentVersionId, organizationId],
    );
    return res.rows[0] ?? null;
  }

  /** doc 09 §15: the same bytes already offered as evidence somewhere else. */
  async evidenceReuse(fileSha256: string, milestoneId: string, tx: Queryable): Promise<string | null> {
    const res = await tx.query<{ title: string; number: string }>(
      `SELECT m.title, w.number FROM orders.milestone_evidence e
         JOIN orders.milestone m ON m.id = e.milestone_id
         JOIN orders.work_package w ON w.id = m.work_package_id
        WHERE e.file_sha256 = $1 AND e.milestone_id <> $2 LIMIT 1`,
      [fileSha256, milestoneId],
    );
    return res.rows[0] ? `The same file was already submitted for "${res.rows[0].title}" on ${res.rows[0].number}.` : null;
  }

  async addEvidence(
    input: { milestoneId: string; documentVersionId: string; fileSha256: string; baselineId: string | null; note: string; observedAt: Date; submittedBy: string; flagReason: string | null },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO orders.milestone_evidence (milestone_id, document_version_id, file_sha256, baseline_id, note, observed_at, submitted_by, flagged, flag_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [input.milestoneId, input.documentVersionId, input.fileSha256, input.baselineId, input.note, input.observedAt, input.submittedBy, input.flagReason !== null, input.flagReason],
    );
    return res.rows[0]!.id;
  }

  async verificationQueue(): Promise<Array<Record<string, unknown>>> {
    const res = await this.db.pool.query(
      `SELECT m.id AS "milestoneId", m.title, m.seq, w.id AS "workPackageId", w.number AS "workPackageNumber", so.id AS "salesOrderId",
              so.number AS "salesOrderNumber", o.display_name AS "supplierDisplayName", m.submitted_at AS "submittedAt",
              (SELECT count(*)::int FROM orders.milestone_evidence e WHERE e.milestone_id = m.id) AS "evidenceCount",
              EXISTS (SELECT 1 FROM orders.milestone_evidence e WHERE e.milestone_id = m.id AND e.flagged) AS flagged,
              m.aggregate_version AS "aggregateVersion"
         FROM orders.milestone m
         JOIN orders.work_package w ON w.id = m.work_package_id
         JOIN orders.sales_order so ON so.id = w.sales_order_id
         JOIN iam.organization o ON o.id = w.supplier_organization_id
        WHERE m.status = 'evidence_submitted'
        ORDER BY m.submitted_at`,
    );
    return res.rows as Array<Record<string, unknown>>;
  }

  // ----------------------------------------------------------------- containment

  async recordContainment(input: { purchaseOrderId: string; workPackageId: string | null; kind: ContainmentRecord['kind']; description: string; reportedBy: string | null }, tx: Queryable): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO orders.containment_event (purchase_order_id, work_package_id, kind, description, reported_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [input.purchaseOrderId, input.workPackageId, input.kind, input.description, input.reportedBy],
    );
    return res.rows[0]!.id;
  }

  async listContainment(purchaseOrderId: string, tx?: Queryable): Promise<ContainmentRecord[]> {
    const res = await this.q(tx).query(
      `SELECT id, purchase_order_id AS "purchaseOrderId", work_package_id AS "workPackageId", kind, description, reported_at AS "reportedAt",
              disposition, disposed_at AS "disposedAt"
         FROM orders.containment_event WHERE purchase_order_id = $1 ORDER BY reported_at DESC`,
      [purchaseOrderId],
    );
    return res.rows as ContainmentRecord[];
  }

  // ----------------------------------------------------------------- gate inputs

  async supplierStanding(supplierOrganizationId: string, tx?: Queryable): Promise<{ profileStatus: string | null; acceptingWork: boolean | null }> {
    const res = await this.q(tx).query<{ status: string; accepting_work: boolean }>(
      `SELECT status, accepting_work FROM supplier.supplier_profile WHERE organization_id = $1`,
      [supplierOrganizationId],
    );
    const row = res.rows[0];
    return { profileStatus: row?.status ?? null, acceptingWork: row?.accepting_work ?? null };
  }

  /** Verified, customer-visible checkpoints and whether any forecast slipped — the customer's whole view of production. */
  async customerProgress(salesOrderId: string): Promise<{ progress: Array<{ label: string; at: string }>; slipped: boolean; baselineReleasedAt: Date | null }> {
    const [rows, slip, baseline] = await Promise.all([
      this.db.pool.query<{ label: string; at: Date }>(
        `SELECT m.customer_label AS label, m.decided_at AS at
           FROM orders.milestone m JOIN orders.work_package w ON w.id = m.work_package_id
          WHERE w.sales_order_id = $1 AND m.status = 'verified' AND m.customer_label IS NOT NULL
          ORDER BY m.decided_at`,
        [salesOrderId],
      ),
      this.db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM orders.milestone m JOIN orders.work_package w ON w.id = m.work_package_id
          WHERE w.sales_order_id = $1 AND m.status NOT IN ('verified', 'waived') AND m.forecast_date > m.planned_date`,
        [salesOrderId],
      ),
      this.db.pool.query<{ released_at: Date }>(`SELECT released_at FROM dms.baseline WHERE sales_order_id = $1 AND status = 'released' LIMIT 1`, [salesOrderId]),
    ]);
    return {
      progress: rows.rows.map((r) => ({ label: r.label, at: r.at.toISOString() })),
      slipped: Number(slip.rows[0]?.n ?? 0) > 0,
      baselineReleasedAt: baseline.rows[0]?.released_at ?? null,
    };
  }

  /**
   * Production is done only when every live purchase order has a completed work package —
   * a supplier whose work was never planned is unfinished work, not absent work.
   */
  async allWorkPackagesComplete(salesOrderId: string, tx: Queryable): Promise<boolean> {
    const res = await tx.query<{ pending: number; total: number }>(
      `SELECT count(*) FILTER (WHERE w.id IS NULL OR w.status <> 'completed')::int AS pending, count(*)::int AS total
         FROM orders.purchase_order p
         LEFT JOIN orders.work_package w ON w.purchase_order_id = p.id
        WHERE p.sales_order_id = $1 AND p.status <> 'cancelled'`,
      [salesOrderId],
    );
    return res.rows[0]!.total > 0 && res.rows[0]!.pending === 0;
  }
}
