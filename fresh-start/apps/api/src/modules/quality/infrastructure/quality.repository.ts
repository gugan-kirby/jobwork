import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { CharacteristicInput, InspectionStage, InspectionStatus, PlanStage } from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';
import type { ConversionTable, Dimension } from '../domain/measurement';
import { Rational } from '../domain/rational';

type Queryable = Pool | PoolClient;

export interface WorkPackageContext {
  id: string;
  number: string;
  status: string;
  salesOrderId: string;
  salesOrderNumber: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  supplierOrganizationId: string;
  supplierDisplayName: string;
}

export interface TemplateVersionRow {
  versionId: string;
  code: string;
  label: string;
  versionNo: number;
  capabilityCodes: string[];
  stages: PlanStage[];
  characteristics: CharacteristicInput[];
  requiresDrawingCharacteristic: boolean;
}

export interface PlanRow {
  id: string;
  workPackageId: string;
  versionNo: number;
  status: 'draft' | 'approved' | 'superseded';
  templateVersionId: string;
  templateCode: string;
  templateLabel: string;
  templateVersionNo: number;
  requiresDrawingCharacteristic: boolean;
  baselineId: string;
  baselineNumber: string;
  baselineStatus: string;
  stages: PlanStage[];
  approvedAt: Date | null;
  aggregateVersion: number;
}

export interface CharacteristicRow {
  id: string;
  planId: string;
  seq: number;
  drawingReference: string;
  name: string;
  kind: 'variable' | 'attribute';
  criticality: 'critical' | 'major' | 'minor';
  mandatory: boolean;
  unit: string | null;
  nominal: string | null;
  lowerLimit: string | null;
  lowerInclusive: boolean | null;
  upperLimit: string | null;
  upperInclusive: boolean | null;
  acceptedValues: string[];
  stages: InspectionStage[];
  method: string;
  instrumentKind: string;
  reactionPlan: string;
}

export interface InstrumentRow {
  id: string;
  ownerOrganizationId: string;
  ownerDisplayName: string;
  assetTag: string;
  kind: string;
  description: string;
  unit: string | null;
  resolution: string | null;
  status: 'in_service' | 'retired';
  aggregateVersion: number;
}

export interface CalibrationRow {
  id: string;
  instrumentId: string;
  performedAt: Date;
  dueAt: Date;
  outcome: 'pass' | 'out_of_tolerance';
  certificateDocumentVersionId: string;
  certificateSha256: string;
  note: string;
}

export interface InspectionRow {
  id: string;
  number: string;
  workPackageId: string;
  planId: string;
  planVersionNo: number;
  baselineId: string;
  baselineNumber: string;
  stage: InspectionStage;
  sampleSize: number;
  lot: string;
  note: string;
  inspectingOrganizationId: string;
  milestoneId: string | null;
  reinspectionOf: string | null;
  status: InspectionStatus;
  plannedAt: Date;
  startedAt: Date | null;
  inspectedAt: Date | null;
  submittedBy: string | null;
  submittedAt: Date | null;
  reviewerId: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  invalidationReason: string | null;
  aggregateVersion: number;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  supplierOrganizationId: string;
  supplierDisplayName: string;
  salesOrderId: string;
}

export interface ResultRow {
  id: string;
  sampleId: string;
  sampleNo: number;
  characteristicId: string;
  originalValue: string;
  originalUnit: string | null;
  declaredPrecision: number | null;
  normalizedValue: string | null;
  normalizedUnit: string | null;
  outcome: 'pass' | 'fail' | 'cannot_evaluate';
  outcomeReason: string;
  ruleVersion: string;
  method: string;
  instrumentId: string | null;
  instrumentAssetTag: string | null;
  instrumentKind: string | null;
  calibrationStatus: 'valid' | 'expired' | 'uncalibrated' | 'not_required';
  supersedesResultId: string | null;
  supersededByResultId: string | null;
  correctionReason: string | null;
  recordedAt: Date;
  disposition: { decision: 'accept' | 'reinspect'; reason: string; decidedAt: string } | null;
}

