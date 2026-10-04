import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type {
  BidDraft,
  BidVersionStatus,
  InvitationStatus,
  LateBidPolicy,
  RfqStatus,
} from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';

type Queryable = Pool | PoolClient;

export interface RfqRow {
  id: string;
  enquiryId: string;
  requirementId: string;
  roundNo: number;
  reference: string | null;
  status: RfqStatus;
  currency: string;
  deadlineAt: Date | null;
  lateBidPolicy: LateBidPolicy;
  instructions: string;
  aggregateVersion: number;
  releasedAt: Date | null;
  closedAt: Date | null;
  outcomeReason: string | null;
  customerOrganizationId: string;
}

export interface RfqItemRow {
  id: string;
  lineNo: number;
  partName: string;
  description: string;
  quantityBreakpoints: Array<{ quantity: number; unit: string; kind?: string }>;
  specification: Record<string, unknown>;
}

export interface InvitationRow {
  id: string;
  rfqId: string;
  supplierProfileId: string;
  supplierOrganizationId: string;
  displayName: string;
  status: InvitationStatus;
  eligibilitySnapshot: { eligible: boolean; exclusions: string[] };
  overrideReason: string | null;
  invitedAt: Date | null;
  acknowledgedAt: Date | null;
  respondedAt: Date | null;
  declineCode: string | null;
  declineReason: string | null;
  aggregateVersion: number;
}

export interface BidVersionRow {
  id: string;
  supplierBidId: string;
  versionNo: number;
  status: BidVersionStatus;
  currency: string;
  taxTreatment: string;
  linesTotalMinor: number;
  nreAmountMinor: number;
  freightAmountMinor: number;
  totalAmountMinor: number;
  leadTimeDays: number;
  validityUntil: string;
  feasibility: string;
  assumptions: string;
  exclusions: string;
  paymentTerms: string;
  note: string;
  contentHash: string;
  receivedAt: Date;
  late: boolean;
  revisionReason: string | null;
  lines: Array<{
    rfqItemId: string;
    lineNo: number;
    quantity: number;
    unit: string;
    unitPriceMinor: number;
    setupAmountMinor: number;
    leadTimeDays: number | null;
    note: string;
  }>;
}

export interface BidRow {
  id: string;
  rfqId: string;
  rfqSupplierId: string;
  supplierOrganizationId: string;
  draft: { [K in keyof BidDraft]?: BidDraft[K] | undefined };
  currentVersionNo: number;
  aggregateVersion: number;
}

/**
 * Every read here is scoped by the party asking. There is no method that returns "the
 * bids on this RFQ" without saying whose eyes it is for, because doc 03 §7 makes that
 * distinction the difference between a working marketplace and a leak.
 */
