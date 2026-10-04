import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type {
  Clarification,
  ClarificationTopic,
  Confidentiality,
  Enquiry,
  EnquiryDocument,
  EnquiryDocumentInput,
  EnquiryDocumentRole,
  EnquiryItem,
  EnquiryItemInput,
  EnquiryStatus,
  JobType,
  MaterialSupply,
  RequirementRevision,
} from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';

type Queryable = Pool | PoolClient;

interface EnquiryRow {
  id: string;
  customer_organization_id: string;
  reference: string | null;
  title: string;
  application_note: string;
  status: EnquiryStatus;
  confidentiality: Confidentiality;
  job_type: JobType;
  material_supply: MaterialSupply;
  change_reference: string;
  change_description: string;
  related_enquiry_id: string | null;
  assisted_intake: boolean;
  delivery_site_id: string | null;
  required_by_date: string | null;
  partial_delivery: 'allowed' | 'not_allowed';
  packaging_note: string;
  submitted_revision_no: number | null;
  current_revision_no: number | null;
  aggregate_version: number;
  copied_from_enquiry_id: string | null;
  submitted_at: Date | null;
  decision_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ItemRow {
  id: string;
  line_no: number;
  part_name: string;
  part_number: string | null;
  description: string;
  process_capability_id: string | null;
  material_capability_id: string | null;
  material_grade: string | null;
  material_source_restriction: string | null;
  quantity_breakpoints: EnquiryItem['quantityBreakpoints'];
  tolerance_class: string | null;
  critical_tolerance: EnquiryItem['criticalTolerance'] | null;
  surface_finish: string | null;
  heat_treatment: string | null;
  coating: string | null;
  inspection_level: EnquiryItem['inspectionLevel'];
  quality_note: string;
  target_date: string | null;
  delivery_site_id: string | null;
}

interface DocumentRow {
  id: string;
  document_version_id: string;
  line_no: number | null;
  role: EnquiryDocumentRole;
  note: string;
}

interface ClarificationRow {
  id: string;
  sequence_no: number;
  round_no: number;
  topic: ClarificationTopic;
  question: string;
  line_no: number | null;
  asked_against_revision_no: number;
  status: 'open' | 'answered' | 'withdrawn';
  answer: string | null;
  answer_document_version_id: string | null;
  asked_at: Date;
  answered_at: Date | null;
}

export interface DraftInput {
  title: string;
  applicationNote: string;
  confidentiality: Confidentiality;
  jobType: JobType;
  materialSupply: MaterialSupply;
  changeReference: string;
  changeDescription: string;
  relatedEnquiryId: string | undefined;
  assistedIntake: boolean;
  deliverySiteId: string | undefined;
  requiredByDate: string | undefined;
  partialDelivery: 'allowed' | 'not_allowed';
  packagingNote: string;
  items: readonly EnquiryItemInput[];
  documents: readonly EnquiryDocumentInput[];
}

@Injectable()
export class EnquiryRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  async createDraft(
    input: { customerOrganizationId: string; createdBy: string; copiedFromEnquiryId?: string },
    tx?: Queryable,
  ): Promise<string> {
    const res = await this.q(tx).query<{ id: string }>(
      `INSERT INTO sourcing.enquiry (customer_organization_id, created_by, copied_from_enquiry_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [input.customerOrganizationId, input.createdBy, input.copiedFromEnquiryId ?? null],
    );
    return res.rows[0]!.id;
  }

  /**
   * The whole draft is rewritten each autosave, under the caller's version guard.
   * Items and document links are replaced rather than diffed: a draft is a form, and
   * a form's previous shape is not evidence of anything — only a frozen revision is.
   */
  async replaceDraft(enquiryId: string, input: DraftInput, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE sourcing.enquiry
          SET title = $2, application_note = $3, confidentiality = $4, assisted_intake = $5,
              delivery_site_id = $6, required_by_date = $7, partial_delivery = $8,
              packaging_note = $9, job_type = $10, material_supply = $11,
              change_reference = $12, change_description = $13, related_enquiry_id = $14,
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1`,
      [
        enquiryId,
        input.title,
        input.applicationNote,
        input.confidentiality,
        input.assistedIntake,
        input.deliverySiteId ?? null,
        input.requiredByDate ?? null,
        input.partialDelivery,
        input.packagingNote,
        input.jobType,
        input.materialSupply,
        input.changeReference,
        input.changeDescription,
        input.relatedEnquiryId ?? null,
      ],
    );

    await tx.query(`DELETE FROM sourcing.enquiry_item WHERE enquiry_id = $1`, [enquiryId]);
    const itemIdByLine = new Map<number, string>();
    for (const item of input.items) {
      const res = await tx.query<{ id: string }>(
        `INSERT INTO sourcing.enquiry_item
           (enquiry_id, line_no, part_name, part_number, description, process_capability_id,
            material_capability_id, material_grade, material_source_restriction,
            quantity_breakpoints, tolerance_class, critical_tolerance, surface_finish,
            heat_treatment, coating, inspection_level, quality_note, target_date, delivery_site_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id`,
        [
          enquiryId,
          item.lineNo,
          item.partName,
          item.partNumber ?? null,
          item.description,
          item.processCapabilityId ?? null,
          item.materialCapabilityId ?? null,
          item.materialGrade ?? null,
          item.materialSourceRestriction ?? null,
          JSON.stringify(item.quantityBreakpoints),
          item.toleranceClass ?? null,
          item.criticalTolerance ? JSON.stringify(item.criticalTolerance) : null,
          item.surfaceFinish ?? null,
          item.heatTreatment ?? null,
          item.coating ?? null,
          item.inspectionLevel,
          item.qualityNote,
          item.targetDate ?? null,
          item.deliverySiteId ?? null,
        ],
      );
      itemIdByLine.set(item.lineNo, res.rows[0]!.id);
    }

    await tx.query(`DELETE FROM sourcing.enquiry_document WHERE enquiry_id = $1`, [enquiryId]);
    for (const doc of input.documents) {
      await tx.query(
        `INSERT INTO sourcing.enquiry_document
           (enquiry_id, enquiry_item_id, document_version_id, role, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          enquiryId,
          doc.lineNo !== undefined ? (itemIdByLine.get(doc.lineNo) ?? null) : null,
          doc.documentVersionId,
          doc.role,
          doc.note,
        ],
      );
    }
  }

  async find(enquiryId: string, tx?: Queryable): Promise<Enquiry | null> {
    const res = await this.q(tx).query<EnquiryRow>(
      `SELECT * FROM sourcing.enquiry WHERE id = $1`,
      [enquiryId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return this.hydrate(row, tx);
  }

  /** Locks the row for the life of the transaction — the concurrent-edit guard's teeth. */
  async findForUpdate(enquiryId: string, tx: Queryable): Promise<Enquiry | null> {
    const res = await tx.query<EnquiryRow>(
      `SELECT * FROM sourcing.enquiry WHERE id = $1 FOR UPDATE`,
      [enquiryId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return this.hydrate(row, tx);
  }

  private async hydrate(row: EnquiryRow, tx?: Queryable): Promise<Enquiry> {
    const q = this.q(tx);
    const [items, documents, clarifications] = await Promise.all([
      q.query<ItemRow>(
        `SELECT * FROM sourcing.enquiry_item WHERE enquiry_id = $1 ORDER BY line_no`,
        [row.id],
      ),
      q.query<DocumentRow & { item_line_no: number | null }>(
        `SELECT d.id, d.document_version_id, d.role, d.note, i.line_no AS line_no
           FROM sourcing.enquiry_document d
           LEFT JOIN sourcing.enquiry_item i ON i.id = d.enquiry_item_id
          WHERE d.enquiry_id = $1
          ORDER BY d.created_at`,
        [row.id],
      ),
      q.query<ClarificationRow>(
        `SELECT c.id, c.sequence_no, c.round_no, c.topic, c.question, i.line_no,
                c.asked_against_revision_no, c.status, c.answer, c.answer_document_version_id,
                c.asked_at, c.answered_at
           FROM sourcing.clarification c
           LEFT JOIN sourcing.enquiry_item i ON i.id = c.enquiry_item_id
          WHERE c.enquiry_id = $1
          ORDER BY c.sequence_no`,
        [row.id],
      ),
    ]);

    return {
      enquiryId: row.id,
      reference: row.reference,
      customerOrganizationId: row.customer_organization_id,
      title: row.title,
      applicationNote: row.application_note,
      status: row.status,
      confidentiality: row.confidentiality,
      jobType: row.job_type,
      materialSupply: row.material_supply,
      changeReference: row.change_reference,
      changeDescription: row.change_description,
      relatedEnquiryId: row.related_enquiry_id,
      assistedIntake: row.assisted_intake,
      deliverySiteId: row.delivery_site_id,
      requiredByDate: row.required_by_date,
      partialDelivery: row.partial_delivery,
      packagingNote: row.packaging_note,
      submittedRevisionNo: row.submitted_revision_no,
      currentRevisionNo: row.current_revision_no,
      aggregateVersion: row.aggregate_version,
      copiedFromEnquiryId: row.copied_from_enquiry_id,
      submittedAt: row.submitted_at ? row.submitted_at.toISOString() : null,
      decisionReason: row.decision_reason,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      items: items.rows.map(
        (item): EnquiryItem => ({
          enquiryItemId: item.id,
          lineNo: item.line_no,
          partName: item.part_name,
          ...(item.part_number ? { partNumber: item.part_number } : {}),
          description: item.description,
          ...(item.process_capability_id
            ? { processCapabilityId: item.process_capability_id }
            : {}),
          ...(item.material_capability_id
            ? { materialCapabilityId: item.material_capability_id }
            : {}),
          ...(item.material_grade ? { materialGrade: item.material_grade } : {}),
          ...(item.material_source_restriction
            ? { materialSourceRestriction: item.material_source_restriction }
            : {}),
          quantityBreakpoints: item.quantity_breakpoints,
          ...(item.tolerance_class ? { toleranceClass: item.tolerance_class } : {}),
          ...(item.critical_tolerance ? { criticalTolerance: item.critical_tolerance } : {}),
          ...(item.surface_finish ? { surfaceFinish: item.surface_finish } : {}),
          ...(item.heat_treatment ? { heatTreatment: item.heat_treatment } : {}),
          ...(item.coating ? { coating: item.coating } : {}),
          inspectionLevel: item.inspection_level,
          qualityNote: item.quality_note,
          ...(item.target_date ? { targetDate: item.target_date } : {}),
          ...(item.delivery_site_id ? { deliverySiteId: item.delivery_site_id } : {}),
        }),
      ),
      documents: documents.rows.map(
        (doc): EnquiryDocument => ({
          enquiryDocumentId: doc.id,
          documentVersionId: doc.document_version_id,
          lineNo: doc.line_no,
          role: doc.role,
          note: doc.note,
        }),
      ),
      clarifications: clarifications.rows.map(
        (c): Clarification => ({
          clarificationId: c.id,
          sequenceNo: c.sequence_no,
          roundNo: c.round_no,
          topic: c.topic,
          question: c.question,
          lineNo: c.line_no,
          askedAgainstRevisionNo: c.asked_against_revision_no,
          status: c.status,
          answer: c.answer,
          answerDocumentVersionId: c.answer_document_version_id,
          askedAt: c.asked_at.toISOString(),
          answeredAt: c.answered_at ? c.answered_at.toISOString() : null,
        }),
      ),
    };
  }

  async listForOrganization(organizationId: string, limit: number): Promise<Enquiry[]> {
    const res = await this.db.pool.query<EnquiryRow>(
      `SELECT * FROM sourcing.enquiry
        WHERE customer_organization_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [organizationId, limit],
    );
    return Promise.all(res.rows.map((row) => this.hydrate(row)));
  }

  /** The intake queue: what is waiting on JobWork, oldest submission first (doc 14 §6). */
  async listTriageQueue(limit: number): Promise<Enquiry[]> {
    const res = await this.db.pool.query<EnquiryRow>(
      `SELECT * FROM sourcing.enquiry
        WHERE status IN ('submitted', 'under_review', 'clarification_required')
        ORDER BY submitted_at ASC NULLS LAST LIMIT $1`,
      [limit],
    );
    return Promise.all(res.rows.map((row) => this.hydrate(row)));
  }

  /**
   * Allocates the customer-visible reference at submit. The year and a per-year counter
   * derived from what already exists, taken under the enquiry row lock the caller holds.
   */
  async allocateReference(tx: Queryable, now: Date): Promise<string> {
    const year = now.getUTCFullYear();
    const res = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(NULLIF(split_part(reference, '-', 3), '')::int), 0) + 1 AS next
         FROM sourcing.enquiry
        WHERE reference LIKE $1`,
      [`ENQ-${year}-%`],
    );
    return `ENQ-${year}-${String(res.rows[0]!.next).padStart(4, '0')}`;
  }

  async transition(
    enquiryId: string,
    to: EnquiryStatus,
    patch: {
      reference?: string;
      submittedBy?: string;
      submittedAt?: Date;
      decidedBy?: string;
      decisionReason?: string;
      submittedRevisionNo?: number;
      currentRevisionNo?: number;
    },
    tx: Queryable,
  ): Promise<number> {
    const res = await tx.query<{ aggregate_version: number }>(
      `UPDATE sourcing.enquiry
          SET status = $2,
              reference = COALESCE($3, reference),
              submitted_by = COALESCE($4, submitted_by),
              submitted_at = COALESCE($5, submitted_at),
              decided_by = COALESCE($6, decided_by),
              decided_at = CASE WHEN $6::uuid IS NULL THEN decided_at ELSE now() END,
              decision_reason = COALESCE($7, decision_reason),
              submitted_revision_no = COALESCE($8, submitted_revision_no),
              current_revision_no = COALESCE($9, current_revision_no),
              aggregate_version = aggregate_version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING aggregate_version`,
      [
        enquiryId,
        to,
        patch.reference ?? null,
        patch.submittedBy ?? null,
        patch.submittedAt ?? null,
        patch.decidedBy ?? null,
        patch.decisionReason ?? null,
        patch.submittedRevisionNo ?? null,
        patch.currentRevisionNo ?? null,
      ],
    );
    return res.rows[0]!.aggregate_version;
  }

  /**
   * Freezes the enquiry as it reads right now into an append-only revision.
   * The hash is over the canonical snapshot so a citation of revision N can be proved,
   * not merely trusted.
   */
  async freezeRequirement(
    input: { enquiryId: string; kind: 'intake' | 'reviewed'; frozenBy: string; snapshot: unknown },
    tx: Queryable,
  ): Promise<RequirementRevision> {
    const previous = await tx.query<{ id: string; revision_no: number }>(
      `SELECT id, revision_no FROM sourcing.requirement
        WHERE enquiry_id = $1 ORDER BY revision_no DESC LIMIT 1`,
      [input.enquiryId],
    );
    const revisionNo = (previous.rows[0]?.revision_no ?? 0) + 1;
    const canonical = JSON.stringify(input.snapshot);
    const contentHash = createHash('sha256').update(canonical).digest('hex');

    const res = await tx.query<{ id: string; frozen_at: Date }>(
      `INSERT INTO sourcing.requirement
         (enquiry_id, revision_no, kind, snapshot, content_hash, supersedes_id, frozen_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING id, frozen_at`,
      [
        input.enquiryId,
        revisionNo,
        input.kind,
        canonical,
        contentHash,
        previous.rows[0]?.id ?? null,
        input.frozenBy,
      ],
    );

    return {
      requirementId: res.rows[0]!.id,
      revisionNo,
      kind: input.kind,
      contentHash,
      frozenAt: res.rows[0]!.frozen_at.toISOString(),
      snapshot: input.snapshot,
    };
  }

  /** The revision a new sourcing round quotes against: the newest frozen one. */
  async latestRequirement(
    enquiryId: string,
    tx?: Queryable,
  ): Promise<{ id: string; revisionNo: number; contentHash: string } | null> {
    const res = await this.q(tx).query(
      `SELECT id, revision_no, content_hash FROM sourcing.requirement
        WHERE enquiry_id = $1 ORDER BY revision_no DESC LIMIT 1`,
      [enquiryId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row
      ? {
          id: row['id'] as string,
          revisionNo: row['revision_no'] as number,
          contentHash: row['content_hash'] as string,
        }
      : null;
  }

  async listRevisions(enquiryId: string): Promise<RequirementRevision[]> {
    const res = await this.db.pool.query<{
      id: string;
      revision_no: number;
      kind: 'intake' | 'reviewed';
      content_hash: string;
      frozen_at: Date;
      snapshot: unknown;
    }>(
      `SELECT id, revision_no, kind, content_hash, frozen_at, snapshot
         FROM sourcing.requirement WHERE enquiry_id = $1 ORDER BY revision_no`,
      [enquiryId],
    );
    return res.rows.map((row) => ({
      requirementId: row.id,
      revisionNo: row.revision_no,
      kind: row.kind,
      contentHash: row.content_hash,
      frozenAt: row.frozen_at.toISOString(),
      snapshot: row.snapshot,
    }));
  }

  async appendClarifications(
    input: {
      enquiryId: string;
      askedBy: string;
      askedAgainstRevisionNo: number;
      questions: readonly { topic: ClarificationTopic; question: string; lineNo?: number }[];
    },
    tx: Queryable,
  ): Promise<Clarification[]> {
    const last = await tx.query<{ sequence_no: number; round_no: number }>(
      `SELECT sequence_no, round_no FROM sourcing.clarification
        WHERE enquiry_id = $1 ORDER BY sequence_no DESC LIMIT 1`,
      [input.enquiryId],
    );
    let sequenceNo = last.rows[0]?.sequence_no ?? 0;
    const roundNo = (last.rows[0]?.round_no ?? 0) + 1;

    const created: Clarification[] = [];
    for (const question of input.questions) {
      sequenceNo += 1;
      const res = await tx.query<{ id: string; asked_at: Date }>(
        `INSERT INTO sourcing.clarification
           (enquiry_id, enquiry_item_id, sequence_no, round_no, topic, question,
            asked_against_revision_no, asked_by)
         VALUES ($1,
                 (SELECT id FROM sourcing.enquiry_item WHERE enquiry_id = $1 AND line_no = $2),
                 $3, $4, $5, $6, $7, $8)
         RETURNING id, asked_at`,
        [
          input.enquiryId,
          question.lineNo ?? null,
          sequenceNo,
          roundNo,
          question.topic,
          question.question,
          input.askedAgainstRevisionNo,
          input.askedBy,
        ],
      );
      created.push({
        clarificationId: res.rows[0]!.id,
        sequenceNo,
        roundNo,
        topic: question.topic,
        question: question.question,
        lineNo: question.lineNo ?? null,
        askedAgainstRevisionNo: input.askedAgainstRevisionNo,
        status: 'open',
        answer: null,
        answerDocumentVersionId: null,
        askedAt: res.rows[0]!.asked_at.toISOString(),
        answeredAt: null,
      });
    }
    return created;
  }

  async answerClarification(
    input: {
      clarificationId: string;
      enquiryId: string;
      answer: string;
      answerDocumentVersionId: string | undefined;
      answeredBy: string;
    },
    tx: Queryable,
  ): Promise<boolean> {
    const res = await tx.query(
      `UPDATE sourcing.clarification
          SET status = 'answered', answer = $3, answer_document_version_id = $4,
              answered_by = $5, answered_at = now()
        WHERE id = $1 AND enquiry_id = $2 AND status = 'open'`,
      [
        input.clarificationId,
        input.enquiryId,
        input.answer,
        input.answerDocumentVersionId ?? null,
        input.answeredBy,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setGoverningDocument(
    enquiryId: string,
    documentVersionId: string,
    tx: Queryable,
  ): Promise<boolean> {
    await tx.query(
      `UPDATE sourcing.enquiry_document SET role = 'reference'
        WHERE enquiry_id = $1 AND role = 'governing'`,
      [enquiryId],
    );
    const res = await tx.query(
      `UPDATE sourcing.enquiry_document SET role = 'governing'
        WHERE enquiry_id = $1 AND document_version_id = $2`,
      [enquiryId, documentVersionId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * The logical types behind an enquiry's document links, for the CAD/2D conflict
   * check. Only ids and types — no filenames, no owning organization.
   */
  async documentTypes(enquiryId: string, tx?: Queryable): Promise<Map<string, string>> {
    const res = await this.q(tx).query<{ document_version_id: string; logical_type: string }>(
      `SELECT ed.document_version_id, d.logical_type
         FROM sourcing.enquiry_document ed
         JOIN dms.document_version dv ON dv.id = ed.document_version_id
         JOIN dms.document d ON d.id = dv.document_id
        WHERE ed.enquiry_id = $1`,
      [enquiryId],
    );
    return new Map(res.rows.map((row) => [row.document_version_id, row.logical_type]));
  }

  /** Capability codes for the ids an enquiry's lines name (matching reads codes). */
  async capabilityCodesFor(capabilityIds: readonly string[], tx?: Queryable): Promise<string[]> {
    if (capabilityIds.length === 0) return [];
    const res = await this.q(tx).query<{ code: string }>(
      `SELECT code FROM supplier.capability WHERE id = ANY($1::uuid[]) ORDER BY code`,
      [[...capabilityIds]],
    );
    return res.rows.map((row) => row.code);
  }

  /** Display name for an internal-audience view; never used on a customer payload. */
  async organizationName(organizationId: string, tx?: Queryable): Promise<string> {
    const res = await this.q(tx).query<{ display_name: string }>(
      `SELECT display_name FROM iam.organization WHERE id = $1`,
      [organizationId],
    );
    return res.rows[0]?.display_name ?? '';
  }

  /**
   * A correction may only point at the customer's own enquiry. Same answer for
   * "not yours" and "does not exist", so the check cannot be used to probe for ids.
   */
  async enquiryBelongsTo(
    enquiryId: string,
    organizationId: string,
    tx?: Queryable,
  ): Promise<boolean> {
    const res = await this.q(tx).query(
      `SELECT 1 FROM sourcing.enquiry WHERE id = $1 AND customer_organization_id = $2`,
      [enquiryId, organizationId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** The address book check behind `FR-301`. */
  async siteBelongsTo(siteId: string, organizationId: string, tx?: Queryable): Promise<boolean> {
    const res = await this.q(tx).query(
      `SELECT 1 FROM iam.organization_site WHERE id = $1 AND organization_id = $2`,
      [siteId, organizationId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * A document link is only accepted if the customer organization owns the document and
   * the scanner cleared it — the same rule supplier evidence obeys (`BR-ENG-08`).
   */
  async documentsUsable(
    documentVersionIds: readonly string[],
    organizationId: string,
    tx?: Queryable,
  ): Promise<{ usable: boolean; reason: string }> {
    if (documentVersionIds.length === 0) return { usable: true, reason: '' };
    const res = await this.q(tx).query<{
      id: string;
      owning_organization_id: string;
      status: string;
      scan_state: string;
    }>(
      `SELECT dv.id, d.owning_organization_id, dv.status, f.scan_state
         FROM dms.document_version dv
         JOIN dms.document d ON d.id = dv.document_id
         JOIN dms.file_object f ON f.id = dv.file_object_id
        WHERE dv.id = ANY($1::uuid[])`,
      [[...documentVersionIds]],
    );
    if (res.rows.length !== new Set(documentVersionIds).size) {
      return { usable: false, reason: 'One of the attached documents does not exist' };
    }
    for (const row of res.rows) {
      if (row.owning_organization_id !== organizationId) {
        return { usable: false, reason: 'A document belongs to another organization' };
      }
      if (row.scan_state !== 'clean') {
        return { usable: false, reason: `A document is not cleared for use (${row.scan_state})` };
      }
      if (row.status === 'revoked') {
        return { usable: false, reason: 'A document has been withdrawn' };
      }
    }
    return { usable: true, reason: '' };
  }
}
