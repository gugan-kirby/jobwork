import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type {
  ApprovalKind,
  ApprovalRequestStatus,
  AwardStatus,
  CostComponent,
  CostSheetStatus,
  EvaluationComponents,
  EvaluationLine,
  EvaluationScenario,
  QuoteOptionLabel,
  QuoteStatus,
  QuoteVersionStatus,
  SellLine,
} from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';

type Queryable = Pool | PoolClient;

/**
 * Persistence for the commercial schema. Every read is explicit about whose eyes it is
 * for: the customer-facing reads (`listQuotesForCustomer`, `findQuoteForCustomer`) take
 * the customer organization and never join a supplier, a bid or a cost sheet.
 */

export interface PolicyVersionRow {
  id: string;
  kind: ApprovalKind;
  versionNo: number;
  rules: unknown;
}

export interface ApprovalRequestRow {
  id: string;
  kind: ApprovalKind;
  subjectType: string;
  subjectId: string;
  subjectVersionNo: number | null;
  subjectHash: string;
  policyVersionId: string;
  policyVersionNo: number;
  requestedBy: string;
  requestedByName: string;
  requestedAt: Date;
  amountMinor: number | null;
  currency: string | null;
  marginBp: number | null;
  context: Record<string, unknown>;
  requiredRoles: string[];
  status: ApprovalRequestStatus;
  decidedAt: Date | null;
  decisions: Array<{
    id: string;
    decision: 'approved' | 'rejected' | 'returned';
    decidedBy: string;
    decidedByName: string;
    decidedAt: Date;
    authoritySnapshot: { roles: string[]; organizationId: string | null };
    reason: string;
  }>;
}

export interface EvaluationRowRecord {
  bidVersionId: string;
  supplierOrganizationId: string;
  supplierDisplayName: string;
  versionNo: number;
  originalTotalMinor: number;
  normalizedLandedMinor: number;
  components: EvaluationComponents;
  lines: EvaluationLine[];
  leadTimeDays: number;
  validityUntil: string;
  feasibility: string;
  rank: number;
  flags: string[];
}

export interface EvaluationRecord {
  id: string;
  rfqId: string;
  configVersion: string;
  scenario: EvaluationScenario;
  scenarioHash: string;
  createdAt: Date;
  rows: EvaluationRowRecord[];
}

export interface AwardLineRecord {
  id: string;
  rfqItemId: string;
  lineNo: number;
  bidVersionId: string;
  supplierOrganizationId: string;
  supplierDisplayName: string;
  bidQuantity: number;
  quantity: number;
  unit: string;
  unitPriceMinor: number;
  setupAmountMinor: number;
  lineTotalMinor: number;
}

export interface AwardRecord {
  id: string;
  rfqId: string;
  rfqReference: string | null;
  enquiryId: string;
  evaluationId: string | null;
  status: AwardStatus;
  singleSource: boolean;
  rationale: string;
  fallbackNote: string;
  proposedBy: string;
  proposedAt: Date;
  approvalRequestId: string | null;
  decidedAt: Date | null;
  currency: string;
  buyTotalMinor: number;
  aggregateVersion: number;
  lines: AwardLineRecord[];
  costSheetId: string | null;
}

export interface CostSheetVersionRecord {
  id: string;
  versionNo: number;
  status: CostSheetStatus;
  currency: string;
  buyTotalMinor: number;
  components: CostComponent[];
  landedTotalMinor: number;
  marginMinor: number;
  marginBp: number;
  sellTotalMinor: number;
  sellLines: SellLine[];
  note: string;
  contentHash: string;
  approvalRequestId: string | null;
  createdAt: Date;
  supersedesVersionId: string | null;
}

export interface CostSheetRecord {
  id: string;
  rfqId: string;
  awardId: string;
  enquiryId: string;
  customerOrganizationId: string;
  status: CostSheetStatus;
  currentVersionNo: number;
  aggregateVersion: number;
  versions: CostSheetVersionRecord[];
}

export interface QuoteVersionRecord {
  id: string;
  versionNo: number;
  status: QuoteVersionStatus;
  currency: string;
  lines: Array<{ lineNo: number; description: string; quantity: number; unit: string; unitPriceMinor: number; amountMinor: number }>;
  subtotalMinor: number;
  taxRateBp: number;
  taxMinor: number;
  freightMinor: number;
  totalMinor: number;
  deliveryLeadDays: number;
  paymentTerms: string;
  advanceBp: number;
  balanceTrigger: 'on_acceptance' | 'before_dispatch' | 'on_delivery' | 'net_30';
  validityUntil: string;
  assumptions: string;
  exclusions: string;
  scopeNote: string;
  termsVersionId: string;
  termsVersionNo: number;
  termsCode: string;
  termsHash: string;
  contentHash: string;
  approvalRequestId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  createdBy: string;
  supersedesVersionId: string | null;
  revisionReason: string | null;
}

