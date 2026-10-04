import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DatabaseService } from '../../../platform/database/database.service';
import type {
  VerificationKind,
  VerificationSnapshot,
  VerificationStatus,
} from '../domain/verification';

type Queryable = Pool | PoolClient;

export type SupplierNetworkStatusRow =
  | 'onboarding'
  | 'submitted'
  | 'active'
  | 'paused'
  | 'rejected'
  | 'exited';

export interface WorksSiteRow {
  siteId: string;
  label: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
  gstin: string | null;
  contactName: string;
  contactPhone: string;
}

export interface SupplierProfileRow {
  id: string;
  organizationId: string;
  organizationStatus: string;
  legalName: string;
  displayName: string;
  regionClass: string;
  summary: string;
  tradeName: string;
  website: string;
  yearEstablished: number | null;
  employeeBand: string | null;
  primaryContactName: string;
  primaryContactEmail: string;
  primaryContactPhone: string;
  worksSiteId: string | null;
  status: SupplierNetworkStatusRow;
  acceptingWork: boolean;
  acceptingWorkNote: string;
  acceptingWorkUntil: string | null;
  aggregateVersion: number;
  submittedAt: Date | null;
  submittedBy: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  updatedAt: Date;
}

export interface CertificationRow {
  id: string;
  certificationType: string;
  certificateNumber: string | null;
  issuer: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  status: 'declared' | 'verified' | 'expired' | 'revoked';
  evidenceDocumentVersionId: string | null;
}

export interface VerificationItemRow {
  id: string;
  supplierProfileId: string;
  kind: VerificationKind;
  versionNo: number;
  status: VerificationStatus;
  referenceValue: string | null;
  evidenceDocumentVersionId: string | null;
  expiresAt: Date | null;
  submittedBy: string | null;
  submittedAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewReason: string | null;
  aggregateVersion: number;
  createdAt: Date;
}

export interface CapabilityRow {
  id: string;
  code: string;
  kind: 'process' | 'material' | 'finish';
  label: string;
  status: 'active' | 'retired';
  /** Family this leaf belongs to; null for a family or an ungrouped capability. */
  parentId?: string | null;
  isFamily?: boolean;
}

export interface SupplierCapabilityRow {
  id: string;
  capabilityId: string;
  code: string;
  kind: 'process' | 'material' | 'finish';
  label: string;
  versionNo: number;
  status: 'published' | 'superseded' | 'withdrawn';
  attributes: Record<string, unknown>;
  validFrom: Date;
  validUntil: Date | null;
}

export interface MachineRow {
  id: string;
  machineKey: string;
  label: string;
  versionNo: number;
  status: 'published' | 'superseded' | 'withdrawn';
  quantity: number;
  axes: number | null;
  envelope: { xMm: number; yMm: number; zMm: number; maxWeightKg?: number | undefined };
  capability: { capabilityId: string; code: string; kind: string; label: string } | null;
}

export interface CapacityWindowRow {
  id: string;
  versionNo: number;
  status: 'published' | 'superseded' | 'withdrawn';
  windowStart: string;
  windowEnd: string;
  availableHours: number | null;
  note: string | null;
  capability: { capabilityId: string; code: string; kind: string; label: string } | null;
}

export interface VersionedRow {
  id: string;
  versionNo: number;
  status: 'published' | 'superseded' | 'withdrawn';
}

@Injectable()
export class SupplierRepository {
  constructor(private readonly db: DatabaseService) {}

