import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DatabaseService } from '../../../platform/database/database.service';
import type { NcrStatus } from '../domain/ncr';

type Queryable = Pool | PoolClient;

export interface NcrRow {
  id: string;
  number: string;
  workPackageId: string;
  inspectionId: string;
  inspectionNumber: string;
  stage: string;
  baselineId: string;
  parentNcrId: string | null;
  title: string;
  description: string;
  severity: 'critical' | 'major' | 'minor';
  detectionStage: string;
  affectedQuantity: string;
  lots: string[];
  serials: string[];
  suspectedCause: string;
  ownerId: string;
  dueAt: Date;
  costResponsibility: 'supplier' | 'jobwork' | 'customer' | 'undetermined';
  correctiveActionRequired: boolean;
  status: NcrStatus;
  attemptNo: number;
  dispositionDecidedBy: string | null;
  openedAt: Date;
  closedAt: Date | null;
  closureNote: string | null;
  aggregateVersion: number;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  supplierOrganizationId: string;
  supplierDisplayName: string;
  salesOrderId: string;
}

export interface DispositionRow {
  id: string;
  attemptNo: number;
  disposition: 'rework' | 'remake' | 'sort' | 'use_as_is' | 'return' | 'scrap';
  plan: string;
  decidedBy: string;
  decidedAt: Date;
  reworkNote: string | null;
  reworkRecordedAt: Date | null;
  reinspectionId: string | null;
  reinspectionNumber: string | null;
  reinspectionStatus: string | null;
  reinspectionPlannedAt: Date | null;
  outcome: 'pending' | 'verified' | 'still_nonconforming' | 'deviation_approved' | 'deviation_rejected' | 'rejected';
}

export interface CorrectiveActionRow {
  id: string;
  status: 'requested' | 'responded' | 'accepted' | 'verified';
  dueAt: Date;
  problemDefinition: string | null;
  occurrenceCause: string | null;
  escapeCause: string | null;
  actions: Array<{ action: string; owner: string; dueDate: string }>;
  respondedAt: Date | null;
  reviewNote: string | null;
  acceptedBy: string | null;
  acceptedAt: Date | null;
  effectivenessEvidence: string | null;
  verifiedAt: Date | null;
  aggregateVersion: number;
}

export interface DeviationRow {
  id: string;
  number: string;
  ncrId: string;
  ncrNumber: string;
  ncrStatus: string;
  ncrSeverity: 'critical' | 'major' | 'minor';
  status: 'pending_internal' | 'pending_customer' | 'approved' | 'rejected' | 'withdrawn';
  characteristicIds: string[];
  quantity: string;
  lots: string[];
  serials: string[];
  expiresAt: Date;
  rationale: string;
  riskAssessment: string;
  fitFunctionSafety: string;
  priceEffect: string;
  warrantyEffect: string;
  traceabilityEffect: string;
  labelingEffect: string;
  customerApprovalRequired: boolean;
  approvalRequestId: string | null;
  /** The internal decision on the rail; the customer sees a deviation only once it is approved. */
  approvalStatus: string | null;
  requestedBy: string;
  requestedAt: Date;
  decidedAt: Date | null;
  decisionReason: string | null;
  aggregateVersion: number;
  workPackageId: string;
  salesOrderId: string;
  salesOrderNumber: string;
  customerOrganizationId: string;
  supplierOrganizationId: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
}

const DEVIATION_COLUMNS = `d.id, d.number, d.ncr_id AS "ncrId", n.number AS "ncrNumber", n.status AS "ncrStatus", n.severity AS "ncrSeverity", d.status,
  d.characteristic_ids AS "characteristicIds", d.quantity::text AS quantity, d.lots, d.serials, d.expires_at AS "expiresAt", d.rationale,
  d.risk_assessment AS "riskAssessment", d.fit_function_safety AS "fitFunctionSafety", d.price_effect AS "priceEffect", d.warranty_effect AS "warrantyEffect",
  d.traceability_effect AS "traceabilityEffect", d.labeling_effect AS "labelingEffect", d.customer_approval_required AS "customerApprovalRequired",
  d.approval_request_id AS "approvalRequestId", ar.status AS "approvalStatus", d.requested_by AS "requestedBy", d.requested_at AS "requestedAt", d.decided_at AS "decidedAt",
  d.decision_reason AS "decisionReason", d.aggregate_version AS "aggregateVersion", n.work_package_id AS "workPackageId", w.sales_order_id AS "salesOrderId",
  so.number AS "salesOrderNumber", so.customer_organization_id AS "customerOrganizationId", w.supplier_organization_id AS "supplierOrganizationId",
  w.purchase_order_id AS "purchaseOrderId", po.number AS "purchaseOrderNumber"`;