export interface QuoteRecord {
  id: string;
  offerSetId: string;
  enquiryId: string;
  enquiryReference: string | null;
  enquiryTitle: string;
  rfqId: string | null;
  customerOrganizationId: string;
  customerDisplayName: string;
  optionLabel: QuoteOptionLabel;
  reference: string | null;
  costSheetVersionId: string | null;
  status: QuoteStatus;
  currentVersionNo: number;
  decisionReason: string | null;
  acceptedVersionId: string | null;
  aggregateVersion: number;
  createdAt: Date;
  versions: QuoteVersionRecord[];
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

@Injectable()
export class CommercialRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  // ----------------------------------------------------------------- policy

  async activePolicy(kind: ApprovalKind, tx?: Queryable): Promise<PolicyVersionRow | null> {
    const res = await this.q(tx).query(
      `SELECT v.id, p.kind, v.version_no AS "versionNo", v.rules
         FROM commercial.approval_policy_version v
         JOIN commercial.approval_policy p ON p.id = v.policy_id
        WHERE p.kind = $1 AND v.status = 'active'`,
      [kind],
    );
    return (res.rows[0] as PolicyVersionRow | undefined) ?? null;
  }

  // ----------------------------------------------------------------- approvals

  async createApprovalRequest(
    input: {
      kind: ApprovalKind;
      subjectType: string;
      subjectId: string;
      subjectVersionNo: number | null;
      subjectHash: string;
      policyVersionId: string;
      requestedBy: string;
      amountMinor: number | null;
      currency: string | null;
      marginBp: number | null;
      context: Record<string, unknown>;
      requiredRoles: string[];
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO commercial.approval_request
         (kind, subject_type, subject_id, subject_version_no, subject_hash, policy_version_id,
          requested_by, amount_minor, currency, margin_bp, context, required_roles)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::text[]) RETURNING id`,
      [
        input.kind,
        input.subjectType,
        input.subjectId,
        input.subjectVersionNo,
        input.subjectHash,
        input.policyVersionId,
        input.requestedBy,
        input.amountMinor,
        input.currency,
        input.marginBp,
        JSON.stringify(input.context),
        input.requiredRoles,
      ],
    );
    return res.rows[0]!.id;
  }

  async findApprovalRequest(id: string, tx?: Queryable, forUpdate = false): Promise<ApprovalRequestRow | null> {
    const res = await this.q(tx).query(
      `SELECT r.id, r.kind, r.subject_type AS "subjectType", r.subject_id AS "subjectId",
              r.subject_version_no AS "subjectVersionNo", r.subject_hash AS "subjectHash",
              r.policy_version_id AS "policyVersionId", v.version_no AS "policyVersionNo",
              r.requested_by AS "requestedBy", COALESCE(u.display_name, '') AS "requestedByName",
              r.requested_at AS "requestedAt", r.amount_minor AS "amountMinor", r.currency,
              r.margin_bp AS "marginBp", r.context, r.required_roles AS "requiredRoles",
              r.status, r.decided_at AS "decidedAt"
         FROM commercial.approval_request r
         JOIN commercial.approval_policy_version v ON v.id = r.policy_version_id
         LEFT JOIN iam.user_account u ON u.id = r.requested_by
        WHERE r.id = $1 ${forUpdate ? 'FOR UPDATE OF r' : ''}`,
      [id],
    );
    const row = res.rows[0] as Omit<ApprovalRequestRow, 'decisions'> | undefined;
    if (!row) return null;
    return { ...row, amountMinor: row.amountMinor === null ? null : num(row.amountMinor), decisions: await this.listDecisions(id, tx) };
  }

  async listDecisions(requestId: string, tx?: Queryable): Promise<ApprovalRequestRow['decisions']> {
    const res = await this.q(tx).query(
      `SELECT d.id, d.decision, d.decided_by AS "decidedBy", COALESCE(u.display_name, '') AS "decidedByName",
              d.decided_at AS "decidedAt", d.authority_snapshot AS "authoritySnapshot", d.reason
         FROM commercial.approval_decision d
         LEFT JOIN iam.user_account u ON u.id = d.decided_by
        WHERE d.request_id = $1 ORDER BY d.decided_at`,
      [requestId],
    );
    return res.rows as ApprovalRequestRow['decisions'];
  }

  async listApprovalRequests(filter: { status?: ApprovalRequestStatus | undefined; kind?: ApprovalKind | undefined }, limit: number): Promise<ApprovalRequestRow[]> {
    const res = await this.db.pool.query<{ id: string }>(
      `SELECT id FROM commercial.approval_request
        WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR kind = $2)
        ORDER BY (status = 'pending') DESC, requested_at ASC LIMIT $3`,
      [filter.status ?? null, filter.kind ?? null, limit],
    );
    const rows: ApprovalRequestRow[] = [];
    for (const { id } of res.rows) {
      const row = await this.findApprovalRequest(id);
      if (row) rows.push(row);
    }
    return rows;
  }

  async recordDecision(
    input: {
      requestId: string;
      decision: 'approved' | 'rejected' | 'returned';
      decidedBy: string;
      authoritySnapshot: { roles: string[]; organizationId: string | null };
      reason: string;
      correlationId: string;
    },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO commercial.approval_decision
         (request_id, decision, decided_by, authority_snapshot, reason, correlation_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [input.requestId, input.decision, input.decidedBy, JSON.stringify(input.authoritySnapshot), input.reason, input.correlationId],
    );
    await tx.query(
      `UPDATE commercial.approval_request SET status = $2, decided_at = now() WHERE id = $1`,
      [input.requestId, input.decision],
    );
  }

  async supersedeApprovalRequest(requestId: string, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE commercial.approval_request SET status = 'superseded', decided_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [requestId],
    );
  }

  async pendingApprovalCount(): Promise<{ count: number; oldest: Date | null }> {
    const res = await this.db.pool.query<{ n: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, min(requested_at) AS oldest
         FROM commercial.approval_request WHERE status = 'pending'`,
    );
    return { count: Number(res.rows[0]?.n ?? 0), oldest: res.rows[0]?.oldest ?? null };
  }

  // ----------------------------------------------------------------- evaluation

  async createEvaluation(
    input: {
      rfqId: string;
      configVersion: string;
      scenario: EvaluationScenario;
      scenarioHash: string;
      createdBy: string;
      rows: EvaluationRowRecord[];
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO commercial.evaluation (rfq_id, config_version, scenario, scenario_hash, note, created_by)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id`,
      [input.rfqId, input.configVersion, JSON.stringify(input.scenario), input.scenarioHash, input.scenario.note, input.createdBy],
    );
    const id = res.rows[0]!.id;
    for (const row of input.rows) {
      await tx.query(
        `INSERT INTO commercial.evaluation_row
           (evaluation_id, bid_version_id, supplier_organization_id, original_total_minor,
            normalized_landed_minor, components, lines, lead_time_days, validity_until,
            feasibility, rank, flags)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12::text[])`,
        [
          id,
          row.bidVersionId,
          row.supplierOrganizationId,
          row.originalTotalMinor,
          row.normalizedLandedMinor,
          JSON.stringify(row.components),
          JSON.stringify(row.lines),
          row.leadTimeDays,
          row.validityUntil,
          row.feasibility,
          row.rank,
          row.flags,
        ],
      );
    }
    return id;
  }

  async findEvaluation(id: string, tx?: Queryable): Promise<EvaluationRecord | null> {
    const res = await this.q(tx).query(
      `SELECT id, rfq_id AS "rfqId", config_version AS "configVersion", scenario,
              scenario_hash AS "scenarioHash", created_at AS "createdAt"
         FROM commercial.evaluation WHERE id = $1`,
      [id],
    );
    const head = res.rows[0] as Omit<EvaluationRecord, 'rows'> | undefined;
    if (!head) return null;
    const rows = await this.q(tx).query(
      `SELECT r.bid_version_id AS "bidVersionId", r.supplier_organization_id AS "supplierOrganizationId",
              o.display_name AS "supplierDisplayName", v.version_no AS "versionNo",
              r.original_total_minor AS "originalTotalMinor", r.normalized_landed_minor AS "normalizedLandedMinor",
              r.components, r.lines, r.lead_time_days AS "leadTimeDays", r.validity_until AS "validityUntil",
              r.feasibility, r.rank, r.flags
         FROM commercial.evaluation_row r
         JOIN iam.organization o ON o.id = r.supplier_organization_id
         JOIN sourcing.supplier_bid_version v ON v.id = r.bid_version_id
        WHERE r.evaluation_id = $1 ORDER BY r.rank`,
      [id],
    );
    return {
      ...head,
      rows: rows.rows.map((row: Record<string, unknown>) => ({
        ...(row as unknown as EvaluationRowRecord),
        originalTotalMinor: num(row['originalTotalMinor']),
        normalizedLandedMinor: num(row['normalizedLandedMinor']),
      })),
    };
  }

  async listEvaluationsForRfq(rfqId: string): Promise<Array<{ id: string; scenarioHash: string; createdAt: Date; rowCount: number }>> {
    const res = await this.db.pool.query(
      `SELECT e.id, e.scenario_hash AS "scenarioHash", e.created_at AS "createdAt",
              (SELECT count(*)::int FROM commercial.evaluation_row r WHERE r.evaluation_id = e.id) AS "rowCount"
         FROM commercial.evaluation e WHERE e.rfq_id = $1 ORDER BY e.created_at DESC`,
      [rfqId],
    );
    return res.rows as Array<{ id: string; scenarioHash: string; createdAt: Date; rowCount: number }>;
  }

  // ----------------------------------------------------------------- award

  async createAward(
    input: {
      rfqId: string;
      evaluationId: string | null;
      singleSource: boolean;
      rationale: string;
      fallbackNote: string;
      proposedBy: string;
      currency: string;
      buyTotalMinor: number;
      lines: Array<Omit<AwardLineRecord, 'id' | 'supplierDisplayName' | 'lineNo'>>;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO commercial.award
         (rfq_id, evaluation_id, single_source, rationale, fallback_note, proposed_by, currency, buy_total_minor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [input.rfqId, input.evaluationId, input.singleSource, input.rationale, input.fallbackNote, input.proposedBy, input.currency, input.buyTotalMinor],
    );
    const id = res.rows[0]!.id;
    for (const line of input.lines) {
      await tx.query(
        `INSERT INTO commercial.award_line
           (award_id, rfq_item_id, bid_version_id, supplier_organization_id, bid_quantity, quantity,
            unit, unit_price_minor, setup_amount_minor, line_total_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, line.rfqItemId, line.bidVersionId, line.supplierOrganizationId, line.bidQuantity, line.quantity, line.unit, line.unitPriceMinor, line.setupAmountMinor, line.lineTotalMinor],
      );
    }
    return id;
  }

  async setAwardApproval(awardId: string, approvalRequestId: string, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE commercial.award SET approval_request_id = $2, aggregate_version = aggregate_version + 1 WHERE id = $1`,
      [awardId, approvalRequestId],
    );
  }

  async setAwardStatus(awardId: string, status: AwardStatus, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE commercial.award SET status = $2, decided_at = now(), aggregate_version = aggregate_version + 1 WHERE id = $1`,
      [awardId, status],
    );
  }

  async findAward(id: string, tx?: Queryable, forUpdate = false): Promise<AwardRecord | null> {
    const res = await this.q(tx).query(
      `SELECT a.id, a.rfq_id AS "rfqId", r.reference AS "rfqReference", r.enquiry_id AS "enquiryId",
              a.evaluation_id AS "evaluationId", a.status, a.single_source AS "singleSource",
              a.rationale, a.fallback_note AS "fallbackNote", a.proposed_by AS "proposedBy",
              a.proposed_at AS "proposedAt", a.approval_request_id AS "approvalRequestId",
              a.decided_at AS "decidedAt", a.currency, a.buy_total_minor AS "buyTotalMinor",
              a.aggregate_version AS "aggregateVersion",
              (SELECT c.id FROM commercial.cost_sheet c WHERE c.award_id = a.id) AS "costSheetId"
         FROM commercial.award a
         JOIN sourcing.rfq r ON r.id = a.rfq_id
        WHERE a.id = $1 ${forUpdate ? 'FOR UPDATE OF a' : ''}`,
      [id],
    );
    const head = res.rows[0] as Omit<AwardRecord, 'lines'> | undefined;
    if (!head) return null;
    const lines = await this.q(tx).query(
      `SELECT l.id, l.rfq_item_id AS "rfqItemId", i.line_no AS "lineNo", l.bid_version_id AS "bidVersionId",
              l.supplier_organization_id AS "supplierOrganizationId", o.display_name AS "supplierDisplayName",
              l.bid_quantity AS "bidQuantity", l.quantity, l.unit, l.unit_price_minor AS "unitPriceMinor",
              l.setup_amount_minor AS "setupAmountMinor", l.line_total_minor AS "lineTotalMinor"
         FROM commercial.award_line l
         JOIN sourcing.rfq_item i ON i.id = l.rfq_item_id
         JOIN iam.organization o ON o.id = l.supplier_organization_id
        WHERE l.award_id = $1 ORDER BY i.line_no, o.display_name`,
      [id],
    );
    return {
      ...head,
      buyTotalMinor: num(head.buyTotalMinor),
      lines: lines.rows.map((row: Record<string, unknown>) => ({
        ...(row as unknown as AwardLineRecord),
        bidQuantity: num(row['bidQuantity']),
        quantity: num(row['quantity']),
        unitPriceMinor: num(row['unitPriceMinor']),
        setupAmountMinor: num(row['setupAmountMinor']),
        lineTotalMinor: num(row['lineTotalMinor']),
      })),
    };
  }

  async listAwardsForRfq(rfqId: string): Promise<AwardRecord[]> {
    const res = await this.db.pool.query<{ id: string }>(
      `SELECT id FROM commercial.award WHERE rfq_id = $1 ORDER BY proposed_at DESC`,
      [rfqId],
    );
    const out: AwardRecord[] = [];
    for (const { id } of res.rows) {
      const award = await this.findAward(id);
      if (award) out.push(award);
    }
    return out;
  }

  // ----------------------------------------------------------------- cost sheet

  async findCostSheetByAward(awardId: string, tx?: Queryable): Promise<CostSheetRecord | null> {
    const res = await this.q(tx).query<{ id: string }>(`SELECT id FROM commercial.cost_sheet WHERE award_id = $1`, [awardId]);
    const row = res.rows[0];
    return row ? this.findCostSheet(row.id, tx) : null;
  }

  async createCostSheet(
    input: { rfqId: string; awardId: string; enquiryId: string; customerOrganizationId: string; createdBy: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO commercial.cost_sheet (rfq_id, award_id, enquiry_id, customer_organization_id, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [input.rfqId, input.awardId, input.enquiryId, input.customerOrganizationId, input.createdBy],
    );
    return res.rows[0]!.id;
  }

  async findCostSheet(id: string, tx?: Queryable, forUpdate = false): Promise<CostSheetRecord | null> {
    const res = await this.q(tx).query(
      `SELECT id, rfq_id AS "rfqId", award_id AS "awardId", enquiry_id AS "enquiryId",
              customer_organization_id AS "customerOrganizationId", status,
              current_version_no AS "currentVersionNo", aggregate_version AS "aggregateVersion"
         FROM commercial.cost_sheet WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    const head = res.rows[0] as Omit<CostSheetRecord, 'versions'> | undefined;
    if (!head) return null;
    const versions = await this.q(tx).query(
      `SELECT id, version_no AS "versionNo", status, currency, buy_total_minor AS "buyTotalMinor",
              components, landed_total_minor AS "landedTotalMinor", margin_minor AS "marginMinor",
              margin_bp AS "marginBp", sell_total_minor AS "sellTotalMinor", sell_lines AS "sellLines",
              note, content_hash AS "contentHash", approval_request_id AS "approvalRequestId",
              created_at AS "createdAt", supersedes_version_id AS "supersedesVersionId"
         FROM commercial.cost_sheet_version WHERE cost_sheet_id = $1 ORDER BY version_no DESC`,
      [id],
    );
    return {
      ...head,
      versions: versions.rows.map((row: Record<string, unknown>) => ({
        ...(row as unknown as CostSheetVersionRecord),
        buyTotalMinor: num(row['buyTotalMinor']),
        landedTotalMinor: num(row['landedTotalMinor']),
        marginMinor: num(row['marginMinor']),
        sellTotalMinor: num(row['sellTotalMinor']),
      })),
    };
  }

  async findCostSheetVersion(versionId: string, tx?: Queryable): Promise<{ costSheetId: string; version: CostSheetVersionRecord } | null> {
    const res = await this.q(tx).query<{ cost_sheet_id: string }>(
      `SELECT cost_sheet_id FROM commercial.cost_sheet_version WHERE id = $1`,
      [versionId],
    );
    const row = res.rows[0];
    if (!row) return null;
    const sheet = await this.findCostSheet(row.cost_sheet_id, tx);
    const version = sheet?.versions.find((v) => v.id === versionId);
    return sheet && version ? { costSheetId: sheet.id, version } : null;
  }

  async upsertCostSheetVersion(
    input: {
      costSheetId: string;
      versionNo: number;
      existingVersionId: string | null;
      currency: string;
      buyTotalMinor: number;
      components: CostComponent[];
      landedTotalMinor: number;
      marginMinor: number;
      marginBp: number;
      sellTotalMinor: number;
      sellLines: SellLine[];
      note: string;
      contentHash: string;
      createdBy: string;
      supersedesVersionId: string | null;
    },
    tx: Queryable,
  ): Promise<string> {
    if (input.existingVersionId) {
      await tx.query(
        `UPDATE commercial.cost_sheet_version
            SET buy_total_minor = $2, components = $3::jsonb, landed_total_minor = $4, margin_minor = $5,
                margin_bp = $6, sell_total_minor = $7, sell_lines = $8::jsonb, note = $9, content_hash = $10,
                status = 'draft', updated_at = now()
          WHERE id = $1`,
        [input.existingVersionId, input.buyTotalMinor, JSON.stringify(input.components), input.landedTotalMinor, input.marginMinor, input.marginBp, input.sellTotalMinor, JSON.stringify(input.sellLines), input.note, input.contentHash],
      );
      return input.existingVersionId;
    }
    const res = await tx.query<{ id: string }>(
      `INSERT INTO commercial.cost_sheet_version
         (cost_sheet_id, version_no, currency, buy_total_minor, components, landed_total_minor,
          margin_minor, margin_bp, sell_total_minor, sell_lines, note, content_hash, created_by, supersedes_version_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14) RETURNING id`,
      [input.costSheetId, input.versionNo, input.currency, input.buyTotalMinor, JSON.stringify(input.components), input.landedTotalMinor, input.marginMinor, input.marginBp, input.sellTotalMinor, JSON.stringify(input.sellLines), input.note, input.contentHash, input.createdBy, input.supersedesVersionId],
    );
    await tx.query(
      `UPDATE commercial.cost_sheet SET current_version_no = $2, status = 'draft',
              aggregate_version = aggregate_version + 1, updated_at = now() WHERE id = $1`,
      [input.costSheetId, input.versionNo],
    );
    return res.rows[0]!.id;
  }

  async setCostSheetVersionStatus(
    input: { versionId: string; status: CostSheetStatus; approvalRequestId?: string | null },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `UPDATE commercial.cost_sheet_version
          SET status = $2, approval_request_id = COALESCE($3, approval_request_id), updated_at = now()
        WHERE id = $1`,
      [input.versionId, input.status, input.approvalRequestId ?? null],
    );
  }

  async setCostSheetStatus(costSheetId: string, status: CostSheetStatus, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE commercial.cost_sheet SET status = $2, aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1`,
      [costSheetId, status],
    );
  }

  // ----------------------------------------------------------------- terms

  async currentTerms(code: string, tx?: Queryable): Promise<{ id: string; versionNo: number; contentHash: string; body: string } | null> {
    const res = await this.q(tx).query(
      `SELECT v.id, v.version_no AS "versionNo", v.content_hash AS "contentHash", v.body
         FROM commercial.terms_version v
         JOIN commercial.terms_document d ON d.id = v.terms_document_id
        WHERE d.code = $1 AND v.retired_at IS NULL
        ORDER BY v.version_no DESC LIMIT 1`,
      [code],
    );
    return (res.rows[0] as { id: string; versionNo: number; contentHash: string; body: string } | undefined) ?? null;
  }

  // ----------------------------------------------------------------- quotes

  async findOrCreateOfferSet(
    input: { enquiryId: string; rfqId: string | null; customerOrganizationId: string; createdBy: string },
    tx: Queryable,
  ): Promise<string> {
    // The latest set is reused while any option in it can still be decided, or has been
    // accepted. Once every option is closed without an acceptance (expired, rejected,
    // withdrawn), a re-quote is a new offer: a fresh set, so its options do not collide
    // with the closed ones (doc 06 §6: closed quotes stay closed; later records are new).
    const existing = await tx.query<{ id: string }>(
      `SELECT s.id FROM commercial.quote_offer_set s
        WHERE s.enquiry_id = $1 AND s.rfq_id IS NOT DISTINCT FROM $2
          AND (NOT EXISTS (SELECT 1 FROM commercial.customer_quote q WHERE q.offer_set_id = s.id)
               OR EXISTS (SELECT 1 FROM commercial.customer_quote q
                           WHERE q.offer_set_id = s.id AND q.status NOT IN ('expired', 'rejected', 'withdrawn')))
        ORDER BY s.created_at DESC LIMIT 1`,
      [input.enquiryId, input.rfqId],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const res = await tx.query<{ id: string }>(
      `INSERT INTO commercial.quote_offer_set (enquiry_id, rfq_id, customer_organization_id, created_by)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.enquiryId, input.rfqId, input.customerOrganizationId, input.createdBy],
    );
    return res.rows[0]!.id;
  }

  async createQuote(
    input: {
      offerSetId: string;
      enquiryId: string;
      rfqId: string | null;
      customerOrganizationId: string;
      optionLabel: QuoteOptionLabel;
      costSheetVersionId: string | null;
      createdBy: string;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO commercial.customer_quote
         (offer_set_id, enquiry_id, rfq_id, customer_organization_id, option_label, cost_sheet_version_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.offerSetId, input.enquiryId, input.rfqId, input.customerOrganizationId, input.optionLabel, input.costSheetVersionId, input.createdBy],
    );
    return res.rows[0]!.id;
  }

  async appendQuoteVersion(
    input: {
      quoteId: string;
      versionNo: number;
      currency: string;
      lines: Array<{ lineNo: number; description: string; quantity: number; unit: string; unitPriceMinor: number; amountMinor: number }>;
      subtotalMinor: number;
      taxRateBp: number;
      taxMinor: number;
      freightMinor: number;
      totalMinor: number;
      deliveryLeadDays: number;
      paymentTerms: string;
      advanceBp: number;
      balanceTrigger: 'on_acceptance' | 'before_dispatch' | 'on_delivery' | 'net_30';
      validityUntil: string;
      assumptions: string;
      exclusions: string;
      scopeNote: string;
      termsVersionId: string;
      contentHash: string;
      createdBy: string;
      supersedesVersionId: string | null;
      revisionReason: string | null;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO commercial.quote_version
         (customer_quote_id, version_no, currency, subtotal_minor, tax_rate_bp, tax_minor, freight_minor,
          total_minor, delivery_lead_days, payment_terms, validity_until, assumptions, exclusions, scope_note,
          terms_version_id, content_hash, created_by, supersedes_version_id, revision_reason, advance_bp, balance_trigger)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
      [
        input.quoteId, input.versionNo, input.currency, input.subtotalMinor, input.taxRateBp, input.taxMinor,
        input.freightMinor, input.totalMinor, input.deliveryLeadDays, input.paymentTerms, input.validityUntil,
        input.assumptions, input.exclusions, input.scopeNote, input.termsVersionId, input.contentHash,
        input.createdBy, input.supersedesVersionId, input.revisionReason, input.advanceBp, input.balanceTrigger,
      ],
    );
    const id = res.rows[0]!.id;
    for (const line of input.lines) {
      await tx.query(
        `INSERT INTO commercial.quote_line (quote_version_id, line_no, description, quantity, unit, unit_price_minor, amount_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, line.lineNo, line.description, line.quantity, line.unit, line.unitPriceMinor, line.amountMinor],
      );
    }
    await tx.query(
      `UPDATE commercial.customer_quote
          SET current_version_no = $2, aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1`,
      [input.quoteId, input.versionNo],
    );
    return id;
  }

  async setQuoteStatus(
    input: { quoteId: string; status: QuoteStatus; reference?: string | null; decisionReason?: string | null; acceptedVersionId?: string | null },
    tx: Queryable,
  ): Promise<number> {
    const res = await tx.query<{ aggregate_version: number }>(
      `UPDATE commercial.customer_quote
          SET status = $2, reference = COALESCE($3, reference), decision_reason = COALESCE($4, decision_reason),
              accepted_version_id = COALESCE($5, accepted_version_id),
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1 RETURNING aggregate_version`,
      [input.quoteId, input.status, input.reference ?? null, input.decisionReason ?? null, input.acceptedVersionId ?? null],
    );
    return res.rows[0]!.aggregate_version;
  }

  async setQuoteVersionStatus(
    input: { versionId: string; status: QuoteVersionStatus; approvalRequestId?: string | null; sentAt?: Date | null },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `UPDATE commercial.quote_version
          SET status = $2, approval_request_id = COALESCE($3, approval_request_id), sent_at = COALESCE($4, sent_at)
        WHERE id = $1`,
      [input.versionId, input.status, input.approvalRequestId ?? null, input.sentAt ?? null],
    );
  }

  /** The customer-visible reference, allocated at send like the enquiry's at submit. */
  async allocateQuoteReference(tx: Queryable, now: Date): Promise<string> {
    const year = now.getUTCFullYear();
    const res = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(NULLIF(split_part(reference, '-', 3), '')::int), 0) + 1 AS next
         FROM commercial.customer_quote WHERE reference LIKE $1`,
      [`QUO-${year}-%`],
    );
    return `QUO-${year}-${String(res.rows[0]!.next).padStart(4, '0')}`;
  }

  async findQuote(id: string, tx?: Queryable, forUpdate = false): Promise<QuoteRecord | null> {
    const res = await this.q(tx).query(
      `SELECT q.id, q.offer_set_id AS "offerSetId", q.enquiry_id AS "enquiryId", e.reference AS "enquiryReference",
              e.title AS "enquiryTitle", q.rfq_id AS "rfqId", q.customer_organization_id AS "customerOrganizationId",
              o.display_name AS "customerDisplayName", q.option_label AS "optionLabel", q.reference,
              q.cost_sheet_version_id AS "costSheetVersionId", q.status, q.current_version_no AS "currentVersionNo",
              q.decision_reason AS "decisionReason", q.accepted_version_id AS "acceptedVersionId",
              q.aggregate_version AS "aggregateVersion", q.created_at AS "createdAt"
         FROM commercial.customer_quote q
         JOIN sourcing.enquiry e ON e.id = q.enquiry_id
         JOIN iam.organization o ON o.id = q.customer_organization_id
        WHERE q.id = $1 ${forUpdate ? 'FOR UPDATE OF q' : ''}`,
      [id],
    );
    const head = res.rows[0] as Omit<QuoteRecord, 'versions'> | undefined;
    if (!head) return null;
    return { ...head, versions: await this.listQuoteVersions(id, tx) };
  }

  async listQuoteVersions(quoteId: string, tx?: Queryable): Promise<QuoteVersionRecord[]> {
    const res = await this.q(tx).query(
      `SELECT v.id, v.version_no AS "versionNo", v.status, v.currency, v.subtotal_minor AS "subtotalMinor",
              v.tax_rate_bp AS "taxRateBp", v.tax_minor AS "taxMinor", v.freight_minor AS "freightMinor",
              v.total_minor AS "totalMinor", v.delivery_lead_days AS "deliveryLeadDays", v.payment_terms AS "paymentTerms",
              v.advance_bp AS "advanceBp", v.balance_trigger AS "balanceTrigger",
              v.validity_until AS "validityUntil", v.assumptions, v.exclusions, v.scope_note AS "scopeNote",
              v.terms_version_id AS "termsVersionId", t.version_no AS "termsVersionNo", d.code AS "termsCode",
              t.content_hash AS "termsHash", v.content_hash AS "contentHash", v.approval_request_id AS "approvalRequestId",
              v.sent_at AS "sentAt", v.created_at AS "createdAt", v.created_by AS "createdBy",
              v.supersedes_version_id AS "supersedesVersionId", v.revision_reason AS "revisionReason",
              COALESCE((SELECT json_agg(json_build_object('lineNo', l.line_no, 'description', l.description,
                          'quantity', l.quantity, 'unit', l.unit, 'unitPriceMinor', l.unit_price_minor,
                          'amountMinor', l.amount_minor) ORDER BY l.line_no)
                          FROM commercial.quote_line l WHERE l.quote_version_id = v.id), '[]'::json) AS lines
         FROM commercial.quote_version v
         JOIN commercial.terms_version t ON t.id = v.terms_version_id
         JOIN commercial.terms_document d ON d.id = t.terms_document_id
        WHERE v.customer_quote_id = $1 ORDER BY v.version_no DESC`,
      [quoteId],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      ...(row as unknown as QuoteVersionRecord),
      subtotalMinor: num(row['subtotalMinor']),
      taxMinor: num(row['taxMinor']),
      freightMinor: num(row['freightMinor']),
      totalMinor: num(row['totalMinor']),
      lines: (row['lines'] as QuoteVersionRecord['lines']).map((l) => ({
        ...l,
        quantity: num(l.quantity),
        unitPriceMinor: num(l.unitPriceMinor),
        amountMinor: num(l.amountMinor),
      })),
    }));
  }

  async listQuotesForEnquiry(enquiryId: string): Promise<QuoteRecord[]> {
    const res = await this.db.pool.query<{ id: string }>(
      `SELECT id FROM commercial.customer_quote WHERE enquiry_id = $1 ORDER BY created_at DESC`,
      [enquiryId],
    );
    const out: QuoteRecord[] = [];
    for (const { id } of res.rows) {
      const quote = await this.findQuote(id);
      if (quote) out.push(quote);
    }
    return out;
  }

  async listQuotes(filter: { status?: QuoteStatus | undefined }, limit: number): Promise<QuoteRecord[]> {
    const res = await this.db.pool.query<{ id: string }>(
      `SELECT id FROM commercial.customer_quote
        WHERE ($1::text IS NULL OR status = $1) ORDER BY updated_at DESC LIMIT $2`,
      [filter.status ?? null, limit],
    );
    const out: QuoteRecord[] = [];
    for (const { id } of res.rows) {
      const quote = await this.findQuote(id);
      if (quote) out.push(quote);
    }
    return out;
  }

  /** Customer reads: only quotes of the caller's organization that have ever been sent. */
  async listQuotesForCustomer(customerOrganizationId: string): Promise<QuoteRecord[]> {
    const res = await this.db.pool.query<{ id: string }>(
      `SELECT id FROM commercial.customer_quote
        WHERE customer_organization_id = $1 AND reference IS NOT NULL
        ORDER BY updated_at DESC`,
      [customerOrganizationId],
    );
    const out: QuoteRecord[] = [];
    for (const { id } of res.rows) {
      const quote = await this.findQuote(id);
      if (quote) out.push(quote);
    }
    return out;
  }

  async listSiblings(offerSetId: string, tx?: Queryable): Promise<QuoteRecord[]> {
    const res = await this.q(tx).query<{ id: string }>(
      `SELECT id FROM commercial.customer_quote WHERE offer_set_id = $1 ORDER BY option_label`,
      [offerSetId],
    );
    const out: QuoteRecord[] = [];
    for (const { id } of res.rows) {
      const quote = await this.findQuote(id, tx);
      if (quote) out.push(quote);
    }
    return out;
  }

  /** Sent quotes whose validity has passed — the expiry sweep's work list. */
  async listExpiredSentQuotes(now: Date, tx?: Queryable): Promise<Array<{ quoteId: string; versionId: string }>> {
    const res = await this.q(tx).query<{ quoteId: string; versionId: string }>(
      `SELECT q.id AS "quoteId", v.id AS "versionId"
         FROM commercial.customer_quote q
         JOIN commercial.quote_version v ON v.customer_quote_id = q.id AND v.version_no = q.current_version_no
        WHERE q.status IN ('sent', 'revision_requested') AND v.validity_until < ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`,
      [now],
    );
    return res.rows;
  }

  async quotesAwaitingDecision(customerOrganizationId: string): Promise<{ count: number; oldest: Date | null }> {
    const res = await this.db.pool.query<{ n: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, min(updated_at) AS oldest
         FROM commercial.customer_quote
        WHERE customer_organization_id = $1 AND status = 'sent'`,
      [customerOrganizationId],
    );
    return { count: Number(res.rows[0]?.n ?? 0), oldest: res.rows[0]?.oldest ?? null };
  }
}