@Injectable()
export class RfqRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  // ----------------------------------------------------------------- rfq

  async createRfq(
    input: {
      enquiryId: string;
      requirementId: string;
      roundNo: number;
      deadlineAt: Date;
      lateBidPolicy: LateBidPolicy;
      instructions: string;
      createdBy: string;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await this.q(tx).query<{ id: string }>(
      `INSERT INTO sourcing.rfq
         (enquiry_id, requirement_id, round_no, deadline_at, late_bid_policy, instructions,
          created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft') RETURNING id`,
      [
        input.enquiryId,
        input.requirementId,
        input.roundNo,
        input.deadlineAt,
        input.lateBidPolicy,
        input.instructions,
        input.createdBy,
      ],
    );
    return res.rows[0]!.id;
  }

  async nextRoundNo(enquiryId: string, tx?: Queryable): Promise<number> {
    const res = await this.q(tx).query<{ next: number }>(
      `SELECT COALESCE(max(round_no), 0) + 1 AS next FROM sourcing.rfq WHERE enquiry_id = $1`,
      [enquiryId],
    );
    return Number(res.rows[0]?.next ?? 1);
  }

  /** `RFQ-YYYY-NNNN`, allocated at release the way the enquiry reference is at submit. */
  async allocateReference(rfqId: string, tx: Queryable): Promise<string> {
    const year = new Date().getUTCFullYear();
    const res = await this.q(tx).query<{ reference: string }>(
      `UPDATE sourcing.rfq
          SET reference = $2 || '-' || lpad((
                SELECT count(*) + 1 FROM sourcing.rfq
                 WHERE reference LIKE $2 || '-%'
              )::text, 4, '0')
        WHERE id = $1 AND reference IS NULL
        RETURNING reference`,
      [rfqId, `RFQ-${year}`],
    );
    if (res.rows[0]) return res.rows[0].reference;
    const existing = await this.q(tx).query<{ reference: string }>(
      `SELECT reference FROM sourcing.rfq WHERE id = $1`,
      [rfqId],
    );
    return existing.rows[0]!.reference;
  }

  async findRfq(rfqId: string, tx?: Queryable): Promise<RfqRow | null> {
    const res = await this.q(tx).query(
      `SELECT r.*, e.customer_organization_id
         FROM sourcing.rfq r
         JOIN sourcing.enquiry e ON e.id = r.enquiry_id
        WHERE r.id = $1`,
      [rfqId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? mapRfq(row) : null;
  }

  async lockRfq(rfqId: string, tx: PoolClient): Promise<RfqRow | null> {
    const res = await tx.query(
      `SELECT r.*, e.customer_organization_id
         FROM sourcing.rfq r
         JOIN sourcing.enquiry e ON e.id = r.enquiry_id
        WHERE r.id = $1
          FOR NO KEY UPDATE OF r`,
      [rfqId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? mapRfq(row) : null;
  }

  async setRfqStatus(
    input: {
      rfqId: string;
      expectedVersion: number;
      status: RfqStatus;
      released?: { by: string } | undefined;
      closed?: { by: string; reason: string | null } | undefined;
    },
    tx: Queryable,
  ): Promise<RfqRow | null> {
    const res = await this.q(tx).query(
      `UPDATE sourcing.rfq
          SET status = $3,
              released_at = CASE WHEN $4::uuid IS NOT NULL THEN now() ELSE released_at END,
              released_by = COALESCE($4::uuid, released_by),
              closed_at = CASE WHEN $5::uuid IS NOT NULL THEN now() ELSE closed_at END,
              closed_by = COALESCE($5::uuid, closed_by),
              outcome_reason = COALESCE($6, outcome_reason),
              aggregate_version = aggregate_version + 1,
              updated_at = now()
        WHERE id = $1 AND aggregate_version = $2
        RETURNING id`,
      [
        input.rfqId,
        input.expectedVersion,
        input.status,
        input.released?.by ?? null,
        input.closed?.by ?? null,
        input.closed?.reason ?? null,
      ],
    );
    if (res.rowCount === 0) return null;
    return this.findRfq(input.rfqId, tx);
  }

  /** Rounds of an enquiry still live, locked for a revision to supersede (F-12.5). */
  async lockLiveRounds(enquiryId: string, statuses: readonly RfqStatus[], tx: PoolClient): Promise<RfqRow[]> {
    const res = await tx.query(
      `SELECT r.*, e.customer_organization_id
         FROM sourcing.rfq r
         JOIN sourcing.enquiry e ON e.id = r.enquiry_id
        WHERE r.enquiry_id = $1 AND r.status = ANY($2::text[])
        ORDER BY r.round_no
        FOR UPDATE OF r`,
      [enquiryId, statuses],
    );
    return res.rows.map((row: Record<string, unknown>) => mapRfq(row));
  }

  async hasRoundInStatus(enquiryId: string, status: RfqStatus, tx: Queryable): Promise<boolean> {
    const res = await tx.query(`SELECT 1 FROM sourcing.rfq WHERE enquiry_id = $1 AND status = $2 LIMIT 1`, [enquiryId, status]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * A proposed award waiting for approval on any round of the enquiry. Read across the
   * module line on purpose: a revision must not pull a round out from under an award
   * someone is about to approve (approval would then fail on a superseded round).
   */
  async hasPendingAward(enquiryId: string, tx: Queryable): Promise<boolean> {
    const res = await tx.query(
      `SELECT 1 FROM commercial.award a JOIN sourcing.rfq r ON r.id = a.rfq_id
        WHERE r.enquiry_id = $1 AND a.status = 'proposed' LIMIT 1`,
      [enquiryId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async supersede(rfqId: string, requirementId: string, by: string, reason: string, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE sourcing.rfq
          SET status = 'superseded', superseded_by_requirement_id = $2, closed_at = now(), closed_by = $3,
              outcome_reason = $4, aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1`,
      [rfqId, requirementId, by, reason],
    );
  }

  /** Organizations invited to a round that have not been revoked: who to tell it closed. */
  async invitedOrganizations(rfqId: string, tx: Queryable): Promise<string[]> {
    const res = await tx.query<{ supplier_organization_id: string }>(
      `SELECT DISTINCT supplier_organization_id FROM sourcing.rfq_supplier
        WHERE rfq_id = $1 AND status NOT IN ('prepared', 'revoked')`,
      [rfqId],
    );
    return res.rows.map((r) => r.supplier_organization_id);
  }

  async listRfqsForEnquiry(enquiryId: string): Promise<RfqRow[]> {
    const res = await this.q().query(
      `SELECT r.*, e.customer_organization_id
         FROM sourcing.rfq r
         JOIN sourcing.enquiry e ON e.id = r.enquiry_id
        WHERE r.enquiry_id = $1
        ORDER BY r.round_no DESC`,
      [enquiryId],
    );
    return res.rows.map((row: Record<string, unknown>) => mapRfq(row));
  }

  /** The internal control-room list: open rounds first, oldest deadline first. */
  async listRfqs(filter: { status?: RfqStatus | undefined }): Promise<RfqRow[]> {
    const res = await this.q().query(
      `SELECT r.*, e.customer_organization_id
         FROM sourcing.rfq r
         JOIN sourcing.enquiry e ON e.id = r.enquiry_id
        WHERE ($1::text IS NULL OR r.status = $1)
        ORDER BY (r.status = 'open') DESC, r.deadline_at NULLS LAST, r.created_at DESC
        LIMIT 100`,
      [filter.status ?? null],
    );
    return res.rows.map((row: Record<string, unknown>) => mapRfq(row));
  }

  // ----------------------------------------------------------------- items

  async addItem(
    input: {
      rfqId: string;
      enquiryItemId: string | null;
      lineNo: number;
      partName: string;
      description: string;
      quantityBreakpoints: unknown;
      specification: unknown;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await this.q(tx).query<{ id: string }>(
      `INSERT INTO sourcing.rfq_item
         (rfq_id, enquiry_item_id, line_no, part_name, description, quantity_breakpoints,
          specification)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) RETURNING id`,
      [
        input.rfqId,
        input.enquiryItemId,
        input.lineNo,
        input.partName,
        input.description,
        JSON.stringify(input.quantityBreakpoints),
        JSON.stringify(input.specification),
      ],
    );
    return res.rows[0]!.id;
  }

  async listItems(rfqId: string, tx?: Queryable): Promise<RfqItemRow[]> {
    const res = await this.q(tx).query(
      `SELECT id, line_no, part_name, description, quantity_breakpoints, specification
         FROM sourcing.rfq_item WHERE rfq_id = $1 ORDER BY line_no`,
      [rfqId],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      id: row['id'] as string,
      lineNo: row['line_no'] as number,
      partName: row['part_name'] as string,
      description: row['description'] as string,
      quantityBreakpoints: row['quantity_breakpoints'] as RfqItemRow['quantityBreakpoints'],
      specification: row['specification'] as Record<string, unknown>,
    }));
  }

  // ----------------------------------------------------------------- release manifest

  async addReleaseItem(
    input: { rfqId: string; documentVersionId: string; role: string; sha256: string },
    tx: Queryable,
  ): Promise<void> {
    await this.q(tx).query(
      `INSERT INTO sourcing.rfq_release_item (rfq_id, document_version_id, role, sha256)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (rfq_id, document_version_id) DO NOTHING`,
      [input.rfqId, input.documentVersionId, input.role, input.sha256],
    );
  }

  async listReleaseItems(
    rfqId: string,
    tx?: Queryable,
  ): Promise<Array<{ documentVersionId: string; role: string; sha256: string; filename: string }>> {
    const res = await this.q(tx).query(
      `SELECT ri.document_version_id, ri.role, ri.sha256, dv.original_filename
         FROM sourcing.rfq_release_item ri
         JOIN dms.document_version dv ON dv.id = ri.document_version_id
        WHERE ri.rfq_id = $1
        ORDER BY ri.role, dv.original_filename`,
      [rfqId],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      documentVersionId: row['document_version_id'] as string,
      role: row['role'] as string,
      sha256: row['sha256'] as string,
      filename: row['original_filename'] as string,
    }));
  }

  /**
   * The enquiry's attached documents with the two states release cares about. Release
   * refuses anything not scanned clean and available (`BR-ENG-02`, doc 09 §6).
   */
  async listEnquiryDocuments(
    enquiryId: string,
    tx?: Queryable,
  ): Promise<
    Array<{
      documentVersionId: string;
      role: string;
      sha256: string;
      versionStatus: string;
      scanState: string;
    }>
  > {
    const res = await this.q(tx).query(
      `SELECT ed.document_version_id, ed.role, f.sha256, dv.status AS version_status,
              f.scan_state
         FROM sourcing.enquiry_document ed
         JOIN dms.document_version dv ON dv.id = ed.document_version_id
         JOIN dms.file_object f ON f.id = dv.file_object_id
        WHERE ed.enquiry_id = $1`,
      [enquiryId],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      documentVersionId: row['document_version_id'] as string,
      role: row['role'] as string,
      sha256: row['sha256'] as string,
      versionStatus: row['version_status'] as string,
      scanState: row['scan_state'] as string,
    }));
  }

  // ----------------------------------------------------------------- invitations

  async addInvitation(
    input: {
      rfqId: string;
      supplierProfileId: string;
      supplierOrganizationId: string;
      eligibilitySnapshot: unknown;
      overrideReason: string | null;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await this.q(tx).query<{ id: string }>(
      `INSERT INTO sourcing.rfq_supplier
         (rfq_id, supplier_profile_id, supplier_organization_id, eligibility_snapshot,
          override_reason)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (rfq_id, supplier_profile_id) DO UPDATE
         SET eligibility_snapshot = EXCLUDED.eligibility_snapshot,
             override_reason = EXCLUDED.override_reason,
             updated_at = now()
       RETURNING id`,
      [
        input.rfqId,
        input.supplierProfileId,
        input.supplierOrganizationId,
        JSON.stringify(input.eligibilitySnapshot),
        input.overrideReason,
      ],
    );
    return res.rows[0]!.id;
  }

  async listInvitations(rfqId: string, tx?: Queryable): Promise<InvitationRow[]> {
    const res = await this.q(tx).query(
      `SELECT s.*, o.display_name
         FROM sourcing.rfq_supplier s
         JOIN iam.organization o ON o.id = s.supplier_organization_id
        WHERE s.rfq_id = $1
        ORDER BY o.display_name`,
      [rfqId],
    );
    return res.rows.map((row: Record<string, unknown>) => mapInvitation(row));
  }

  async findInvitation(id: string, tx?: Queryable): Promise<InvitationRow | null> {
    const res = await this.q(tx).query(
      `SELECT s.*, o.display_name
         FROM sourcing.rfq_supplier s
         JOIN iam.organization o ON o.id = s.supplier_organization_id
        WHERE s.id = $1`,
      [id],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? mapInvitation(row) : null;
  }

  /** The supplier's own invitation on a round — the only way a supplier reaches one. */
  async findInvitationForOrganization(
    rfqId: string,
    supplierOrganizationId: string,
    tx?: Queryable,
  ): Promise<InvitationRow | null> {
    const res = await this.q(tx).query(
      `SELECT s.*, o.display_name
         FROM sourcing.rfq_supplier s
         JOIN iam.organization o ON o.id = s.supplier_organization_id
        WHERE s.rfq_id = $1 AND s.supplier_organization_id = $2
          AND s.status <> 'revoked'`,
      [rfqId, supplierOrganizationId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? mapInvitation(row) : null;
  }

  async setInvitationStatus(
    input: {
      invitationId: string;
      status: InvitationStatus;
      declineCode?: string | null;
      declineReason?: string | null;
      revokeReason?: string | null;
    },
    tx: Queryable,
  ): Promise<InvitationRow | null> {
    await this.q(tx).query(
      `UPDATE sourcing.rfq_supplier
          SET status = $2,
              invited_at = CASE WHEN $2 = 'invited' THEN now() ELSE invited_at END,
              acknowledged_at = CASE WHEN $2 = 'acknowledged' THEN now() ELSE acknowledged_at END,
              responded_at = CASE WHEN $2 = 'responded' THEN now() ELSE responded_at END,
              declined_at = CASE WHEN $2 = 'declined' THEN now() ELSE declined_at END,
              decline_code = COALESCE($3, decline_code),
              decline_reason = COALESCE($4, decline_reason),
              revoked_at = CASE WHEN $2 = 'revoked' THEN now() ELSE revoked_at END,
              revoke_reason = COALESCE($5, revoke_reason),
              aggregate_version = aggregate_version + 1,
              updated_at = now()
        WHERE id = $1`,
      [
        input.invitationId,
        input.status,
        input.declineCode ?? null,
        input.declineReason ?? null,
        input.revokeReason ?? null,
      ],
    );
    return this.findInvitation(input.invitationId, tx);
  }

  /** Invitations still inside an open round when the deadline passes (F-06.6). */
  async listOverdueInvitations(
    now: Date,
    tx?: Queryable,
  ): Promise<Array<{ invitationId: string; rfqId: string; status: InvitationStatus }>> {
    const res = await this.q(tx).query(
      `SELECT s.id, s.rfq_id, s.status
         FROM sourcing.rfq_supplier s
         JOIN sourcing.rfq r ON r.id = s.rfq_id
        WHERE r.status = 'open' AND r.deadline_at <= $1
          AND s.status IN ('invited', 'acknowledged', 'clarifying')`,
      [now],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      invitationId: row['id'] as string,
      rfqId: row['rfq_id'] as string,
      status: row['status'] as InvitationStatus,
    }));
  }

  async listOverdueRfqs(now: Date, tx?: Queryable): Promise<string[]> {
    const res = await this.q(tx).query<{ id: string }>(
      `SELECT id FROM sourcing.rfq WHERE status = 'open' AND deadline_at <= $1`,
      [now],
    );
    return res.rows.map((row) => row.id);
  }

  // ----------------------------------------------------------------- bids

  async ensureBid(
    input: {
      rfqId: string;
      rfqSupplierId: string;
      supplierOrganizationId: string;
      createdBy: string;
    },
    tx: Queryable,
  ): Promise<BidRow> {
    await this.q(tx).query(
      `INSERT INTO sourcing.supplier_bid
         (rfq_id, rfq_supplier_id, supplier_organization_id, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (rfq_id, rfq_supplier_id) DO NOTHING`,
      [input.rfqId, input.rfqSupplierId, input.supplierOrganizationId, input.createdBy],
    );
    const bid = await this.findBid(input.rfqId, input.supplierOrganizationId, tx);
    if (!bid) throw new Error('bid could not be created');
    return bid;
  }

  async findBid(
    rfqId: string,
    supplierOrganizationId: string,
    tx?: Queryable,
  ): Promise<BidRow | null> {
    const res = await this.q(tx).query(
      `SELECT * FROM sourcing.supplier_bid
        WHERE rfq_id = $1 AND supplier_organization_id = $2`,
      [rfqId, supplierOrganizationId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? mapBid(row) : null;
  }

  async saveDraft(
    bidId: string,
    draft: { [K in keyof BidDraft]?: BidDraft[K] | undefined },
    tx: Queryable,
  ): Promise<void> {
    await this.q(tx).query(
      `UPDATE sourcing.supplier_bid
          SET draft = $2::jsonb, aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1`,
      [bidId, JSON.stringify(draft)],
    );
  }

  async appendBidVersion(
    input: {
      supplierBidId: string;
      versionNo: number;
      currency: string;
      taxTreatment: string;
      linesTotalMinor: number;
      nreAmountMinor: number;
      freightAmountMinor: number;
      totalAmountMinor: number;
      leadTimeDays: number;
      validityUntil: string;
      feasibility: string;
      assumptions: string;
      exclusions: string;
      paymentTerms: string;
      note: string;
      contentHash: string;
      late: boolean;
      submittedBy: string;
      supersedesVersionId: string | null;
      revisionReason: string | null;
      lines: ReadonlyArray<{
        rfqItemId: string;
        lineNo: number;
        quantity: number;
        unit: string;
        unitPriceMinor: number;
        setupAmountMinor: number;
        leadTimeDays: number | null;
        note: string;
      }>;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await this.q(tx).query<{ id: string }>(
      `INSERT INTO sourcing.supplier_bid_version
         (supplier_bid_id, version_no, currency, tax_treatment, lines_total_minor,
          nre_amount_minor, freight_amount_minor, total_amount_minor, lead_time_days,
          validity_until, feasibility, assumptions, exclusions, payment_terms, note,
          content_hash, late, submitted_by, supersedes_version_id, revision_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        input.supplierBidId,
        input.versionNo,
        input.currency,
        input.taxTreatment,
        input.linesTotalMinor,
        input.nreAmountMinor,
        input.freightAmountMinor,
        input.totalAmountMinor,
        input.leadTimeDays,
        input.validityUntil,
        input.feasibility,
        input.assumptions,
        input.exclusions,
        input.paymentTerms,
        input.note,
        input.contentHash,
        input.late,
        input.submittedBy,
        input.supersedesVersionId,
        input.revisionReason,
      ],
    );
    const versionId = res.rows[0]!.id;
    for (const line of input.lines) {
      await this.q(tx).query(
        `INSERT INTO sourcing.bid_line
           (supplier_bid_version_id, rfq_item_id, line_no, quantity, unit, unit_price_minor,
            setup_amount_minor, lead_time_days, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          versionId,
          line.rfqItemId,
          line.lineNo,
          line.quantity,
          line.unit,
          line.unitPriceMinor,
          line.setupAmountMinor,
          line.leadTimeDays,
          line.note,
        ],
      );
    }
    await this.q(tx).query(
      `UPDATE sourcing.supplier_bid
          SET current_version_no = $2, draft = '{}'::jsonb,
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1`,
      [input.supplierBidId, input.versionNo],
    );
    return versionId;
  }

  async setVersionStatus(
    input: {
      versionId: string;
      status: BidVersionStatus;
      reason?: string | null;
      decidedBy?: string | null;
    },
    tx: Queryable,
  ): Promise<void> {
    await this.q(tx).query(
      `UPDATE sourcing.supplier_bid_version
          SET status = $2, disposition_reason = COALESCE($3, disposition_reason),
              decided_at = now(), decided_by = COALESCE($4, decided_by)
        WHERE id = $1`,
      [input.versionId, input.status, input.reason ?? null, input.decidedBy ?? null],
    );
  }

  async listBidVersions(supplierBidId: string, tx?: Queryable): Promise<BidVersionRow[]> {
    const res = await this.q(tx).query(
      `SELECT v.*, COALESCE(
                (SELECT json_agg(json_build_object(
                    'rfqItemId', l.rfq_item_id, 'lineNo', l.line_no, 'quantity', l.quantity,
                    'unit', l.unit, 'unitPriceMinor', l.unit_price_minor,
                    'setupAmountMinor', l.setup_amount_minor, 'leadTimeDays', l.lead_time_days,
                    'note', l.note) ORDER BY l.line_no)
                   FROM sourcing.bid_line l WHERE l.supplier_bid_version_id = v.id),
                '[]'::json) AS lines
         FROM sourcing.supplier_bid_version v
        WHERE v.supplier_bid_id = $1
        ORDER BY v.version_no DESC`,
      [supplierBidId],
    );
    return res.rows.map((row: Record<string, unknown>) => mapVersion(row));
  }

  async findLiveVersion(supplierBidId: string, tx?: Queryable): Promise<BidVersionRow | null> {
    const versions = await this.listBidVersions(supplierBidId, tx);
    return versions.find((version) => version.status === 'submitted') ?? null;
  }

  /**
   * Every live bid on a round, for JobWork only. There is deliberately no supplier-facing
   * counterpart of this method: a supplier reads its own bid through `findBid`, and no
   * query in this repository can hand it somebody else's.
   */
  async listLiveBidsForRfq(
    rfqId: string,
  ): Promise<Array<{ invitation: InvitationRow; bid: BidRow; version: BidVersionRow | null }>> {
    const invitations = await this.listInvitations(rfqId);
    const out: Array<{ invitation: InvitationRow; bid: BidRow; version: BidVersionRow | null }> = [];
    for (const invitation of invitations) {
      const bid = await this.findBid(rfqId, invitation.supplierOrganizationId);
      if (!bid) continue;
      out.push({ invitation, bid, version: await this.findLiveVersion(bid.id) });
    }
    return out;
  }

  async countBidVersions(supplierBidId: string, tx?: Queryable): Promise<number> {
    const res = await this.q(tx).query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sourcing.supplier_bid_version WHERE supplier_bid_id = $1`,
      [supplierBidId],
    );
    return res.rows[0]?.n ?? 0;
  }

  /** Rounds a supplier organization can see: its own invitations, never anyone else's. */
  async listRfqsForSupplier(
    supplierOrganizationId: string,
  ): Promise<Array<{ rfq: RfqRow; invitation: InvitationRow; bidVersionCount: number }>> {
    const res = await this.q().query<{ rfq_id: string }>(
      `SELECT s.rfq_id
         FROM sourcing.rfq_supplier s
         JOIN sourcing.rfq r ON r.id = s.rfq_id
        WHERE s.supplier_organization_id = $1
          AND s.status <> 'revoked'
          AND r.status <> 'draft'
        ORDER BY r.deadline_at NULLS LAST`,
      [supplierOrganizationId],
    );
    const out: Array<{ rfq: RfqRow; invitation: InvitationRow; bidVersionCount: number }> = [];
    for (const { rfq_id: rfqId } of res.rows) {
      const rfq = await this.findRfq(rfqId);
      const invitation = await this.findInvitationForOrganization(rfqId, supplierOrganizationId);
      if (!rfq || !invitation) continue;
      const bid = await this.findBid(rfqId, supplierOrganizationId);
      out.push({
        rfq,
        invitation,
        bidVersionCount: bid ? await this.countBidVersions(bid.id) : 0,
      });
    }
    return out;
  }

  // ----------------------------------------------------------------- matching record

  async recordMatchSnapshot(
    input: {
      rfqId: string | null;
      enquiryId: string;
      configVersion: string;
      inputs: unknown;
      candidates: unknown;
      shortlist: unknown;
      createdBy: string;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await this.q(tx).query<{ id: string }>(
      `INSERT INTO sourcing.match_snapshot
         (rfq_id, enquiry_id, config_version, inputs, candidates, shortlist, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7) RETURNING id`,
      [
        input.rfqId,
        input.enquiryId,
        input.configVersion,
        JSON.stringify(input.inputs),
        JSON.stringify(input.candidates),
        JSON.stringify(input.shortlist),
        input.createdBy,
      ],
    );
    return res.rows[0]!.id;
  }

  // ----------------------------------------------------------------- agreements

  /** Whether an organization has accepted the live version of an agreement kind. */
  async hasAcceptedAgreement(
    organizationId: string,
    kind: string,
    tx?: Queryable,
  ): Promise<boolean> {
    const res = await this.q(tx).query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM sourcing.agreement_acceptance a
         JOIN sourcing.agreement_version v ON v.id = a.agreement_version_id
         JOIN sourcing.agreement g ON g.id = v.agreement_id
        WHERE a.organization_id = $1 AND g.kind = $2 AND v.retired_at IS NULL`,
      [organizationId, kind],
    );
    return (res.rows[0]?.n ?? 0) > 0;
  }
}

function mapRfq(row: Record<string, unknown>): RfqRow {
  return {
    id: row['id'] as string,
    enquiryId: row['enquiry_id'] as string,
    requirementId: row['requirement_id'] as string,
    roundNo: row['round_no'] as number,
    reference: (row['reference'] as string | null) ?? null,
    status: row['status'] as RfqStatus,
    currency: row['currency'] as string,
    deadlineAt: (row['deadline_at'] as Date | null) ?? null,
    lateBidPolicy: row['late_bid_policy'] as LateBidPolicy,
    instructions: row['instructions'] as string,
    aggregateVersion: row['aggregate_version'] as number,
    releasedAt: (row['released_at'] as Date | null) ?? null,
    closedAt: (row['closed_at'] as Date | null) ?? null,
    outcomeReason: (row['outcome_reason'] as string | null) ?? null,
    customerOrganizationId: row['customer_organization_id'] as string,
  };
}

function mapInvitation(row: Record<string, unknown>): InvitationRow {
  return {
    id: row['id'] as string,
    rfqId: row['rfq_id'] as string,
    supplierProfileId: row['supplier_profile_id'] as string,
    supplierOrganizationId: row['supplier_organization_id'] as string,
    displayName: (row['display_name'] as string | undefined) ?? '',
    status: row['status'] as InvitationStatus,
    eligibilitySnapshot: (row['eligibility_snapshot'] as InvitationRow['eligibilitySnapshot']) ?? {
      eligible: false,
      exclusions: [],
    },
    overrideReason: (row['override_reason'] as string | null) ?? null,
    invitedAt: (row['invited_at'] as Date | null) ?? null,
    acknowledgedAt: (row['acknowledged_at'] as Date | null) ?? null,
    respondedAt: (row['responded_at'] as Date | null) ?? null,
    declineCode: (row['decline_code'] as string | null) ?? null,
    declineReason: (row['decline_reason'] as string | null) ?? null,
    aggregateVersion: row['aggregate_version'] as number,
  };
}

function mapBid(row: Record<string, unknown>): BidRow {
  return {
    id: row['id'] as string,
    rfqId: row['rfq_id'] as string,
    rfqSupplierId: row['rfq_supplier_id'] as string,
    supplierOrganizationId: row['supplier_organization_id'] as string,
    draft: (row['draft'] as BidRow['draft']) ?? {},
    currentVersionNo: row['current_version_no'] as number,
    aggregateVersion: row['aggregate_version'] as number,
  };
}

function mapVersion(row: Record<string, unknown>): BidVersionRow {
  return {
    id: row['id'] as string,
    supplierBidId: row['supplier_bid_id'] as string,
    versionNo: row['version_no'] as number,
    status: row['status'] as BidVersionStatus,
    currency: row['currency'] as string,
    taxTreatment: row['tax_treatment'] as string,
    linesTotalMinor: Number(row['lines_total_minor']),
    nreAmountMinor: Number(row['nre_amount_minor']),
    freightAmountMinor: Number(row['freight_amount_minor']),
    totalAmountMinor: Number(row['total_amount_minor']),
    leadTimeDays: row['lead_time_days'] as number,
    // A `date` column arrives as a string (registerPgTypeParsers) and must stay one.
    validityUntil: row['validity_until'] as string,
    feasibility: row['feasibility'] as string,
    assumptions: row['assumptions'] as string,
    exclusions: row['exclusions'] as string,
    paymentTerms: row['payment_terms'] as string,
    note: row['note'] as string,
    contentHash: row['content_hash'] as string,
    receivedAt: row['received_at'] as Date,
    late: row['late'] as boolean,
    revisionReason: (row['revision_reason'] as string | null) ?? null,
    lines: ((row['lines'] as BidVersionRow['lines'] | null) ?? []).map((line) => ({
      ...line,
      quantity: Number(line.quantity),
      unitPriceMinor: Number(line.unitPriceMinor),
      setupAmountMinor: Number(line.setupAmountMinor),
    })),
  };
}