const DEVIATION_FROM = `FROM quality.deviation d
  JOIN quality.ncr n ON n.id = d.ncr_id
  JOIN orders.work_package w ON w.id = n.work_package_id
  JOIN orders.sales_order so ON so.id = w.sales_order_id
  JOIN orders.purchase_order po ON po.id = w.purchase_order_id
  LEFT JOIN commercial.approval_request ar ON ar.id = d.approval_request_id`;

const NCR_COLUMNS = `n.id, n.number, n.work_package_id AS "workPackageId", n.inspection_id AS "inspectionId", i.number AS "inspectionNumber", i.stage,
  n.baseline_id AS "baselineId", n.parent_ncr_id AS "parentNcrId", n.title, n.description, n.severity, n.detection_stage AS "detectionStage",
  n.affected_quantity::text AS "affectedQuantity", n.lots, n.serials, n.suspected_cause AS "suspectedCause", n.owner_id AS "ownerId", n.due_at AS "dueAt",
  n.cost_responsibility AS "costResponsibility", n.corrective_action_required AS "correctiveActionRequired", n.status, n.attempt_no AS "attemptNo",
  n.disposition_decided_by AS "dispositionDecidedBy", n.opened_at AS "openedAt", n.closed_at AS "closedAt", n.closure_note AS "closureNote",
  n.aggregate_version AS "aggregateVersion", w.purchase_order_id AS "purchaseOrderId", po.number AS "purchaseOrderNumber",
  w.supplier_organization_id AS "supplierOrganizationId", o.display_name AS "supplierDisplayName", w.sales_order_id AS "salesOrderId"`;
const NCR_FROM = `FROM quality.ncr n
  JOIN quality.inspection i ON i.id = n.inspection_id
  JOIN orders.work_package w ON w.id = n.work_package_id
  JOIN orders.purchase_order po ON po.id = w.purchase_order_id
  JOIN iam.organization o ON o.id = w.supplier_organization_id`;