  private client(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  async findProfileByOrganization(
    organizationId: string,
    tx?: Queryable,
  ): Promise<SupplierProfileRow | null> {
    const res = await this.client(tx).query(
      `SELECT p.*, o.status AS organization_status, o.legal_name, o.display_name
         FROM supplier.supplier_profile p
         JOIN iam.organization o ON o.id = p.organization_id
        WHERE p.organization_id = $1`,
      [organizationId],
    );
    const row = res.rows[0];
    return row ? mapProfile(row) : null;
  }

  async findProfile(profileId: string, tx?: Queryable): Promise<SupplierProfileRow | null> {
    const res = await this.client(tx).query(
      `SELECT p.*, o.status AS organization_status, o.legal_name, o.display_name
         FROM supplier.supplier_profile p
         JOIN iam.organization o ON o.id = p.organization_id
        WHERE p.id = $1`,
      [profileId],
    );
    const row = res.rows[0];
    return row ? mapProfile(row) : null;
  }

  /** Created on first use: a supplier organization has exactly one profile. */
  async ensureProfile(
    input: { organizationId: string; createdBy: string },
    tx: Queryable,
  ): Promise<SupplierProfileRow> {
    await this.client(tx).query(
      `INSERT INTO supplier.supplier_profile (organization_id, created_by)
       VALUES ($1, $2)
       ON CONFLICT (organization_id) DO NOTHING`,
      [input.organizationId, input.createdBy],
    );
    const profile = await this.findProfileByOrganization(input.organizationId, tx);
    if (!profile) throw new Error('supplier profile could not be created');
    return profile;
  }

  async lockProfile(profileId: string, tx: PoolClient): Promise<SupplierProfileRow | null> {
    const res = await tx.query(
      `SELECT p.*, o.status AS organization_status, o.legal_name, o.display_name
         FROM supplier.supplier_profile p
         JOIN iam.organization o ON o.id = p.organization_id
        WHERE p.id = $1
          FOR NO KEY UPDATE OF p`,
      [profileId],
    );
    const row = res.rows[0];
    return row ? mapProfile(row) : null;
  }

  /** Identity a supplier states about itself; never the states it is judged on. */
  async updateProfileDetails(
    input: {
      profileId: string;
      expectedVersion: number;
      tradeName: string;
      website: string;
      summary: string;
      regionClass: string;
      yearEstablished: number | null;
      employeeBand: string | null;
      primaryContactName: string;
      primaryContactEmail: string;
      primaryContactPhone: string;
    },
    tx: Queryable,
  ): Promise<SupplierProfileRow | null> {
    const res = await this.client(tx).query(
      `UPDATE supplier.supplier_profile
          SET trade_name = $3, website = $4, summary = $5, region_class = $6,
              year_established = $7, employee_band = $8, primary_contact_name = $9,
              primary_contact_email = $10, primary_contact_phone = $11,
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1 AND aggregate_version = $2
        RETURNING id`,
      [
        input.profileId,
        input.expectedVersion,
        input.tradeName,
        input.website,
        input.summary,
        input.regionClass,
        input.yearEstablished,
        input.employeeBand,
        input.primaryContactName,
        input.primaryContactEmail,
        input.primaryContactPhone,
      ],
    );
    if (res.rowCount === 0) return null;
    return this.findProfile(input.profileId, tx);
  }

  /**
   * One works site per supplier, updated in place: a supplier that moves is the same
   * supplier at a new address, and a second row would leave matching guessing which is
   * current. The composite foreign key keeps it inside the owning organization.
   */
  async upsertWorksSite(
    input: {
      profileId: string;
      organizationId: string;
      label: string;
      addressLine1: string;
      addressLine2: string;
      city: string;
      state: string;
      postalCode: string;
      gstin: string | null;
      contactName: string;
      contactPhone: string;
      createdBy: string;
      existingSiteId: string | null;
    },
    tx: Queryable,
  ): Promise<string> {
    const params = [
      input.organizationId,
      input.label,
      input.addressLine1,
      input.addressLine2,
      input.city,
      input.state,
      input.postalCode,
      input.gstin,
      input.contactName,
      input.contactPhone,
      input.createdBy,
    ];
    const siteId = input.existingSiteId
      ? (
          await this.client(tx).query<{ id: string }>(
            `UPDATE iam.organization_site
                SET label = $2, address_line1 = $3, address_line2 = $4, city = $5, state = $6,
                    postal_code = $7, gstin = $8, contact_name = $9, contact_phone = $10,
                    updated_at = now()
              WHERE id = $12 AND organization_id = $1
              RETURNING id`,
            [...params, input.existingSiteId],
          )
        ).rows[0]?.id
      : (
          await this.client(tx).query<{ id: string }>(
            `INSERT INTO iam.organization_site
               (organization_id, label, kind, address_line1, address_line2, city, state,
                postal_code, gstin, contact_name, contact_phone, created_by)
             VALUES ($1, $2, 'works', $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (organization_id, label) DO UPDATE
               SET address_line1 = EXCLUDED.address_line1,
                   address_line2 = EXCLUDED.address_line2,
                   city = EXCLUDED.city, state = EXCLUDED.state,
                   postal_code = EXCLUDED.postal_code, gstin = EXCLUDED.gstin,
                   contact_name = EXCLUDED.contact_name,
                   contact_phone = EXCLUDED.contact_phone, updated_at = now()
             RETURNING id`,
            params,
          )
        ).rows[0]?.id;
    if (!siteId) throw new Error('works site could not be written');
    await this.client(tx).query(
      `UPDATE supplier.supplier_profile
          SET works_site_id = $2, aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1`,
      [input.profileId, siteId],
    );
    return siteId;
  }

  async findWorksSite(siteId: string, tx?: Queryable): Promise<WorksSiteRow | null> {
    const res = await this.client(tx).query(
      `SELECT id, label, address_line1, address_line2, city, state, postal_code,
              country_code, gstin, contact_name, contact_phone
         FROM iam.organization_site WHERE id = $1`,
      [siteId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      siteId: row['id'] as string,
      label: row['label'] as string,
      addressLine1: row['address_line1'] as string,
      addressLine2: row['address_line2'] as string,
      city: row['city'] as string,
      state: row['state'] as string,
      postalCode: row['postal_code'] as string,
      countryCode: row['country_code'] as string,
      gstin: (row['gstin'] as string | null) ?? null,
      contactName: row['contact_name'] as string,
      contactPhone: row['contact_phone'] as string,
    };
  }

  /**
   * Network-state writes. `expectedVersion` is the caller's claim about what it read;
   * a mismatch returns null so the command can answer with a conflict rather than
   * overwrite a decision somebody else made a second earlier.
   */
  async setProfileStatus(
    input: {
      profileId: string;
      expectedVersion: number;
      status: SupplierNetworkStatusRow;
      submittedBy?: string | null;
      submittedAt?: Date | null;
      decidedBy?: string | null;
      decisionReason?: string | null;
    },
    tx: Queryable,
  ): Promise<SupplierProfileRow | null> {
    const decides = input.decidedBy !== undefined;
    const submits = input.submittedBy !== undefined;
    const res = await this.client(tx).query(
      `UPDATE supplier.supplier_profile
          SET status = $3,
              submitted_by = CASE WHEN $4 THEN $5 ELSE submitted_by END,
              submitted_for_approval_at = CASE WHEN $4 THEN $6 ELSE submitted_for_approval_at END,
              decided_by = CASE WHEN $7 THEN $8 ELSE decided_by END,
              decided_at = CASE WHEN $7 THEN now() ELSE decided_at END,
              decision_reason = CASE WHEN $7 THEN $9 ELSE decision_reason END,
              aggregate_version = aggregate_version + 1,
              updated_at = now()
        WHERE id = $1 AND aggregate_version = $2
        RETURNING id`,
      [
        input.profileId,
        input.expectedVersion,
        input.status,
        submits,
        input.submittedBy ?? null,
        input.submittedAt ?? null,
        decides,
        input.decidedBy ?? null,
        input.decisionReason ?? null,
      ],
    );
    if (res.rowCount === 0) return null;
    return this.findProfile(input.profileId, tx);
  }

  /** The supplier's own availability switch (F-SN). Never touches network status. */
  async setAvailability(
    input: {
      profileId: string;
      acceptingWork: boolean;
      note: string;
      acceptingWorkUntil: string | null;
    },
    tx: Queryable,
  ): Promise<SupplierProfileRow | null> {
    await this.client(tx).query(
      `UPDATE supplier.supplier_profile
          SET accepting_work = $2, accepting_work_note = $3, accepting_work_until = $4,
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1`,
      [input.profileId, input.acceptingWork, input.note, input.acceptingWorkUntil],
    );
    return this.findProfile(input.profileId, tx);
  }

  async exitNetwork(profileId: string, tx: Queryable): Promise<SupplierProfileRow | null> {
    await this.client(tx).query(
      `UPDATE supplier.supplier_profile
          SET status = 'exited', exited_at = now(), accepting_work = false,
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1 AND status <> 'exited'`,
      [profileId],
    );
    return this.findProfile(profileId, tx);
  }

  /**
   * Withdrawing a live declaration. The row is marked `withdrawn` rather than deleted:
   * an RFQ matched against version 2 must still be able to read version 2 (UC-11), and
   * the immutability trigger already refuses to touch a settled version.
   */
  async withdrawDeclaration(
    table: 'supplier_capability' | 'machine' | 'capacity_window',
    input: { id: string; supplierProfileId: string },
    tx: Queryable,
  ): Promise<boolean> {
    const res = await this.client(tx).query(
      `UPDATE supplier.${table}
          SET status = 'withdrawn'
        WHERE id = $1 AND supplier_profile_id = $2 AND status = 'published'`,
      [input.id, input.supplierProfileId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Duplicate admission guard. The same legal entity reaching the network twice is the
   * fraud signal Indian vendor-master practice warns about, and the identifier — not
   * the name — is what catches it.
   */
  async findSupplierByIdentity(
    references: readonly string[],
    tx?: Queryable,
  ): Promise<{ supplierProfileId: string; displayName: string; kind: string } | null> {
    if (references.length === 0) return null;
    const res = await this.client(tx).query(
      `SELECT v.supplier_profile_id, o.display_name, v.kind
         FROM supplier.verification_item v
         JOIN supplier.supplier_profile p ON p.id = v.supplier_profile_id
         JOIN iam.organization o ON o.id = p.organization_id
        WHERE v.kind IN ('gst', 'pan')
          AND upper(v.reference_value) = ANY($1::text[])
          -- Any status counts, including the draft an admission records and the expired
          -- item nobody renewed: this asks who the company *is*, not whether its
          -- paperwork is current. A revoked certificate still names the same entity.
        LIMIT 1`,
      [references.map((r) => r.toUpperCase())],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row
      ? {
          supplierProfileId: row['supplier_profile_id'] as string,
          displayName: row['display_name'] as string,
          kind: row['kind'] as string,
        }
      : null;
  }

  async createProfile(
    input: {
      organizationId: string;
      createdBy: string;
      regionClass: string;
      tradeName: string;
      primaryContactName: string;
      primaryContactEmail: string;
      primaryContactPhone: string;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await this.client(tx).query<{ id: string }>(
      `INSERT INTO supplier.supplier_profile
         (organization_id, created_by, region_class, trade_name,
          primary_contact_name, primary_contact_email, primary_contact_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.organizationId,
        input.createdBy,
        input.regionClass,
        input.tradeName,
        input.primaryContactName,
        input.primaryContactEmail,
        input.primaryContactPhone,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('supplier profile insert returned no row');
    return row.id;
  }

  // ---------------------------------------------------------------- certifications

  async listCertifications(profileId: string, tx?: Queryable): Promise<CertificationRow[]> {
    const res = await this.client(tx).query(
      `SELECT id, certification_type, certificate_number, issuer, issued_on, expires_on,
              status, evidence_document_version_id
         FROM supplier.certification
        WHERE supplier_profile_id = $1
        ORDER BY certification_type`,
      [profileId],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      id: row['id'] as string,
      certificationType: row['certification_type'] as string,
      certificateNumber: (row['certificate_number'] as string | null) ?? null,
      issuer: (row['issuer'] as string | null) ?? null,
      issuedOn: (row['issued_on'] as string | null) ?? null,
      expiresOn: (row['expires_on'] as string | null) ?? null,
      status: row['status'] as CertificationRow['status'],
      evidenceDocumentVersionId: (row['evidence_document_version_id'] as string | null) ?? null,
    }));
  }

  /** One row per certification type per supplier; re-declaring restates the same row. */
  async upsertCertification(
    input: {
      profileId: string;
      certificationType: string;
      certificateNumber: string | null;
      issuer: string | null;
      issuedOn: string | null;
      expiresOn: string | null;
      evidenceDocumentVersionId: string | null;
      createdBy: string;
    },
    tx: Queryable,
  ): Promise<CertificationRow> {
    const existing = await this.client(tx).query<{ id: string }>(
      `SELECT id FROM supplier.certification
        WHERE supplier_profile_id = $1 AND certification_type = $2
        ORDER BY created_at DESC LIMIT 1`,
      [input.profileId, input.certificationType],
    );
    const id = existing.rows[0]?.id;
    if (id) {
      await this.client(tx).query(
        `UPDATE supplier.certification
            SET certificate_number = $2, issuer = $3, issued_on = $4, expires_on = $5,
                evidence_document_version_id = $6, status = 'declared', updated_at = now()
          WHERE id = $1`,
        [
          id,
          input.certificateNumber,
          input.issuer,
          input.issuedOn,
          input.expiresOn,
          input.evidenceDocumentVersionId,
        ],
      );
    } else {
      await this.client(tx).query(
        `INSERT INTO supplier.certification
           (supplier_profile_id, certification_type, certificate_number, issuer, issued_on,
            expires_on, evidence_document_version_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.profileId,
          input.certificationType,
          input.certificateNumber,
          input.issuer,
          input.issuedOn,
          input.expiresOn,
          input.evidenceDocumentVersionId,
          input.createdBy,
        ],
      );
    }
    const rows = await this.listCertifications(input.profileId, tx);
    const row = rows.find((r) => r.certificationType === input.certificationType);
    if (!row) throw new Error('certification could not be written');
    return row;
  }

  /** Internal directory: every supplier with the counts a reviewer triages on. */
  async listProfiles(
    filter: { status?: string | undefined },
    tx?: Queryable,
  ): Promise<Array<SupplierProfileRow & { capabilityCount: number }>> {
    const res = await this.client(tx).query(
      `SELECT p.*, o.status AS organization_status, o.legal_name, o.display_name,
              (SELECT count(*)::int FROM supplier.supplier_capability sc
                WHERE sc.supplier_profile_id = p.id AND sc.status = 'published')
                AS capability_count
         FROM supplier.supplier_profile p
         JOIN iam.organization o ON o.id = p.organization_id
        WHERE ($1::text IS NULL OR p.status = $1)
        ORDER BY p.updated_at DESC
        LIMIT 200`,
      [filter.status ?? null],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      ...mapProfile(row),
      capabilityCount: row['capability_count'] as number,
    }));
  }

  // ---------------------------------------------------------------- verification

  async findVerificationItem(id: string, tx?: Queryable): Promise<VerificationItemRow | null> {
    const res = await this.client(tx).query(
      `SELECT * FROM supplier.verification_item WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? mapVerification(row) : null;
  }

  async lockVerificationItem(id: string, tx: PoolClient): Promise<VerificationItemRow | null> {
    const res = await tx.query(
      `SELECT * FROM supplier.verification_item WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = res.rows[0];
    return row ? mapVerification(row) : null;
  }

  async findLatestVerification(
    supplierProfileId: string,
    kind: VerificationKind,
    tx?: Queryable,
  ): Promise<VerificationItemRow | null> {
    const res = await this.client(tx).query(
      `SELECT * FROM supplier.verification_item
        WHERE supplier_profile_id = $1 AND kind = $2
        ORDER BY version_no DESC
        LIMIT 1`,
      [supplierProfileId, kind],
    );
    const row = res.rows[0];
    return row ? mapVerification(row) : null;
  }

  /**
   * Re-verification appends a new version rather than reopening a settled one, so the
   * history of what was true when an RFQ ran stays intact (doc 06 §14).
   */
  async appendVerificationItem(
    input: {
      supplierProfileId: string;
      kind: VerificationKind;
      versionNo: number;
      referenceValue: string | null;
      evidenceDocumentVersionId: string | null;
      expiresAt: Date | null;
      submittedBy: string | null;
      supersedesId: string | null;
      /** `draft` is for an identity JobWork recorded at admission and nobody has backed
       *  with evidence yet; the supplier's own submission is always `submitted`. */
      status?: 'draft' | 'submitted';
    },
    tx: Queryable,
  ): Promise<VerificationItemRow> {
    const status = input.status ?? 'submitted';
    const res = await this.client(tx).query(
      `INSERT INTO supplier.verification_item
         (supplier_profile_id, kind, version_no, status, reference_value,
          evidence_document_version_id, expires_at, submitted_by, submitted_at,
          supersedes_id, created_by)
       VALUES ($1, $2, $3, $9, $4, $5, $6, $7,
               CASE WHEN $9 = 'submitted' THEN now() ELSE NULL END, $8, $7)
       RETURNING *`,
      [
        input.supplierProfileId,
        input.kind,
        input.versionNo,
        input.referenceValue,
        input.evidenceDocumentVersionId,
        input.expiresAt,
        input.submittedBy,
        input.supersedesId,
        status,
      ],
    );
    return mapVerification(res.rows[0]);
  }

  async setVerificationStatus(
    input: {
      id: string;
      status: VerificationStatus;
      reviewedBy?: string | null;
      reviewReason?: string | null;
      expiresAt?: Date | null;
    },
    tx: Queryable,
  ): Promise<VerificationItemRow> {
    const reviewed = input.reviewedBy ?? null;
    const res = await this.client(tx).query(
      `UPDATE supplier.verification_item
          SET status = $2,
              reviewed_by = COALESCE($3, reviewed_by),
              reviewed_at = CASE WHEN $3 IS NULL THEN reviewed_at ELSE now() END,
              review_reason = COALESCE($4, review_reason),
              expires_at = COALESCE($5, expires_at),
              aggregate_version = aggregate_version + 1,
              updated_at = now()
        WHERE id = $1
      RETURNING *`,
      [input.id, input.status, reviewed, input.reviewReason ?? null, input.expiresAt ?? null],
    );
    return mapVerification(res.rows[0]);
  }

  async listVerificationItems(supplierProfileId: string): Promise<VerificationItemRow[]> {
    const res = await this.db.pool.query(
      `SELECT * FROM supplier.verification_item
        WHERE supplier_profile_id = $1
        ORDER BY kind, version_no DESC`,
      [supplierProfileId],
    );
    return res.rows.map(mapVerification);
  }

  /** The operations review queue: what is waiting on a reviewer, oldest first. */
  async listReviewQueue(limit: number): Promise<
    Array<VerificationItemRow & { organizationName: string; organizationId: string }>
  > {
    const res = await this.db.pool.query(
      `SELECT v.*, o.display_name AS organization_name, o.id AS organization_id
         FROM supplier.verification_item v
         JOIN supplier.supplier_profile p ON p.id = v.supplier_profile_id
         JOIN iam.organization o ON o.id = p.organization_id
        WHERE v.status IN ('submitted', 'under_review')
        ORDER BY v.submitted_at
        LIMIT $1`,
      [limit],
    );
    return res.rows.map((row) => ({
      ...mapVerification(row),
      organizationName: row.organization_name,
      organizationId: row.organization_id,
    }));
  }

  /** Snapshot for the hard filter: the newest item per kind decides. */
  async verificationSnapshot(
    supplierProfileId: string,
    tx?: Queryable,
  ): Promise<VerificationSnapshot[]> {
    const res = await this.client(tx).query(
      `SELECT DISTINCT ON (kind) kind, status, expires_at
         FROM supplier.verification_item
        WHERE supplier_profile_id = $1
        ORDER BY kind, version_no DESC`,
      [supplierProfileId],
    );
    return res.rows.map((row) => ({
      kind: row.kind as VerificationKind,
      status: row.status as VerificationStatus,
      expiresAt: (row.expires_at as Date | null) ?? null,
    }));
  }

  /**
   * Items whose stored expiry has passed. Driven by data, not by a timer that could
   * drift: whatever the schedule does or does not run, the query is the truth.
   */
  async findExpiredVerifications(
    now: Date,
    limit: number,
    tx: Queryable,
  ): Promise<VerificationItemRow[]> {
    const res = await this.client(tx).query(
      `SELECT * FROM supplier.verification_item
        WHERE status IN ('verified', 'expiring')
          AND expires_at IS NOT NULL
          AND expires_at <= $1
        ORDER BY expires_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return res.rows.map(mapVerification);
  }

  /** Verified items entering the warning window, so a renewal can be asked for. */
  async findExpiringVerifications(
    now: Date,
    threshold: Date,
    limit: number,
    tx: Queryable,
  ): Promise<VerificationItemRow[]> {
    const res = await this.client(tx).query(
      `SELECT * FROM supplier.verification_item
        WHERE status = 'verified'
          AND expires_at IS NOT NULL
          AND expires_at > $1
          AND expires_at <= $2
        ORDER BY expires_at
        LIMIT $3
        FOR UPDATE SKIP LOCKED`,
      [now, threshold, limit],
    );
    return res.rows.map(mapVerification);
  }

  async countPublishedCapabilities(supplierProfileId: string, tx?: Queryable): Promise<number> {
    const res = await this.client(tx).query(
      `SELECT count(*)::int AS n FROM supplier.supplier_capability
        WHERE supplier_profile_id = $1 AND status = 'published'`,
      [supplierProfileId],
    );
    return (res.rows[0] as { n: number } | undefined)?.n ?? 0;
  }

  // ------------------------------------------------------ capability / machine / capacity

  async findCapabilityByCode(code: string, tx?: Queryable): Promise<CapabilityRow | null> {
    const res = await this.client(tx).query(
      `SELECT id, code, kind, label, status FROM supplier.capability WHERE code = $1`,
      [code],
    );
    const row = res.rows[0];
    return row
      ? {
          id: row.id,
          code: row.code,
          kind: row.kind,
          label: row.label,
          status: row.status,
        }
      : null;
  }

  /**
   * Publishing an edit supersedes the live version and appends a new one. The old row
   * is never touched — an RFQ that matched against version 2 keeps reading version 2
   * (UC-11), which a database trigger also enforces.
   */
  async publishCapabilityVersion(
    input: {
      supplierProfileId: string;
      capabilityId: string;
      attributes: Record<string, unknown>;
      evidenceDocumentVersionId: string | null;
      validUntil: Date | null;
      createdBy: string;
    },
    tx: PoolClient,
  ): Promise<SupplierCapabilityRow> {
    // Two different questions: which row is live (to supersede), and what the highest
    // version ever was (to number the new one). Deriving the number from the live row
    // alone breaks the moment a declaration is withdrawn — there is no live row, the
    // count restarts at 1, and the unique version constraint refuses the re-offer.
    const live = await tx.query(
      `SELECT id, version_no FROM supplier.supplier_capability
        WHERE supplier_profile_id = $1 AND capability_id = $2 AND status = 'published'
        FOR UPDATE`,
      [input.supplierProfileId, input.capabilityId],
    );
    const highest = await tx.query<{ version_no: number }>(
      `SELECT max(version_no) AS version_no FROM supplier.supplier_capability
        WHERE supplier_profile_id = $1 AND capability_id = $2`,
      [input.supplierProfileId, input.capabilityId],
    );
    const previous = live.rows[0] as { id: string; version_no: number } | undefined;
    const nextVersion = (highest.rows[0]?.version_no ?? 0) + 1;
    if (previous) {
      await tx.query(
        `UPDATE supplier.supplier_capability SET status = 'superseded' WHERE id = $1`,
        [previous.id],
      );
    }
    const res = await tx.query(
      `INSERT INTO supplier.supplier_capability
         (supplier_profile_id, capability_id, version_no, attributes,
          evidence_document_version_id, valid_until, supersedes_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.supplierProfileId,
        input.capabilityId,
        nextVersion,
        JSON.stringify(input.attributes),
        input.evidenceDocumentVersionId,
        input.validUntil,
        previous?.id ?? null,
        input.createdBy,
      ],
    );
    return mapSupplierCapability(res.rows[0]);
  }

  async publishMachineVersion(
    input: {
      supplierProfileId: string;
      machineKey: string;
      label: string;
      capabilityId: string | null;
      quantity: number;
      axes: number | null;
      envelope: MachineRow['envelope'];
      createdBy: string;
    },
    tx: PoolClient,
  ): Promise<MachineRow> {
    const live = await tx.query(
      `SELECT id, version_no FROM supplier.machine
        WHERE supplier_profile_id = $1 AND machine_key = $2 AND status = 'published'
        FOR UPDATE`,
      [input.supplierProfileId, input.machineKey],
    );
    const highest = await tx.query<{ version_no: number }>(
      `SELECT max(version_no) AS version_no FROM supplier.machine
        WHERE supplier_profile_id = $1 AND machine_key = $2`,
      [input.supplierProfileId, input.machineKey],
    );
    const previous = live.rows[0] as { id: string; version_no: number } | undefined;
    const nextVersion = (highest.rows[0]?.version_no ?? 0) + 1;
    if (previous) {
      await tx.query(`UPDATE supplier.machine SET status = 'superseded' WHERE id = $1`, [
        previous.id,
      ]);
    }
    const res = await tx.query(
      `INSERT INTO supplier.machine
         (supplier_profile_id, capability_id, machine_key, version_no, label, quantity,
          axes, envelope, supersedes_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.supplierProfileId,
        input.capabilityId,
        input.machineKey,
        nextVersion,
        input.label,
        input.quantity,
        input.axes,
        JSON.stringify(input.envelope),
        previous?.id ?? null,
        input.createdBy,
      ],
    );
    return mapMachine(res.rows[0]);
  }

  async publishCapacityVersion(
    input: {
      supplierProfileId: string;
      capabilityId: string | null;
      windowStart: string;
      windowEnd: string;
      availableHours: number | null;
      note: string | null;
      createdBy: string;
    },
    tx: PoolClient,
  ): Promise<CapacityWindowRow> {
    const live = await tx.query(
      `SELECT id, version_no FROM supplier.capacity_window
        WHERE supplier_profile_id = $1
          AND capability_id IS NOT DISTINCT FROM $2
          AND window_start = $3 AND window_end = $4
          AND status = 'published'
        FOR UPDATE`,
      [input.supplierProfileId, input.capabilityId, input.windowStart, input.windowEnd],
    );
    const highest = await tx.query<{ version_no: number }>(
      `SELECT max(version_no) AS version_no FROM supplier.capacity_window
        WHERE supplier_profile_id = $1
          AND capability_id IS NOT DISTINCT FROM $2
          AND window_start = $3 AND window_end = $4`,
      [input.supplierProfileId, input.capabilityId, input.windowStart, input.windowEnd],
    );
    const previous = live.rows[0] as { id: string; version_no: number } | undefined;
    const nextVersion = (highest.rows[0]?.version_no ?? 0) + 1;
    if (previous) {
      await tx.query(`UPDATE supplier.capacity_window SET status = 'superseded' WHERE id = $1`, [
        previous.id,
      ]);
    }
    const res = await tx.query(
      `INSERT INTO supplier.capacity_window
         (supplier_profile_id, capability_id, version_no, window_start, window_end,
          available_hours, note, supersedes_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.supplierProfileId,
        input.capabilityId,
        nextVersion,
        input.windowStart,
        input.windowEnd,
        input.availableHours,
        input.note,
        previous?.id ?? null,
        input.createdBy,
      ],
    );
    return mapCapacity(res.rows[0]);
  }

  async listTaxonomy(): Promise<CapabilityRow[]> {
    const res = await this.db.pool.query(
      `SELECT id, code, kind, label, status, parent_id, is_family FROM supplier.capability
        WHERE status = 'active' ORDER BY kind, label`,
    );
    return res.rows.map((row) => ({
      id: row.id,
      code: row.code,
      kind: row.kind,
      label: row.label,
      status: row.status,
      parentId: row.parent_id ?? null,
      isFamily: row.is_family === true,
    }));
  }

  async listSupplierCapabilities(
    supplierProfileId: string,
    includeHistory: boolean,
  ): Promise<SupplierCapabilityRow[]> {
    const res = await this.db.pool.query(
      `SELECT sc.*, c.code, c.kind, c.label
         FROM supplier.supplier_capability sc
         JOIN supplier.capability c ON c.id = sc.capability_id
        WHERE sc.supplier_profile_id = $1
          AND ($2::boolean OR sc.status = 'published')
        ORDER BY c.code, sc.version_no DESC`,
      [supplierProfileId, includeHistory],
    );
    return res.rows.map(mapSupplierCapability);
  }

  async listMachines(supplierProfileId: string, includeHistory: boolean): Promise<MachineRow[]> {
    const res = await this.db.pool.query(
      `SELECT m.*, c.code, c.kind, c.label
         FROM supplier.machine m
         LEFT JOIN supplier.capability c ON c.id = m.capability_id
        WHERE m.supplier_profile_id = $1
          AND ($2::boolean OR m.status = 'published')
        ORDER BY m.machine_key, m.version_no DESC`,
      [supplierProfileId, includeHistory],
    );
    return res.rows.map(mapMachine);
  }

  async listCapacityWindows(
    supplierProfileId: string,
    includeHistory: boolean,
  ): Promise<CapacityWindowRow[]> {
    const res = await this.db.pool.query(
      `SELECT w.*, c.code, c.kind, c.label
         FROM supplier.capacity_window w
         LEFT JOIN supplier.capability c ON c.id = w.capability_id
        WHERE w.supplier_profile_id = $1
          AND ($2::boolean OR w.status = 'published')
        ORDER BY w.window_start, w.version_no DESC`,
      [supplierProfileId, includeHistory],
    );
    return res.rows.map(mapCapacity);
  }

  /** Evidence must be a scan-clean, releasable document version owned by the supplier. */
  async evidenceUsable(
    documentVersionId: string,
    owningOrganizationId: string,
  ): Promise<{ usable: boolean; reason: string }> {
    const res = await this.db.pool.query(
      `SELECT v.status, f.scan_state, d.owning_organization_id
         FROM dms.document_version v
         JOIN dms.document d ON d.id = v.document_id
         JOIN dms.file_object f ON f.id = v.file_object_id
        WHERE v.id = $1`,
      [documentVersionId],
    );
    const row = res.rows[0];
    if (!row) return { usable: false, reason: 'evidence document not found' };
    if (row.owning_organization_id !== owningOrganizationId) {
      return { usable: false, reason: 'evidence document not found' };
    }
    if (row.scan_state !== 'clean' || row.status !== 'available') {
      return { usable: false, reason: `evidence is ${row.status} and its scan state is ${row.scan_state}` };
    }
    return { usable: true, reason: 'clean' };
  }
}

function mapSupplierCapability(row: Record<string, unknown>): SupplierCapabilityRow {
  return {
    id: row['id'] as string,
    capabilityId: row['capability_id'] as string,
    code: (row['code'] as string) ?? '',
    kind: (row['kind'] as SupplierCapabilityRow['kind']) ?? 'process',
    label: (row['label'] as string) ?? '',
    versionNo: row['version_no'] as number,
    status: row['status'] as SupplierCapabilityRow['status'],
    attributes: (row['attributes'] as Record<string, unknown>) ?? {},
    validFrom: row['valid_from'] as Date,
    validUntil: (row['valid_until'] as Date | null) ?? null,
  };
}

function mapMachine(row: Record<string, unknown>): MachineRow {
  return {
    id: row['id'] as string,
    machineKey: row['machine_key'] as string,
    label: row['label'] as string,
    versionNo: row['version_no'] as number,
    status: row['status'] as MachineRow['status'],
    quantity: row['quantity'] as number,
    axes: (row['axes'] as number | null) ?? null,
    envelope: row['envelope'] as MachineRow['envelope'],
    capability: row['capability_id']
      ? {
          capabilityId: row['capability_id'] as string,
          code: row['code'] as string,
          kind: row['kind'] as string,
          label: row['label'] as string,
        }
      : null,
  };
}

function mapCapacity(row: Record<string, unknown>): CapacityWindowRow {
  // `date` columns arrive as `YYYY-MM-DD` strings (see `registerPgTypeParsers`), so
  // there is nothing to convert and nothing to shift.
  const asDate = (value: unknown): string => String(value);
  return {
    id: row['id'] as string,
    versionNo: row['version_no'] as number,
    status: row['status'] as CapacityWindowRow['status'],
    windowStart: asDate(row['window_start']),
    windowEnd: asDate(row['window_end']),
    availableHours: row['available_hours'] === null ? null : Number(row['available_hours']),
    note: (row['note'] as string | null) ?? null,
    capability: row['capability_id']
      ? {
          capabilityId: row['capability_id'] as string,
          code: row['code'] as string,
          kind: row['kind'] as string,
          label: row['label'] as string,
        }
      : null,
  };
}

function mapProfile(row: Record<string, unknown>): SupplierProfileRow {
  return {
    id: row['id'] as string,
    organizationId: row['organization_id'] as string,
    organizationStatus: row['organization_status'] as string,
    legalName: (row['legal_name'] as string | undefined) ?? '',
    displayName: (row['display_name'] as string | undefined) ?? '',
    regionClass: row['region_class'] as string,
    summary: row['summary'] as string,
    tradeName: (row['trade_name'] as string | undefined) ?? '',
    website: (row['website'] as string | undefined) ?? '',
    yearEstablished: (row['year_established'] as number | null) ?? null,
    employeeBand: (row['employee_band'] as string | null) ?? null,
    primaryContactName: (row['primary_contact_name'] as string | undefined) ?? '',
    primaryContactEmail: (row['primary_contact_email'] as string | undefined) ?? '',
    primaryContactPhone: (row['primary_contact_phone'] as string | undefined) ?? '',
    worksSiteId: (row['works_site_id'] as string | null) ?? null,
    status: row['status'] as SupplierNetworkStatusRow,
    acceptingWork: (row['accepting_work'] as boolean | undefined) ?? true,
    acceptingWorkNote: (row['accepting_work_note'] as string | undefined) ?? '',
    // A `date` column comes back as a string (registerPgTypeParsers); never re-derive it
    // through a Date, which would shift the day in IST.
    acceptingWorkUntil: (row['accepting_work_until'] as string | null) ?? null,
    aggregateVersion: row['aggregate_version'] as number,
    submittedAt: (row['submitted_for_approval_at'] as Date | null) ?? null,
    submittedBy: (row['submitted_by'] as string | null) ?? null,
    decidedBy: (row['decided_by'] as string | null) ?? null,
    decidedAt: (row['decided_at'] as Date | null) ?? null,
    decisionReason: (row['decision_reason'] as string | null) ?? null,
    updatedAt: (row['updated_at'] as Date | undefined) ?? new Date(0),
  };
}

function mapVerification(row: Record<string, unknown>): VerificationItemRow {
  return {
    id: row['id'] as string,
    supplierProfileId: row['supplier_profile_id'] as string,
    kind: row['kind'] as VerificationKind,
    versionNo: row['version_no'] as number,
    status: row['status'] as VerificationStatus,
    referenceValue: (row['reference_value'] as string | null) ?? null,
    evidenceDocumentVersionId: (row['evidence_document_version_id'] as string | null) ?? null,
    expiresAt: (row['expires_at'] as Date | null) ?? null,
    submittedBy: (row['submitted_by'] as string | null) ?? null,
    submittedAt: (row['submitted_at'] as Date | null) ?? null,
    reviewedBy: (row['reviewed_by'] as string | null) ?? null,
    reviewedAt: (row['reviewed_at'] as Date | null) ?? null,
    reviewReason: (row['review_reason'] as string | null) ?? null,
    aggregateVersion: row['aggregate_version'] as number,
    createdAt: row['created_at'] as Date,
  };
}

// ------------------------------------------------------------- network applications

export interface NetworkApplicationRow {
  id: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  city: string;
  processCodes: string[];
  note: string;
  status: 'received' | 'admitted' | 'declined';
  decidedAt: Date | null;
  decisionReason: string;
  admittedOrganizationId: string | null;
  createdAt: Date;
}

const APPLICATION_COLUMNS = `
  id, company_name AS "companyName", contact_name AS "contactName", email, phone, city,
  process_codes AS "processCodes", note, status, decided_at AS "decidedAt",
  decision_reason AS "decisionReason", admitted_organization_id AS "admittedOrganizationId",
  created_at AS "createdAt"`;

@Injectable()
export class NetworkApplicationRepository {
  constructor(private readonly db: DatabaseService) {}

  private client(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  async create(
    input: {
      companyName: string;
      contactName: string;
      email: string;
      phone: string;
      city: string;
      processCodes: readonly string[];
      note: string;
    },
    tx?: Queryable,
  ): Promise<NetworkApplicationRow> {
    const res = await this.client(tx).query<NetworkApplicationRow>(
      `INSERT INTO supplier.network_application
         (company_name, contact_name, email, phone, city, process_codes, note)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
       RETURNING ${APPLICATION_COLUMNS}`,
      [
        input.companyName,
        input.contactName,
        input.email,
        input.phone,
        input.city,
        [...input.processCodes],
        input.note,
      ],
    );
    return res.rows[0]!;
  }

  async list(status: string | undefined, limit: number): Promise<NetworkApplicationRow[]> {
    const res = await this.db.pool.query<NetworkApplicationRow>(
      `SELECT ${APPLICATION_COLUMNS} FROM supplier.network_application
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY (status = 'received') DESC, created_at ASC
        LIMIT $2`,
      [status ?? null, limit],
    );
    return res.rows;
  }

  async find(id: string, tx?: Queryable): Promise<NetworkApplicationRow | null> {
    const res = await this.client(tx).query<NetworkApplicationRow>(
      `SELECT ${APPLICATION_COLUMNS} FROM supplier.network_application WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  /** Guarded decision: only an open application moves, so the second decision finds nothing. */
  async decide(
    input: {
      id: string;
      status: 'admitted' | 'declined';
      decidedBy: string;
      reason: string;
      admittedOrganizationId: string | null;
    },
    tx: Queryable,
  ): Promise<boolean> {
    const res = await tx.query(
      `UPDATE supplier.network_application
          SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4,
              admitted_organization_id = $5, updated_at = now()
        WHERE id = $1 AND status = 'received'`,
      [input.id, input.status, input.decidedBy, input.reason, input.admittedOrganizationId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