const PLAN_COLUMNS = `p.id, p.work_package_id AS "workPackageId", p.version_no AS "versionNo", p.status,
  p.template_version_id AS "templateVersionId", t.code AS "templateCode", t.label AS "templateLabel", tv.version_no AS "templateVersionNo",
  tv.requires_drawing_characteristic AS "requiresDrawingCharacteristic", p.baseline_id AS "baselineId", b.number AS "baselineNumber",
  b.status AS "baselineStatus", p.stages, p.approved_at AS "approvedAt", p.aggregate_version AS "aggregateVersion"`;
const PLAN_FROM = `FROM quality.quality_plan p
  JOIN quality.plan_template_version tv ON tv.id = p.template_version_id
  JOIN quality.plan_template t ON t.id = tv.template_id
  JOIN dms.baseline b ON b.id = p.baseline_id`;

const CHARACTERISTIC_COLUMNS = `c.id, c.plan_id AS "planId", c.seq, c.drawing_reference AS "drawingReference", c.name, c.kind, c.criticality, c.mandatory,
  c.unit, c.nominal::text AS nominal, c.lower_limit::text AS "lowerLimit", c.lower_inclusive AS "lowerInclusive",
  c.upper_limit::text AS "upperLimit", c.upper_inclusive AS "upperInclusive", c.accepted_values AS "acceptedValues",
  c.stages, c.method, c.instrument_kind AS "instrumentKind", c.reaction_plan AS "reactionPlan"`;

const INSTRUMENT_COLUMNS = `i.id, i.owner_organization_id AS "ownerOrganizationId", o.display_name AS "ownerDisplayName", i.asset_tag AS "assetTag",
  i.kind, i.description, i.unit, i.resolution::text AS resolution, i.status, i.aggregate_version AS "aggregateVersion"`;

const INSPECTION_COLUMNS = `i.id, i.number, i.work_package_id AS "workPackageId", i.plan_id AS "planId", p.version_no AS "planVersionNo",
  i.baseline_id AS "baselineId", b.number AS "baselineNumber", i.stage, i.sample_size AS "sampleSize", i.lot, i.note,
  i.inspecting_organization_id AS "inspectingOrganizationId", i.milestone_id AS "milestoneId", i.reinspection_of AS "reinspectionOf",
  i.status, i.planned_at AS "plannedAt", i.started_at AS "startedAt", i.inspected_at AS "inspectedAt", i.submitted_by AS "submittedBy",
  i.submitted_at AS "submittedAt", i.reviewer_id AS "reviewerId", i.decided_at AS "decidedAt", i.decision_reason AS "decisionReason",
  i.invalidation_reason AS "invalidationReason", i.aggregate_version AS "aggregateVersion",
  w.purchase_order_id AS "purchaseOrderId", po.number AS "purchaseOrderNumber", w.supplier_organization_id AS "supplierOrganizationId",
  so.display_name AS "supplierDisplayName", w.sales_order_id AS "salesOrderId"`;
const INSPECTION_FROM = `FROM quality.inspection i
  JOIN quality.quality_plan p ON p.id = i.plan_id
  JOIN dms.baseline b ON b.id = i.baseline_id
  JOIN orders.work_package w ON w.id = i.work_package_id
  JOIN orders.purchase_order po ON po.id = w.purchase_order_id
  JOIN iam.organization so ON so.id = w.supplier_organization_id`;