/** The NCR side of the quality module's SQL (IN-15 F-15.2). */
@Injectable()
export class NcrRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  async allocateNumber(prefix: 'NCR' | 'DV' | 'QR', table: 'ncr' | 'deviation' | 'quality_release', now: Date, tx: Queryable): Promise<string> {
    const year = now.getUTCFullYear();
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`quality.${table}.number`]);
    const res = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(NULLIF(split_part(number, '-', 3), '')::int), 0) + 1 AS next FROM quality.${table} WHERE number LIKE $1`,
      [`${prefix}-${year}-%`],
    );
    return `${prefix}-${year}-${String(res.rows[0]!.next).padStart(4, '0')}`;
  }

  async insert(
    input: {
      number: string;
      workPackageId: string;
      inspectionId: string;
      baselineId: string;
      parentNcrId: string | null;
      title: string;
      description: string;
      severity: string;
      detectionStage: string;
      affectedQuantity: string;
      lots: string[];
      serials: string[];
      suspectedCause: string;
      ownerId: string;
      dueAt: Date;
      costResponsibility: string;
      correctiveActionRequired: boolean;
      by: string;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO quality.ncr (number, work_package_id, inspection_id, baseline_id, parent_ncr_id, title, description, severity, detection_stage, affected_quantity,
              lots, serials, suspected_cause, owner_id, due_at, cost_responsibility, corrective_action_required, opened_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
      [
        input.number,
        input.workPackageId,
        input.inspectionId,
        input.baselineId,
        input.parentNcrId,
        input.title,
        input.description,
        input.severity,
        input.detectionStage,
        input.affectedQuantity,
        input.lots,
        input.serials,
        input.suspectedCause,
        input.ownerId,
        input.dueAt,
        input.costResponsibility,
        input.correctiveActionRequired,
        input.by,
      ],
    );
    return res.rows[0]!.id;
  }

  async find(id: string, tx?: Queryable, forUpdate = false): Promise<NcrRow | null> {
    const res = await this.q(tx).query<NcrRow>(`SELECT ${NCR_COLUMNS} ${NCR_FROM} WHERE n.id = $1 ${forUpdate ? 'FOR UPDATE OF n' : ''}`, [id]);
    return res.rows[0] ?? null;
  }

  async list(filter: { supplierOrganizationId?: string; workPackageId?: string; open?: boolean }, tx?: Queryable): Promise<NcrRow[]> {
    const res = await this.q(tx).query<NcrRow>(
      `SELECT ${NCR_COLUMNS} ${NCR_FROM}
        WHERE ($1::uuid IS NULL OR w.supplier_organization_id = $1)
          AND ($2::uuid IS NULL OR n.work_package_id = $2)
          AND (NOT $3 OR n.status <> 'closed')
        ORDER BY n.opened_at DESC LIMIT 200`,
      [filter.supplierOrganizationId ?? null, filter.workPackageId ?? null, filter.open ?? false],
    );
    return res.rows;
  }

  async children(ncrId: string, tx?: Queryable): Promise<Array<{ id: string; number: string; status: NcrStatus }>> {
    const res = await this.q(tx).query<{ id: string; number: string; status: NcrStatus }>(`SELECT id, number, status FROM quality.ncr WHERE parent_ncr_id = $1 ORDER BY opened_at`, [ncrId]);
    return res.rows;
  }

  async update(
    id: string,
    fields: Partial<{ status: NcrStatus; attemptNo: number; dispositionDecidedBy: string; costResponsibility: string; suspectedCause: string; closedBy: string; closedAt: Date; closureNote: string }>,
    tx: Queryable,
  ): Promise<number> {
    const res = await tx.query<{ aggregate_version: number }>(
      `UPDATE quality.ncr
          SET status = COALESCE($2, status), attempt_no = COALESCE($3, attempt_no), disposition_decided_by = COALESCE($4, disposition_decided_by),
              cost_responsibility = COALESCE($5, cost_responsibility), suspected_cause = COALESCE($6, suspected_cause),
              closed_by = COALESCE($7, closed_by), closed_at = COALESCE($8, closed_at), closure_note = COALESCE($9, closure_note),
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1 RETURNING aggregate_version`,
      [
        id,
        fields.status ?? null,
        fields.attemptNo ?? null,
        fields.dispositionDecidedBy ?? null,
        fields.costResponsibility ?? null,
        fields.suspectedCause ?? null,
        fields.closedBy ?? null,
        fields.closedAt ?? null,
        fields.closureNote ?? null,
      ],
    );
    return res.rows[0]!.aggregate_version;
  }

  // ----------------------------------------------------------------- defects and containment

  async insertDefect(input: { ncrId: string; resultId: string; characteristicId: string }, tx: Queryable): Promise<void> {
    await tx.query(`INSERT INTO quality.ncr_defect (ncr_id, result_id, characteristic_id) VALUES ($1, $2, $3)`, [input.ncrId, input.resultId, input.characteristicId]);
  }

  async defects(ncrId: string, tx?: Queryable): Promise<Array<{ resultId: string; characteristicId: string; characteristicName: string; sampleNo: number; originalValue: string; originalUnit: string | null; normalizedValue: string | null; normalizedUnit: string | null; outcome: string; outcomeReason: string }>> {
    const res = await this.q(tx).query(
      `SELECT d.result_id AS "resultId", d.characteristic_id AS "characteristicId", c.name AS "characteristicName", s.sample_no AS "sampleNo",
              r.original_value AS "originalValue", r.original_unit AS "originalUnit", r.normalized_value::text AS "normalizedValue",
              r.normalized_unit AS "normalizedUnit", r.outcome, r.outcome_reason AS "outcomeReason"
         FROM quality.ncr_defect d
         JOIN quality.inspection_result r ON r.id = d.result_id
         JOIN quality.inspection_sample s ON s.id = r.sample_id
         JOIN quality.characteristic c ON c.id = d.characteristic_id
        WHERE d.ncr_id = $1 ORDER BY c.seq, s.sample_no`,
      [ncrId],
    );
    return res.rows;
  }

  async insertContainment(input: { ncrId: string; action: string; location: string; quantity: string | null; by: string; organizationId: string }, tx: Queryable): Promise<void> {
    await tx.query(
      `INSERT INTO quality.ncr_containment (ncr_id, action, location, quantity, recorded_by, recorded_by_organization_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.ncrId, input.action, input.location, input.quantity, input.by, input.organizationId],
    );
  }

  async containment(ncrId: string, tx?: Queryable): Promise<Array<{ action: string; location: string; quantity: string | null; recordedAt: Date; organizationType: string }>> {
    const res = await this.q(tx).query(
      `SELECT c.action, c.location, c.quantity::text AS quantity, c.recorded_at AS "recordedAt", o.type AS "organizationType"
         FROM quality.ncr_containment c JOIN iam.organization o ON o.id = c.recorded_by_organization_id
        WHERE c.ncr_id = $1 ORDER BY c.recorded_at`,
      [ncrId],
    );
    return res.rows;
  }

  // ----------------------------------------------------------------- dispositions

  async insertDisposition(input: { ncrId: string; attemptNo: number; disposition: DispositionRow['disposition']; plan: string; by: string; outcome?: DispositionRow['outcome'] }, tx: Queryable): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO quality.ncr_disposition (ncr_id, attempt_no, disposition, plan, decided_by, outcome) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.ncrId, input.attemptNo, input.disposition, input.plan, input.by, input.outcome ?? 'pending'],
    );
    return res.rows[0]!.id;
  }

  async dispositions(ncrId: string, tx?: Queryable): Promise<DispositionRow[]> {
    const res = await this.q(tx).query<DispositionRow>(
      `SELECT d.id, d.attempt_no AS "attemptNo", d.disposition, d.plan, d.decided_by AS "decidedBy", d.decided_at AS "decidedAt", d.rework_note AS "reworkNote",
              d.rework_recorded_at AS "reworkRecordedAt", d.reinspection_id AS "reinspectionId", i.number AS "reinspectionNumber", i.status AS "reinspectionStatus",
              i.planned_at AS "reinspectionPlannedAt", d.outcome
         FROM quality.ncr_disposition d LEFT JOIN quality.inspection i ON i.id = d.reinspection_id
        WHERE d.ncr_id = $1 ORDER BY d.attempt_no`,
      [ncrId],
    );
    return res.rows;
  }

  async recordRework(dispositionId: string, input: { note: string; by: string }, tx: Queryable): Promise<void> {
    await tx.query(`UPDATE quality.ncr_disposition SET rework_note = $2, rework_recorded_by = $3, rework_recorded_at = now() WHERE id = $1`, [dispositionId, input.note, input.by]);
  }

  async linkReinspection(dispositionId: string, inspectionId: string, tx: Queryable): Promise<void> {
    await tx.query(`UPDATE quality.ncr_disposition SET reinspection_id = $2 WHERE id = $1`, [dispositionId, inspectionId]);
  }

  async setOutcome(dispositionId: string, outcome: DispositionRow['outcome'], tx: Queryable): Promise<void> {
    await tx.query(`UPDATE quality.ncr_disposition SET outcome = $2 WHERE id = $1`, [dispositionId, outcome]);
  }

  /** The pending disposition whose reinspection this is, with its NCR locked. */
  async dispositionForReinspection(inspectionId: string, tx: Queryable): Promise<{ dispositionId: string; ncrId: string } | null> {
    const res = await tx.query<{ dispositionId: string; ncrId: string }>(
      `SELECT d.id AS "dispositionId", d.ncr_id AS "ncrId" FROM quality.ncr_disposition d WHERE d.reinspection_id = $1 AND d.outcome = 'pending'`,
      [inspectionId],
    );
    return res.rows[0] ?? null;
  }

  /** The inspections a reinspection follows, nearest first: its `reinspection_of` chain. */
  async reinspectionChain(inspectionId: string, tx?: Queryable): Promise<string[]> {
    const res = await this.q(tx).query<{ id: string }>(
      `WITH RECURSIVE chain AS (
         SELECT reinspection_of AS id, 1 AS depth FROM quality.inspection WHERE id = $1
         UNION ALL
         SELECT i.reinspection_of, c.depth + 1 FROM quality.inspection i JOIN chain c ON i.id = c.id WHERE c.id IS NOT NULL AND c.depth < 50
       )
       SELECT id FROM chain WHERE id IS NOT NULL ORDER BY depth`,
      [inspectionId],
    );
    return res.rows.map((r) => r.id);
  }

  // ----------------------------------------------------------------- corrective action

  async insertCorrectiveAction(input: { ncrId: string; dueAt: Date; by: string }, tx: Queryable): Promise<void> {
    await tx.query(`INSERT INTO quality.corrective_action (ncr_id, due_at, requested_by) VALUES ($1, $2, $3)`, [input.ncrId, input.dueAt, input.by]);
  }

  async correctiveAction(ncrId: string, tx?: Queryable, forUpdate = false): Promise<CorrectiveActionRow | null> {
    const res = await this.q(tx).query<CorrectiveActionRow>(
      `SELECT id, status, due_at AS "dueAt", problem_definition AS "problemDefinition", occurrence_cause AS "occurrenceCause", escape_cause AS "escapeCause",
              actions, responded_at AS "respondedAt", review_note AS "reviewNote", accepted_by AS "acceptedBy", accepted_at AS "acceptedAt",
              effectiveness_evidence AS "effectivenessEvidence", verified_at AS "verifiedAt", aggregate_version AS "aggregateVersion"
         FROM quality.corrective_action WHERE ncr_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [ncrId],
    );
    return res.rows[0] ?? null;
  }

  async updateCorrectiveAction(
    id: string,
    fields: Partial<{
      status: CorrectiveActionRow['status'];
      problemDefinition: string;
      occurrenceCause: string;
      escapeCause: string;
      actions: CorrectiveActionRow['actions'];
      respondedBy: string;
      reviewNote: string;
      acceptedBy: string;
      effectivenessEvidence: string;
      verifiedBy: string;
    }>,
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `UPDATE quality.corrective_action
          SET status = COALESCE($2, status), problem_definition = COALESCE($3, problem_definition), occurrence_cause = COALESCE($4, occurrence_cause),
              escape_cause = COALESCE($5, escape_cause), actions = COALESCE($6::jsonb, actions),
              responded_by = COALESCE($7, responded_by), responded_at = CASE WHEN $7::uuid IS NULL THEN responded_at ELSE now() END,
              review_note = COALESCE($8, review_note),
              accepted_by = COALESCE($9, accepted_by), accepted_at = CASE WHEN $9::uuid IS NULL THEN accepted_at ELSE now() END,
              effectiveness_evidence = COALESCE($10, effectiveness_evidence),
              verified_by = COALESCE($11, verified_by), verified_at = CASE WHEN $11::uuid IS NULL THEN verified_at ELSE now() END,
              aggregate_version = aggregate_version + 1
        WHERE id = $1`,
      [
        id,
        fields.status ?? null,
        fields.problemDefinition ?? null,
        fields.occurrenceCause ?? null,
        fields.escapeCause ?? null,
        fields.actions ? JSON.stringify(fields.actions) : null,
        fields.respondedBy ?? null,
        fields.reviewNote ?? null,
        fields.acceptedBy ?? null,
        fields.effectivenessEvidence ?? null,
        fields.verifiedBy ?? null,
      ],
    );
  }

  // ----------------------------------------------------------------- deviations (doc 09 §12)

  async insertDeviation(
    input: {
      number: string;
      ncrId: string;
      characteristicIds: string[];
      quantity: string;
      lots: string[];
      serials: string[];
      expiresAt: Date;
      rationale: string;
      riskAssessment: string;
      fitFunctionSafety: string;
      priceEffect: string;
      warrantyEffect: string;
      traceabilityEffect: string;
      labelingEffect: string;
      customerApprovalRequired: boolean;
      by: string;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO quality.deviation (number, ncr_id, characteristic_ids, quantity, lots, serials, expires_at, rationale, risk_assessment, fit_function_safety,
              price_effect, warranty_effect, traceability_effect, labeling_effect, customer_approval_required, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [
        input.number,
        input.ncrId,
        input.characteristicIds,
        input.quantity,
        input.lots,
        input.serials,
        input.expiresAt,
        input.rationale,
        input.riskAssessment,
        input.fitFunctionSafety,
        input.priceEffect,
        input.warrantyEffect,
        input.traceabilityEffect,
        input.labelingEffect,
        input.customerApprovalRequired,
        input.by,
      ],
    );
    return res.rows[0]!.id;
  }

  async findDeviation(id: string, tx?: Queryable, forUpdate = false): Promise<DeviationRow | null> {
    const res = await this.q(tx).query<DeviationRow>(`SELECT ${DEVIATION_COLUMNS} ${DEVIATION_FROM} WHERE d.id = $1 ${forUpdate ? 'FOR UPDATE OF d' : ''}`, [id]);
    return res.rows[0] ?? null;
  }

  async deviations(filter: { ncrId?: string; salesOrderId?: string; workPackageId?: string }, tx?: Queryable): Promise<DeviationRow[]> {
    const res = await this.q(tx).query<DeviationRow>(
      `SELECT ${DEVIATION_COLUMNS} ${DEVIATION_FROM}
        WHERE ($1::uuid IS NULL OR d.ncr_id = $1) AND ($2::uuid IS NULL OR w.sales_order_id = $2) AND ($3::uuid IS NULL OR n.work_package_id = $3)
        ORDER BY d.requested_at`,
      [filter.ncrId ?? null, filter.salesOrderId ?? null, filter.workPackageId ?? null],
    );
    return res.rows;
  }

  async updateDeviation(id: string, fields: Partial<{ status: DeviationRow['status']; approvalRequestId: string; decidedAt: Date; decisionReason: string }>, tx: Queryable): Promise<number> {
    const res = await tx.query<{ aggregate_version: number }>(
      `UPDATE quality.deviation
          SET status = COALESCE($2, status), approval_request_id = COALESCE($3, approval_request_id), decided_at = COALESCE($4, decided_at),
              decision_reason = COALESCE($5, decision_reason), aggregate_version = aggregate_version + 1
        WHERE id = $1 RETURNING aggregate_version`,
      [id, fields.status ?? null, fields.approvalRequestId ?? null, fields.decidedAt ?? null, fields.decisionReason ?? null],
    );
    return res.rows[0]!.aggregate_version;
  }

  async deviationCustomerDecision(deviationId: string, tx?: Queryable): Promise<{ decision: 'approved' | 'rejected'; reason: string; decidedAt: Date } | null> {
    const res = await this.q(tx).query<{ decision: 'approved' | 'rejected'; reason: string; decidedAt: Date }>(
      `SELECT decision, reason, decided_at AS "decidedAt" FROM quality.deviation_customer_decision WHERE deviation_id = $1`,
      [deviationId],
    );
    return res.rows[0] ?? null;
  }

  async insertDeviationCustomerDecision(input: { deviationId: string; decision: 'approved' | 'rejected'; reason: string; decidedBy: string; membershipId: string; authoritySnapshot: Record<string, unknown> }, tx: Queryable): Promise<void> {
    await tx.query(
      `INSERT INTO quality.deviation_customer_decision (deviation_id, decision, reason, decided_by, membership_id, authority_snapshot) VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.deviationId, input.decision, input.reason, input.decidedBy, input.membershipId, JSON.stringify(input.authoritySnapshot)],
    );
  }

  /** Failed results of `inspectionId` accepted for use under an approved deviation (they stay failed). */
  async deviationCoverage(inspectionId: string, tx?: Queryable): Promise<Array<{ resultId: string; number: string; expiresAt: Date }>> {
    const res = await this.q(tx).query<{ resultId: string; number: string; expiresAt: Date }>(
      `SELECT DISTINCT ON (nd.result_id) nd.result_id AS "resultId", dv.number, dv.expires_at AS "expiresAt"
         FROM quality.ncr_defect nd
         JOIN quality.inspection_result r ON r.id = nd.result_id
         JOIN quality.deviation dv ON dv.ncr_id = nd.ncr_id AND nd.characteristic_id = ANY(dv.characteristic_ids) AND dv.status = 'approved'
        WHERE r.inspection_id = $1
        ORDER BY nd.result_id, dv.expires_at DESC`,
      [inspectionId],
    );
    return res.rows;
  }
}