/** All of the quality module's SQL (IN-14 F-14.3). */
@Injectable()
export class QualityRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  // ----------------------------------------------------------------- reference data

  /** The active unit-conversion version with every unit, ready for the engine. */
  async conversionTable(tx?: Queryable): Promise<ConversionTable> {
    const version = await this.q(tx).query<{ id: string }>(`SELECT id FROM quality.unit_conversion_version WHERE status = 'active'`);
    const units = await this.q(tx).query<{ code: string; dimension: Dimension; is_normalized: boolean }>(`SELECT code, dimension, is_normalized FROM quality.unit`);
    const conversions = await this.q(tx).query<{ from_unit: string; to_unit: string; factor_num: string; factor_den: string; offset_num: string; offset_den: string }>(
      `SELECT from_unit, to_unit, factor_num, factor_den, offset_num, offset_den FROM quality.unit_conversion WHERE version_id = $1`,
      [version.rows[0]?.id ?? null],
    );
    return {
      versionId: version.rows[0]?.id ?? '',
      units: new Map(units.rows.map((u) => [u.code, { code: u.code, dimension: u.dimension, isNormalized: u.is_normalized }])),
      toNormalized: new Map(
        conversions.rows.map((c) => [
          c.from_unit,
          { from: c.from_unit, to: c.to_unit, factor: Rational.of(BigInt(c.factor_num), BigInt(c.factor_den)), offset: Rational.of(BigInt(c.offset_num), BigInt(c.offset_den)) },
        ]),
      ),
    };
  }

  async unitCodes(tx?: Queryable): Promise<Set<string>> {
    const res = await this.q(tx).query<{ code: string }>(`SELECT code FROM quality.unit`);
    return new Set(res.rows.map((r) => r.code));
  }

  async templates(tx?: Queryable): Promise<TemplateVersionRow[]> {
    const res = await this.q(tx).query<TemplateVersionRow>(
      `SELECT DISTINCT ON (t.id) v.id AS "versionId", t.code, t.label, v.version_no AS "versionNo", t.capability_codes AS "capabilityCodes",
              v.stages, v.characteristics, v.requires_drawing_characteristic AS "requiresDrawingCharacteristic"
         FROM quality.plan_template t JOIN quality.plan_template_version v ON v.template_id = t.id AND v.status = 'active'
        ORDER BY t.id, v.version_no DESC`,
    );
    return res.rows.sort((a, b) => a.code.localeCompare(b.code));
  }

  // ----------------------------------------------------------------- work packages and baselines

  async workPackage(id: string, tx?: Queryable): Promise<WorkPackageContext | null> {
    const res = await this.q(tx).query<WorkPackageContext>(
      `SELECT w.id, w.number, w.status, w.sales_order_id AS "salesOrderId", s.number AS "salesOrderNumber", w.purchase_order_id AS "purchaseOrderId",
              po.number AS "purchaseOrderNumber", w.supplier_organization_id AS "supplierOrganizationId", o.display_name AS "supplierDisplayName"
         FROM orders.work_package w
         JOIN orders.sales_order s ON s.id = w.sales_order_id
         JOIN orders.purchase_order po ON po.id = w.purchase_order_id
         JOIN iam.organization o ON o.id = w.supplier_organization_id
        WHERE w.id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async releasedBaseline(salesOrderId: string, tx?: Queryable): Promise<{ id: string; number: string } | null> {
    const res = await this.q(tx).query<{ id: string; number: string }>(
      `SELECT id, number FROM dms.baseline WHERE sales_order_id = $1 AND kind = 'production' AND status = 'released'`,
      [salesOrderId],
    );
    return res.rows[0] ?? null;
  }

  async milestoneBelongs(milestoneId: string, workPackageId: string, tx?: Queryable): Promise<boolean> {
    const res = await this.q(tx).query(`SELECT 1 FROM orders.milestone WHERE id = $1 AND work_package_id = $2`, [milestoneId, workPackageId]);
    return (res.rowCount ?? 0) > 0;
  }

  // ----------------------------------------------------------------- plans

  async insertPlan(
    input: { workPackageId: string; versionNo: number; templateVersionId: string; baselineId: string; stages: PlanStage[]; supersedesPlanId: string | null; createdBy: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO quality.quality_plan (work_package_id, version_no, template_version_id, baseline_id, stages, supersedes_plan_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.workPackageId, input.versionNo, input.templateVersionId, input.baselineId, JSON.stringify(input.stages), input.supersedesPlanId, input.createdBy],
    );
    return res.rows[0]!.id;
  }

  async findPlan(id: string, tx?: Queryable, forUpdate = false): Promise<PlanRow | null> {
    const res = await this.q(tx).query<PlanRow>(`SELECT ${PLAN_COLUMNS} ${PLAN_FROM} WHERE p.id = $1 ${forUpdate ? 'FOR UPDATE OF p' : ''}`, [id]);
    return res.rows[0] ?? null;
  }

  async plansFor(workPackageId: string, tx?: Queryable): Promise<PlanRow[]> {
    const res = await this.q(tx).query<PlanRow>(`SELECT ${PLAN_COLUMNS} ${PLAN_FROM} WHERE p.work_package_id = $1 ORDER BY p.version_no DESC`, [workPackageId]);
    return res.rows;
  }

  async nextPlanVersion(workPackageId: string, tx: Queryable): Promise<number> {
    const res = await tx.query<{ next: number }>(`SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM quality.quality_plan WHERE work_package_id = $1`, [workPackageId]);
    return res.rows[0]!.next;
  }

  async updatePlan(id: string, fields: { status?: PlanRow['status']; stages?: PlanStage[]; baselineId?: string; approvedBy?: string; approvedAt?: Date }, tx: Queryable): Promise<number> {
    const res = await tx.query<{ aggregate_version: number }>(
      `UPDATE quality.quality_plan
          SET status = COALESCE($2, status), stages = COALESCE($3::jsonb, stages), approved_by = COALESCE($4, approved_by),
              approved_at = COALESCE($5, approved_at), baseline_id = COALESCE($6, baseline_id),
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1 RETURNING aggregate_version`,
      [id, fields.status ?? null, fields.stages ? JSON.stringify(fields.stages) : null, fields.approvedBy ?? null, fields.approvedAt ?? null, fields.baselineId ?? null],
    );
    return res.rows[0]!.aggregate_version;
  }

  async characteristics(planId: string, tx?: Queryable): Promise<CharacteristicRow[]> {
    const res = await this.q(tx).query<CharacteristicRow>(`SELECT ${CHARACTERISTIC_COLUMNS} FROM quality.characteristic c WHERE c.plan_id = $1 ORDER BY c.seq`, [planId]);
    return res.rows;
  }

  async replaceCharacteristics(planId: string, items: readonly CharacteristicInput[], tx: Queryable): Promise<void> {
    await tx.query(`DELETE FROM quality.characteristic WHERE plan_id = $1`, [planId]);
    let seq = 0;
    for (const c of items) {
      seq += 1;
      const variable = c.kind === 'variable' ? c : null;
      await tx.query(
        `INSERT INTO quality.characteristic (plan_id, seq, drawing_reference, name, kind, criticality, mandatory, unit, nominal, lower_limit, lower_inclusive,
                upper_limit, upper_inclusive, accepted_values, stages, method, instrument_kind, reaction_plan)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          planId,
          seq,
          c.drawingReference,
          c.name,
          c.kind,
          c.criticality,
          c.mandatory,
          variable?.unit ?? null,
          variable?.nominal ?? null,
          variable?.lower?.value ?? null,
          variable?.lower ? variable.lower.inclusive : null,
          variable?.upper?.value ?? null,
          variable?.upper ? variable.upper.inclusive : null,
          c.kind === 'attribute' ? c.acceptedValues : [],
          c.stages,
          c.method,
          c.instrumentKind,
          c.reactionPlan,
        ],
      );
    }
  }

  // ----------------------------------------------------------------- instruments

  async insertInstrument(
    input: { ownerOrganizationId: string; assetTag: string; kind: string; description: string; unit: string | null; resolution: string | null; rangeLow: string | null; rangeHigh: string | null; by: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO quality.instrument (owner_organization_id, asset_tag, kind, description, unit, resolution, range_low, range_high, registered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (owner_organization_id, asset_tag) DO NOTHING RETURNING id`,
      [input.ownerOrganizationId, input.assetTag, input.kind, input.description, input.unit, input.resolution, input.rangeLow, input.rangeHigh, input.by],
    );
    return res.rows[0]?.id ?? '';
  }

  async findInstrument(id: string, tx?: Queryable, forUpdate = false): Promise<InstrumentRow | null> {
    const res = await this.q(tx).query<InstrumentRow>(
      `SELECT ${INSTRUMENT_COLUMNS} FROM quality.instrument i JOIN iam.organization o ON o.id = i.owner_organization_id WHERE i.id = $1 ${forUpdate ? 'FOR UPDATE OF i' : ''}`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async instruments(ownerOrganizationId: string | null, tx?: Queryable): Promise<InstrumentRow[]> {
    const res = await this.q(tx).query<InstrumentRow>(
      `SELECT ${INSTRUMENT_COLUMNS} FROM quality.instrument i JOIN iam.organization o ON o.id = i.owner_organization_id
        WHERE ($1::uuid IS NULL OR i.owner_organization_id = $1) ORDER BY o.display_name, i.asset_tag`,
      [ownerOrganizationId],
    );
    return res.rows;
  }

  async calibrations(instrumentIds: readonly string[], tx?: Queryable): Promise<CalibrationRow[]> {
    if (instrumentIds.length === 0) return [];
    const res = await this.q(tx).query<CalibrationRow>(
      `SELECT id, instrument_id AS "instrumentId", performed_at AS "performedAt", due_at AS "dueAt", outcome,
              certificate_document_version_id AS "certificateDocumentVersionId", certificate_sha256 AS "certificateSha256", note
         FROM quality.calibration WHERE instrument_id = ANY($1::uuid[]) ORDER BY performed_at DESC`,
      [instrumentIds],
    );
    return res.rows;
  }

  async insertCalibration(
    input: { instrumentId: string; performedAt: Date; dueAt: Date; outcome: 'pass' | 'out_of_tolerance'; certificateDocumentVersionId: string; certificateSha256: string; note: string; by: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO quality.calibration (instrument_id, performed_at, due_at, outcome, certificate_document_version_id, certificate_sha256, note, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [input.instrumentId, input.performedAt, input.dueAt, input.outcome, input.certificateDocumentVersionId, input.certificateSha256, input.note, input.by],
    );
    await tx.query(`UPDATE quality.instrument SET aggregate_version = aggregate_version + 1, updated_at = now() WHERE id = $1`, [input.instrumentId]);
    return res.rows[0]!.id;
  }

  async retireInstrument(id: string, tx: Queryable): Promise<number> {
    const res = await tx.query<{ aggregate_version: number }>(
      `UPDATE quality.instrument SET status = 'retired', aggregate_version = aggregate_version + 1, updated_at = now() WHERE id = $1 RETURNING aggregate_version`,
      [id],
    );
    return res.rows[0]!.aggregate_version;
  }

  /** The calibration in force at `at`: the latest performed by then. */
  async calibrationAt(instrumentId: string, at: Date, tx?: Queryable): Promise<CalibrationRow | null> {
    const res = await this.q(tx).query<CalibrationRow>(
      `SELECT id, instrument_id AS "instrumentId", performed_at AS "performedAt", due_at AS "dueAt", outcome,
              certificate_document_version_id AS "certificateDocumentVersionId", certificate_sha256 AS "certificateSha256", note
         FROM quality.calibration WHERE instrument_id = $1 AND performed_at <= $2 ORDER BY performed_at DESC LIMIT 1`,
      [instrumentId, at],
    );
    return res.rows[0] ?? null;
  }

  /** A clean, available document version owned by `organizationId`, with its hash. */
  async ownCleanVersion(documentVersionId: string, organizationId: string, tx?: Queryable): Promise<{ sha256: string; filename: string } | null> {
    const res = await this.q(tx).query<{ sha256: string; filename: string }>(
      `SELECT f.sha256, v.original_filename AS filename
         FROM dms.document_version v
         JOIN dms.document d ON d.id = v.document_id
         JOIN dms.file_object f ON f.id = v.file_object_id
        WHERE v.id = $1 AND d.owning_organization_id = $2 AND v.status = 'available' AND f.scan_state = 'clean'`,
      [documentVersionId, organizationId],
    );
    return res.rows[0] ?? null;
  }

  // ----------------------------------------------------------------- inspections

  async allocateNumber(now: Date, tx: Queryable): Promise<string> {
    const year = now.getUTCFullYear();
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('quality.inspection.number'))`);
    const res = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(NULLIF(split_part(number, '-', 3), '')::int), 0) + 1 AS next FROM quality.inspection WHERE number LIKE $1`,
      [`QI-${year}-%`],
    );
    return `QI-${year}-${String(res.rows[0]!.next).padStart(4, '0')}`;
  }

  async insertInspection(
    input: {
      number: string;
      workPackageId: string;
      planId: string;
      baselineId: string;
      stage: InspectionStage;
      sampleSize: number;
      lot: string;
      note: string;
      inspectingOrganizationId: string;
      milestoneId: string | null;
      reinspectionOf: string | null;
      by: string;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO quality.inspection (number, work_package_id, plan_id, baseline_id, stage, sample_size, lot, note, inspecting_organization_id, milestone_id, reinspection_of, planned_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [input.number, input.workPackageId, input.planId, input.baselineId, input.stage, input.sampleSize, input.lot, input.note, input.inspectingOrganizationId, input.milestoneId, input.reinspectionOf, input.by],
    );
    return res.rows[0]!.id;
  }

  async findInspection(id: string, tx?: Queryable, forUpdate = false): Promise<InspectionRow | null> {
    const res = await this.q(tx).query<InspectionRow>(`SELECT ${INSPECTION_COLUMNS} ${INSPECTION_FROM} WHERE i.id = $1 ${forUpdate ? 'FOR UPDATE OF i' : ''}`, [id]);
    return res.rows[0] ?? null;
  }

  async inspections(filter: { workPackageId?: string; inspectingOrganizationId?: string; statuses?: readonly InspectionStatus[] }, tx?: Queryable): Promise<InspectionRow[]> {
    const res = await this.q(tx).query<InspectionRow>(
      `SELECT ${INSPECTION_COLUMNS} ${INSPECTION_FROM}
        WHERE ($1::uuid IS NULL OR i.work_package_id = $1)
          AND ($2::uuid IS NULL OR i.inspecting_organization_id = $2)
          AND ($3::text[] IS NULL OR i.status = ANY($3))
        ORDER BY i.planned_at DESC LIMIT 200`,
      [filter.workPackageId ?? null, filter.inspectingOrganizationId ?? null, filter.statuses ?? null],
    );
    return res.rows;
  }

  async updateInspection(
    id: string,
    fields: Partial<{
      status: InspectionStatus;
      startedBy: string;
      startedAt: Date;
      inspectedAt: Date;
      submittedBy: string;
      submittedAt: Date;
      reviewerId: string;
      reviewStartedAt: Date;
      decidedAt: Date;
      decisionReason: string;
      invalidatedAt: Date;
      invalidationReason: string;
    }>,
    tx: Queryable,
  ): Promise<number> {
    const res = await tx.query<{ aggregate_version: number }>(
      `UPDATE quality.inspection
          SET status = COALESCE($2, status), started_by = COALESCE($3, started_by), started_at = COALESCE($4, started_at),
              inspected_at = COALESCE($5, inspected_at), submitted_by = COALESCE($6, submitted_by), submitted_at = COALESCE($7, submitted_at),
              reviewer_id = COALESCE($8, reviewer_id), review_started_at = COALESCE($9, review_started_at), decided_at = COALESCE($10, decided_at),
              decision_reason = COALESCE($11, decision_reason), invalidated_at = COALESCE($12, invalidated_at),
              invalidation_reason = COALESCE($13, invalidation_reason), aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1 RETURNING aggregate_version`,
      [
        id,
        fields.status ?? null,
        fields.startedBy ?? null,
        fields.startedAt ?? null,
        fields.inspectedAt ?? null,
        fields.submittedBy ?? null,
        fields.submittedAt ?? null,
        fields.reviewerId ?? null,
        fields.reviewStartedAt ?? null,
        fields.decidedAt ?? null,
        fields.decisionReason ?? null,
        fields.invalidatedAt ?? null,
        fields.invalidationReason ?? null,
      ],
    );
    return res.rows[0]!.aggregate_version;
  }

  async bumpInspection(id: string, tx: Queryable): Promise<number> {
    const res = await tx.query<{ aggregate_version: number }>(`UPDATE quality.inspection SET aggregate_version = aggregate_version + 1, updated_at = now() WHERE id = $1 RETURNING aggregate_version`, [id]);
    return res.rows[0]!.aggregate_version;
  }

  async insertSample(input: { inspectionId: string; sampleNo: number; serial: string; lot: string; cavity: string }, tx: Queryable): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO quality.inspection_sample (inspection_id, sample_no, serial, lot, cavity) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.inspectionId, input.sampleNo, input.serial, input.lot, input.cavity],
    );
    return res.rows[0]!.id;
  }

  async samples(inspectionId: string, tx?: Queryable): Promise<Array<{ id: string; sampleNo: number; serial: string; lot: string; cavity: string }>> {
    const res = await this.q(tx).query<{ id: string; sampleNo: number; serial: string; lot: string; cavity: string }>(
      `SELECT id, sample_no AS "sampleNo", serial, lot, cavity FROM quality.inspection_sample WHERE inspection_id = $1 ORDER BY sample_no`,
      [inspectionId],
    );
    return res.rows;
  }

  async insertResult(
    input: {
      inspectionId: string;
      sampleId: string;
      characteristicId: string;
      originalValue: string;
      originalUnit: string | null;
      declaredPrecision: number | null;
      normalizedValue: string | null;
      normalizedUnit: string | null;
      outcome: 'pass' | 'fail' | 'cannot_evaluate';
      outcomeReason: string;
      ruleVersion: string;
      conversionVersionId: string | null;
      method: string;
      instrumentId: string | null;
      calibrationId: string | null;
      calibrationStatus: ResultRow['calibrationStatus'];
      supersedesResultId: string | null;
      correctionReason: string | null;
      by: string;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO quality.inspection_result (inspection_id, sample_id, characteristic_id, original_value, original_unit, declared_precision, normalized_value,
              normalized_unit, outcome, outcome_reason, rule_version, conversion_version_id, method, instrument_id, calibration_id, calibration_status,
              supersedes_result_id, correction_reason, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
      [
        input.inspectionId,
        input.sampleId,
        input.characteristicId,
        input.originalValue,
        input.originalUnit,
        input.declaredPrecision,
        input.normalizedValue,
        input.normalizedUnit,
        input.outcome,
        input.outcomeReason,
        input.ruleVersion,
        input.conversionVersionId,
        input.method,
        input.instrumentId,
        input.calibrationId,
        input.calibrationStatus,
        input.supersedesResultId,
        input.correctionReason,
        input.by,
      ],
    );
    return res.rows[0]!.id;
  }

  /** Every result row, oldest first, with what superseded it and any calibration disposition. */
  async results(inspectionId: string, tx?: Queryable): Promise<ResultRow[]> {
    const res = await this.q(tx).query<ResultRow>(
      `SELECT r.id, r.sample_id AS "sampleId", s.sample_no AS "sampleNo", r.characteristic_id AS "characteristicId", r.original_value AS "originalValue",
              r.original_unit AS "originalUnit", r.declared_precision AS "declaredPrecision", r.normalized_value::text AS "normalizedValue",
              r.normalized_unit AS "normalizedUnit", r.outcome, r.outcome_reason AS "outcomeReason", r.rule_version AS "ruleVersion", r.method,
              r.instrument_id AS "instrumentId", ins.asset_tag AS "instrumentAssetTag", ins.kind AS "instrumentKind", r.calibration_status AS "calibrationStatus",
              r.supersedes_result_id AS "supersedesResultId", later.id AS "supersededByResultId", r.correction_reason AS "correctionReason",
              r.recorded_at AS "recordedAt",
              CASE WHEN d.id IS NULL THEN NULL
                   ELSE jsonb_build_object('decision', d.decision, 'reason', d.reason, 'decidedAt', d.decided_at) END AS disposition
         FROM quality.inspection_result r
         JOIN quality.inspection_sample s ON s.id = r.sample_id
         LEFT JOIN quality.instrument ins ON ins.id = r.instrument_id
         LEFT JOIN quality.inspection_result later ON later.supersedes_result_id = r.id
         LEFT JOIN quality.result_disposition d ON d.result_id = r.id
        WHERE r.inspection_id = $1
        ORDER BY r.recorded_at, s.sample_no`,
      [inspectionId],
    );
    return res.rows;
  }

  async insertDisposition(input: { resultId: string; decision: 'accept' | 'reinspect'; reason: string; by: string }, tx: Queryable): Promise<void> {
    await tx.query(`INSERT INTO quality.result_disposition (result_id, decision, reason, decided_by) VALUES ($1, $2, $3, $4)`, [input.resultId, input.decision, input.reason, input.by]);
  }

  async insertAttachment(input: { inspectionId: string; documentVersionId: string; sha256: string; note: string; by: string }, tx: Queryable): Promise<void> {
    await tx.query(
      `INSERT INTO quality.inspection_attachment (inspection_id, document_version_id, file_sha256, note, added_by) VALUES ($1, $2, $3, $4, $5)`,
      [input.inspectionId, input.documentVersionId, input.sha256, input.note, input.by],
    );
  }

  async attachments(inspectionId: string, tx?: Queryable): Promise<Array<{ documentVersionId: string; sha256: string; filename: string; note: string }>> {
    const res = await this.q(tx).query<{ documentVersionId: string; sha256: string; filename: string; note: string }>(
      `SELECT a.document_version_id AS "documentVersionId", a.file_sha256 AS sha256, v.original_filename AS filename, a.note
         FROM quality.inspection_attachment a JOIN dms.document_version v ON v.id = a.document_version_id
        WHERE a.inspection_id = $1 ORDER BY a.added_at`,
      [inspectionId],
    );
    return res.rows;
  }
}
