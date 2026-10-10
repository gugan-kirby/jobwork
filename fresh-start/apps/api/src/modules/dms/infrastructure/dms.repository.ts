import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { DocumentPurpose } from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';

type Queryable = Pool | PoolClient;

export interface UploadSessionRow {
  id: string;
  organizationId: string;
  createdBy: string;
  purpose: DocumentPurpose;
  declaredFilename: string;
  declaredMediaType: string;
  declaredByteSize: number;
  storageKey: string;
  status: 'initiated' | 'finalized' | 'expired' | 'aborted';
  documentId: string | null;
  documentVersionId: string | null;
  expiresAt: Date;
}

export type ScanState =
  | 'quarantined'
  | 'scanning'
  | 'clean'
  | 'infected'
  | 'unsupported'
  | 'failed';

export interface FileObjectRow {
  id: string;
  storageKey: string;
  byteSize: number;
  sha256: string;
  scanState: ScanState;
  declaredMediaType?: string;
  owningOrganizationId?: string;
}

export interface DocumentRow {
  id: string;
  owningOrganizationId: string;
  logicalType: DocumentPurpose;
  title: string;
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  currentVersionNo: number;
  aggregateVersion: number;
  createdAt: Date;
}

/** A list row carries the current version's identity and states: the list is what a
 *  caller attaches from, and an attach needs the version, not the document. */
export interface DocumentListRow extends DocumentRow {
  currentVersionId: string | null;
  currentVersionStatus: DocumentVersionRow['status'] | null;
  currentVersionScanState: FileObjectRow['scanState'] | null;
}

export interface DocumentVersionRow {
  id: string;
  documentId: string;
  versionNo: number;
  engineeringRevision: string | null;
  originalFilename: string;
  status: 'processing' | 'available' | 'quarantined' | 'revoked';
  scanState: FileObjectRow['scanState'];
  sha256: string;
  byteSize: number;
  audiences: Array<'internal' | 'organization' | 'auditor'>;
  createdAt: Date;
}

export interface ReleasableVersionRow {
  versionId: string;
  documentId: string;
  owningOrganizationId: string;
  originalFilename: string;
  versionStatus: 'processing' | 'available' | 'quarantined' | 'revoked';
  scanState: ScanState;
  storageKey: string;
  sha256: string;
  byteSize: number;
}

export interface AccessDecisionRow extends ReleasableVersionRow {
  /** Both flags are computed in SQL over the grant table, never by filtering in code. */
  ownerAccess: boolean;
  granted: boolean;
}

export interface GrantRow {
  id: string;
  documentVersionId: string;
  audienceType: 'internal' | 'organization' | 'auditor';
  organizationId: string | null;
  actions: string[];
  validUntil: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** All reads are organization-scoped in SQL, never filtered after fetch (doc 20 §6). */
@Injectable()
export class DmsRepository {
  constructor(private readonly db: DatabaseService) {}

  private client(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  async createUploadSession(
    input: {
      organizationId: string;
      createdBy: string;
      purpose: DocumentPurpose;
      declaredFilename: string;
      declaredMediaType: string;
      declaredByteSize: number;
      storageKey: string;
      documentId: string | null;
      expiresAt: Date;
    },
    tx?: Queryable,
  ): Promise<UploadSessionRow> {
    const res = await this.client(tx).query(
      `INSERT INTO dms.upload_session
         (organization_id, created_by, purpose, declared_filename, declared_media_type,
          declared_byte_size, storage_key, document_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.organizationId,
        input.createdBy,
        input.purpose,
        input.declaredFilename,
        input.declaredMediaType,
        input.declaredByteSize,
        input.storageKey,
        input.documentId,
        input.expiresAt,
      ],
    );
    return mapSession(res.rows[0]);
  }

  async findUploadSession(id: string, organizationId: string): Promise<UploadSessionRow | null> {
    const res = await this.db.pool.query(
      `SELECT * FROM dms.upload_session WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
    );
    const row = res.rows[0];
    return row ? mapSession(row) : null;
  }

  /** Locked read: finalize must not race a second finalize of the same session. */
  async lockUploadSession(
    id: string,
    organizationId: string,
    tx: PoolClient,
  ): Promise<UploadSessionRow | null> {
    const res = await tx.query(
      `SELECT * FROM dms.upload_session
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE`,
      [id, organizationId],
    );
    const row = res.rows[0];
    return row ? mapSession(row) : null;
  }

  async markSessionStatus(
    id: string,
    status: UploadSessionRow['status'],
    tx?: Queryable,
    linked?: { documentId: string; documentVersionId: string },
  ): Promise<void> {
    await this.client(tx).query(
      `UPDATE dms.upload_session
          SET status = $2,
              document_id = COALESCE($3, document_id),
              document_version_id = COALESCE($4, document_version_id),
              updated_at = now()
        WHERE id = $1`,
      [id, status, linked?.documentId ?? null, linked?.documentVersionId ?? null],
    );
  }

  /** Byte identity is per organization: the same bytes never merge across tenants. */
  async findFileByDigest(
    organizationId: string,
    sha256: string,
    tx: Queryable,
  ): Promise<FileObjectRow | null> {
    const res = await this.client(tx).query(
      `SELECT id, storage_key, byte_size, sha256, scan_state
         FROM dms.file_object
        WHERE owning_organization_id = $1 AND sha256 = $2`,
      [organizationId, sha256],
    );
    const row = res.rows[0];
    return row ? mapFile(row) : null;
  }

  async createFileObject(
    input: {
      storageKey: string;
      byteSize: number;
      declaredMediaType: string;
      sha256: string;
      organizationId: string;
      createdBy: string;
    },
    tx: Queryable,
  ): Promise<FileObjectRow> {
    const res = await this.client(tx).query(
      `INSERT INTO dms.file_object
         (storage_key, byte_size, declared_media_type, sha256, owning_organization_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, storage_key, byte_size, sha256, scan_state`,
      [
        input.storageKey,
        input.byteSize,
        input.declaredMediaType,
        input.sha256,
        input.organizationId,
        input.createdBy,
      ],
    );
    return mapFile(res.rows[0]);
  }

  /** Full row for the scan path, which runs outside any organization's session. */
  async findFileObject(id: string, tx?: Queryable): Promise<FileObjectRow | null> {
    const res = await this.client(tx).query(
      `SELECT id, storage_key, byte_size, sha256, scan_state, declared_media_type,
              owning_organization_id
         FROM dms.file_object WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? mapFile(row) : null;
  }

  async lockFileObject(id: string, tx: PoolClient): Promise<FileObjectRow | null> {
    const res = await tx.query(
      `SELECT id, storage_key, byte_size, sha256, scan_state, declared_media_type,
              owning_organization_id
         FROM dms.file_object WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = res.rows[0];
    return row ? mapFile(row) : null;
  }

  /**
   * Scan-state moves are guarded by a database trigger (quarantined → scanning →
   * verdict, failed → scanning); an illegal move raises rather than silently passing.
   */
  async setScanState(
    input: {
      id: string;
      scanState: ScanState;
      detail?: string | null;
      detectedMediaType?: string | null;
    },
    tx: Queryable,
  ): Promise<void> {
    await this.client(tx).query(
      `UPDATE dms.file_object
          SET scan_state = $2,
              scan_detail = COALESCE($3, scan_detail),
              detected_media_type = COALESCE($4, detected_media_type),
              updated_at = now()
        WHERE id = $1`,
      [input.id, input.scanState, input.detail ?? null, input.detectedMediaType ?? null],
    );
  }

  /**
   * Settles the versions waiting on this file. Only `processing` rows move, so a
   * revoked or already-settled version is never resurrected by a late verdict.
   */
  async settleVersionsForFile(
    fileObjectId: string,
    status: 'available' | 'quarantined',
    tx: Queryable,
  ): Promise<number> {
    const res = await this.client(tx).query(
      `UPDATE dms.document_version
          SET status = $2
        WHERE file_object_id = $1 AND status = 'processing'`,
      [fileObjectId, status],
    );
    return res.rowCount ?? 0;
  }

  async countVersionStatuses(
    fileObjectId: string,
    tx?: Queryable,
  ): Promise<{ available: number; quarantined: number }> {
    const res = await this.client(tx).query(
      `SELECT
         count(*) FILTER (WHERE status = 'available')::int AS available,
         count(*) FILTER (WHERE status = 'quarantined')::int AS quarantined
       FROM dms.document_version WHERE file_object_id = $1`,
      [fileObjectId],
    );
    const row = res.rows[0] as { available: number; quarantined: number } | undefined;
    return { available: row?.available ?? 0, quarantined: row?.quarantined ?? 0 };
  }

  async createDocument(
    input: {
      organizationId: string;
      logicalType: DocumentPurpose;
      title: string;
      createdBy: string;
    },
    tx: Queryable,
  ): Promise<DocumentRow> {
    const res = await this.client(tx).query(
      `INSERT INTO dms.document (owning_organization_id, logical_type, title, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.organizationId, input.logicalType, input.title, input.createdBy],
    );
    return mapDocument(res.rows[0]);
  }

  async lockDocument(
    id: string,
    organizationId: string,
    tx: PoolClient,
  ): Promise<DocumentRow | null> {
    const res = await tx.query(
      `SELECT * FROM dms.document WHERE id = $1 AND owning_organization_id = $2 FOR UPDATE`,
      [id, organizationId],
    );
    const row = res.rows[0];
    return row ? mapDocument(row) : null;
  }

  /**
   * Appends the next immutable version and advances the aggregate. Existing versions
   * are never rewritten (BR-DOC immutability).
   */
  async appendVersion(
    input: {
      documentId: string;
      versionNo: number;
      fileObjectId: string;
      originalFilename: string;
      engineeringRevision: string | null;
      supersedesVersionId: string | null;
      status: 'processing' | 'available';
      createdBy: string;
    },
    tx: Queryable,
  ): Promise<{ id: string; versionNo: number }> {
    const res = await this.client(tx).query(
      `INSERT INTO dms.document_version
         (document_id, version_no, file_object_id, original_filename, engineering_revision,
          supersedes_version_id, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, version_no`,
      [
        input.documentId,
        input.versionNo,
        input.fileObjectId,
        input.originalFilename,
        input.engineeringRevision,
        input.supersedesVersionId,
        input.status,
        input.createdBy,
      ],
    );
    const row = res.rows[0] as { id: string; version_no: number };
    return { id: row.id, versionNo: row.version_no };
  }

  async advanceDocument(
    documentId: string,
    versionNo: number,
    tx: Queryable,
  ): Promise<number> {
    const res = await this.client(tx).query(
      `UPDATE dms.document
          SET current_version_no = $2,
              aggregate_version = aggregate_version + 1,
              updated_at = now()
        WHERE id = $1
      RETURNING aggregate_version`,
      [documentId, versionNo],
    );
    return (res.rows[0] as { aggregate_version: number }).aggregate_version;
  }

  async latestVersionId(documentId: string, tx: Queryable): Promise<string | null> {
    const res = await this.client(tx).query(
      `SELECT id FROM dms.document_version
        WHERE document_id = $1
        ORDER BY version_no DESC
        LIMIT 1`,
      [documentId],
    );
    return (res.rows[0] as { id: string } | undefined)?.id ?? null;
  }

  /** The version a release decision is about, with the states that gate it. */
  async findVersionForRelease(
    versionId: string,
    tx?: Queryable,
  ): Promise<ReleasableVersionRow | null> {
    const res = await this.client(tx).query(
      `SELECT v.id, v.document_id, v.original_filename, v.status, d.owning_organization_id,
              f.scan_state, f.storage_key, f.sha256, f.byte_size
         FROM dms.document_version v
         JOIN dms.document d ON d.id = v.document_id
         JOIN dms.file_object f ON f.id = v.file_object_id
        WHERE v.id = $1`,
      [versionId],
    );
    const row = res.rows[0];
    return row ? mapReleasable(row) : null;
  }

  /**
   * Authorization is the query (doc 20 §6): a caller is either the owning organization
   * or the holder of a live, unexpired grant carrying the action. Nothing is fetched
   * and then filtered, and a revoked or expired grant simply is not there.
   */
  async decideAccess(input: {
    versionId: string;
    organizationId: string | null;
    action: 'view' | 'download';
    internalHandler: boolean;
    auditor: boolean;
  }): Promise<AccessDecisionRow | null> {
    const res = await this.db.pool.query(
      `SELECT v.id, v.document_id, v.original_filename, v.status, d.owning_organization_id,
              f.scan_state, f.storage_key, f.sha256, f.byte_size,
              (d.owning_organization_id = $2) AS owner_access,
              EXISTS (
                SELECT 1 FROM dms.audience_grant g
                 WHERE g.document_version_id = v.id
                   AND g.revoked_at IS NULL
                   AND (g.valid_until IS NULL OR g.valid_until > now())
                   AND $3 = ANY (g.actions)
                   AND (
                     (g.audience_type = 'organization' AND g.organization_id = $2)
                     OR (g.audience_type = 'internal' AND $4)
                     OR (g.audience_type = 'auditor' AND $5)
                   )
              ) AS granted
         FROM dms.document_version v
         JOIN dms.document d ON d.id = v.document_id
         JOIN dms.file_object f ON f.id = v.file_object_id
        WHERE v.id = $1`,
      [
        input.versionId,
        input.organizationId,
        input.action,
        input.internalHandler,
        input.auditor,
      ],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      ...mapReleasable(row),
      ownerAccess: row.owner_access === true,
      granted: row.granted === true,
    };
  }

  async findLiveGrant(
    input: {
      versionId: string;
      audienceType: string;
      organizationId: string | null;
    },
    tx?: Queryable,
  ): Promise<GrantRow | null> {
    const res = await this.client(tx).query(
      `SELECT * FROM dms.audience_grant
        WHERE document_version_id = $1
          AND audience_type = $2
          AND organization_id IS NOT DISTINCT FROM $3
          AND revoked_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.versionId, input.audienceType, input.organizationId],
    );
    const row = res.rows[0];
    return row ? mapGrant(row) : null;
  }

  async createGrant(
    input: {
      versionId: string;
      audienceType: string;
      organizationId: string | null;
      actions: string[];
      grantedBy: string;
      validUntil: Date | null;
    },
    tx: Queryable,
  ): Promise<GrantRow> {
    const res = await this.client(tx).query(
      `INSERT INTO dms.audience_grant
         (document_version_id, audience_type, organization_id, actions, granted_by, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.versionId,
        input.audienceType,
        input.organizationId,
        input.actions,
        input.grantedBy,
        input.validUntil,
      ],
    );
    return mapGrant(res.rows[0]);
  }

  /**
   * Grant-if-absent, for callers that release the same manifest to several organizations
   * and may re-run (RFQ release, IN-06). Stacking duplicate live grants would mean
   * revoking one and leaving the other — the shape of an access bug nobody sees.
   */
  async ensureGrant(
    input: {
      versionId: string;
      organizationId: string;
      actions: string[];
      grantedBy: string;
    },
    tx: Queryable,
  ): Promise<GrantRow> {
    const existing = await this.client(tx).query(
      `SELECT * FROM dms.audience_grant
        WHERE document_version_id = $1 AND organization_id = $2 AND audience_type = 'organization'
          AND revoked_at IS NULL AND (valid_until IS NULL OR valid_until > now())
        LIMIT 1`,
      [input.versionId, input.organizationId],
    );
    if (existing.rows[0]) return mapGrant(existing.rows[0]);
    return this.createGrant(
      {
        versionId: input.versionId,
        audienceType: 'organization',
        organizationId: input.organizationId,
        actions: input.actions,
        grantedBy: input.grantedBy,
        validUntil: null,
      },
      tx,
    );
  }

  /** Every live grant an organization holds on one version, revoked together. */
  async revokeGrantsFor(
    input: { versionId: string; organizationId: string; revokedBy: string; reason: string },
    tx: Queryable,
  ): Promise<number> {
    const res = await this.client(tx).query(
      `UPDATE dms.audience_grant
          SET revoked_at = now(), revoked_by = $3
        WHERE document_version_id = $1 AND organization_id = $2 AND revoked_at IS NULL`,
      [input.versionId, input.organizationId, input.revokedBy],
    );
    return res.rowCount ?? 0;
  }

  async findGrant(grantId: string, tx?: Queryable): Promise<GrantRow | null> {
    const res = await this.client(tx).query(
      `SELECT * FROM dms.audience_grant WHERE id = $1`,
      [grantId],
    );
    const row = res.rows[0];
    return row ? mapGrant(row) : null;
  }

  /** Revocation stops future access; it never edits what already happened. */
  async revokeGrant(grantId: string, revokedBy: string, tx: Queryable): Promise<boolean> {
    const res = await this.client(tx).query(
      `UPDATE dms.audience_grant
          SET revoked_at = now(), revoked_by = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [grantId, revokedBy],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listGrants(versionId: string, organizationId: string): Promise<GrantRow[]> {
    const res = await this.db.pool.query(
      `SELECT g.* FROM dms.audience_grant g
         JOIN dms.document_version v ON v.id = g.document_version_id
         JOIN dms.document d ON d.id = v.document_id
        WHERE g.document_version_id = $1 AND d.owning_organization_id = $2
        ORDER BY g.created_at DESC`,
      [versionId, organizationId],
    );
    return res.rows.map(mapGrant);
  }

  /** Append-only by database trigger: a download is a fact, not a revocable record. */
  async recordAccess(input: {
    versionId: string;
    actorId: string;
    organizationId: string | null;
    action: 'preview' | 'download';
  }): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO dms.access_log (document_version_id, actor_id, organization_id, action)
       VALUES ($1, $2, $3, $4)`,
      [input.versionId, input.actorId, input.organizationId, input.action],
    );
  }

  async countAccess(
    versionId: string,
    organizationId: string | null,
    tx?: Queryable,
  ): Promise<number> {
    const res = await this.client(tx).query(
      `SELECT count(*)::int AS n FROM dms.access_log
        WHERE document_version_id = $1
          AND ($2::uuid IS NULL OR organization_id = $2)
          AND action = 'download'`,
      [versionId, organizationId],
    );
    return (res.rows[0] as { n: number } | undefined)?.n ?? 0;
  }

  async listDocuments(organizationId: string, limit: number): Promise<DocumentListRow[]> {
    const res = await this.db.pool.query(
      `SELECT d.*, cv.id AS current_version_id, cv.status AS current_version_status,
              cv.scan_state AS current_version_scan_state
         FROM dms.document d
         LEFT JOIN LATERAL (
           SELECT v.id, v.status, f.scan_state
             FROM dms.document_version v
             JOIN dms.file_object f ON f.id = v.file_object_id
            WHERE v.document_id = d.id
            ORDER BY v.version_no DESC
            LIMIT 1
         ) cv ON true
        WHERE d.owning_organization_id = $1
        ORDER BY d.created_at DESC
        LIMIT $2`,
      [organizationId, limit],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      ...mapDocument(row),
      currentVersionId: (row['current_version_id'] as string | null) ?? null,
      currentVersionStatus:
        (row['current_version_status'] as DocumentVersionRow['status'] | null) ?? null,
      currentVersionScanState:
        (row['current_version_scan_state'] as FileObjectRow['scanState'] | null) ?? null,
    }));
  }

  async findDocument(id: string, organizationId: string): Promise<DocumentRow | null> {
    const res = await this.db.pool.query(
      `SELECT * FROM dms.document WHERE id = $1 AND owning_organization_id = $2`,
      [id, organizationId],
    );
    const row = res.rows[0];
    return row ? mapDocument(row) : null;
  }

  async listVersions(documentId: string, organizationId: string): Promise<DocumentVersionRow[]> {
    const res = await this.db.pool.query(
      `SELECT v.id, v.document_id, v.version_no, v.engineering_revision, v.original_filename,
              v.status, v.created_at, f.scan_state, f.sha256, f.byte_size,
              COALESCE((
                SELECT array_agg(DISTINCT g.audience_type)
                  FROM dms.audience_grant g
                 WHERE g.document_version_id = v.id
                   AND g.revoked_at IS NULL
                   AND (g.valid_until IS NULL OR g.valid_until > now())
              ), '{}') AS audiences
         FROM dms.document_version v
         JOIN dms.document d ON d.id = v.document_id
         JOIN dms.file_object f ON f.id = v.file_object_id
        WHERE v.document_id = $1 AND d.owning_organization_id = $2
        ORDER BY v.version_no DESC`,
      [documentId, organizationId],
    );
    return res.rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      versionNo: row.version_no,
      engineeringRevision: row.engineering_revision,
      originalFilename: row.original_filename,
      status: row.status,
      scanState: row.scan_state,
      sha256: row.sha256,
      byteSize: Number(row.byte_size),
      audiences: (row.audiences ?? []) as DocumentVersionRow['audiences'],
      createdAt: row.created_at,
    }));
  }

  // ----------------------------------------------------------------- supplier copies (F-FP.5)

  async findSupplierCopy(sourceVersionId: string, tx?: Queryable, forUpdate = false): Promise<SupplierCopyRow | null> {
    const res = await this.client(tx).query(
      `SELECT c.*, v.original_filename AS copy_filename, f.sha256 AS copy_sha256
         FROM dms.supplier_copy c JOIN dms.document_version v ON v.id = c.copy_version_id JOIN dms.file_object f ON f.id = v.file_object_id
        WHERE c.source_version_id = $1${forUpdate ? ' FOR UPDATE OF c' : ''}`,
      [sourceVersionId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? mapSupplierCopy(row) : null;
  }

  /** Confirmed copies of these customer versions, by source version id. */
  async confirmedCopies(sourceVersionIds: readonly string[], tx?: Queryable): Promise<Map<string, SupplierCopyRow>> {
    if (sourceVersionIds.length === 0) return new Map();
    const res = await this.client(tx).query(
      `SELECT c.*, v.original_filename AS copy_filename, f.sha256 AS copy_sha256
         FROM dms.supplier_copy c JOIN dms.document_version v ON v.id = c.copy_version_id JOIN dms.file_object f ON f.id = v.file_object_id
        WHERE c.source_version_id = ANY($1::uuid[]) AND c.confirmed_at IS NOT NULL`,
      [sourceVersionIds],
    );
    return new Map(res.rows.map((r: Record<string, unknown>) => [r['source_version_id'] as string, mapSupplierCopy(r)]));
  }

  /** The owning organization's type of each version: a customer's own file needs a supplier copy. */
  async ownerTypes(versionIds: readonly string[], tx?: Queryable): Promise<Map<string, 'customer' | 'supplier' | 'internal'>> {
    if (versionIds.length === 0) return new Map();
    const res = await this.client(tx).query(
      `SELECT v.id, o.type FROM dms.document_version v JOIN dms.document d ON d.id = v.document_id JOIN iam.organization o ON o.id = d.owning_organization_id
        WHERE v.id = ANY($1::uuid[])`,
      [versionIds],
    );
    return new Map(res.rows.map((r: Record<string, unknown>) => [r['id'] as string, r['type'] as 'customer' | 'supplier' | 'internal']));
  }

  /** A prepared copy replaces an unconfirmed one; a confirmed copy is kept (trigger). */
  async prepareSupplierCopy(input: { sourceVersionId: string; copyVersionId: string; preparedBy: string; note: string }, tx: Queryable): Promise<void> {
    await this.client(tx).query(`DELETE FROM dms.supplier_copy WHERE source_version_id = $1 AND confirmed_at IS NULL`, [input.sourceVersionId]);
    await this.client(tx).query(
      `INSERT INTO dms.supplier_copy (source_version_id, copy_version_id, prepared_by, note) VALUES ($1, $2, $3, $4)`,
      [input.sourceVersionId, input.copyVersionId, input.preparedBy, input.note],
    );
  }

  async confirmSupplierCopy(input: { sourceVersionId: string; confirmedBy: string; note: string }, tx: Queryable): Promise<void> {
    await this.client(tx).query(
      `UPDATE dms.supplier_copy SET confirmed_by = $2, confirmed_at = now(), confirm_note = $3 WHERE source_version_id = $1 AND confirmed_at IS NULL`,
      [input.sourceVersionId, input.confirmedBy, input.note],
    );
  }
}

function mapSession(row: Record<string, unknown>): UploadSessionRow {
  return {
    id: row['id'] as string,
    organizationId: row['organization_id'] as string,
    createdBy: row['created_by'] as string,
    purpose: row['purpose'] as DocumentPurpose,
    declaredFilename: row['declared_filename'] as string,
    declaredMediaType: row['declared_media_type'] as string,
    declaredByteSize: Number(row['declared_byte_size']),
    storageKey: row['storage_key'] as string,
    status: row['status'] as UploadSessionRow['status'],
    documentId: (row['document_id'] as string | null) ?? null,
    documentVersionId: (row['document_version_id'] as string | null) ?? null,
    expiresAt: row['expires_at'] as Date,
  };
}

function mapFile(row: Record<string, unknown>): FileObjectRow {
  return {
    id: row['id'] as string,
    storageKey: row['storage_key'] as string,
    byteSize: Number(row['byte_size']),
    sha256: row['sha256'] as string,
    scanState: row['scan_state'] as ScanState,
    ...(row['declared_media_type'] !== undefined
      ? { declaredMediaType: row['declared_media_type'] as string }
      : {}),
    ...(row['owning_organization_id'] !== undefined
      ? { owningOrganizationId: row['owning_organization_id'] as string }
      : {}),
  };
}

function mapReleasable(row: Record<string, unknown>): ReleasableVersionRow {
  return {
    versionId: row['id'] as string,
    documentId: row['document_id'] as string,
    owningOrganizationId: row['owning_organization_id'] as string,
    originalFilename: row['original_filename'] as string,
    versionStatus: row['status'] as ReleasableVersionRow['versionStatus'],
    scanState: row['scan_state'] as ScanState,
    storageKey: row['storage_key'] as string,
    sha256: row['sha256'] as string,
    byteSize: Number(row['byte_size']),
  };
}

function mapGrant(row: Record<string, unknown>): GrantRow {
  return {
    id: row['id'] as string,
    documentVersionId: row['document_version_id'] as string,
    audienceType: row['audience_type'] as GrantRow['audienceType'],
    organizationId: (row['organization_id'] as string | null) ?? null,
    actions: row['actions'] as string[],
    validUntil: (row['valid_until'] as Date | null) ?? null,
    revokedAt: (row['revoked_at'] as Date | null) ?? null,
    createdAt: row['created_at'] as Date,
  };
}

function mapDocument(row: Record<string, unknown>): DocumentRow {
  return {
    id: row['id'] as string,
    owningOrganizationId: row['owning_organization_id'] as string,
    logicalType: row['logical_type'] as DocumentPurpose,
    title: row['title'] as string,
    classification: row['classification'] as DocumentRow['classification'],
    currentVersionNo: row['current_version_no'] as number,
    aggregateVersion: row['aggregate_version'] as number,
    createdAt: row['created_at'] as Date,
  };
}

export interface SupplierCopyRow {
  sourceVersionId: string;
  copyVersionId: string;
  copyFilename: string;
  copySha256: string;
  preparedBy: string;
  preparedAt: Date;
  note: string;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  confirmNote: string | null;
}

function mapSupplierCopy(row: Record<string, unknown>): SupplierCopyRow {
  return {
    sourceVersionId: row['source_version_id'] as string,
    copyVersionId: row['copy_version_id'] as string,
    copyFilename: row['copy_filename'] as string,
    copySha256: row['copy_sha256'] as string,
    preparedBy: row['prepared_by'] as string,
    preparedAt: row['prepared_at'] as Date,
    note: row['note'] as string,
    confirmedBy: (row['confirmed_by'] as string | null) ?? null,
    confirmedAt: (row['confirmed_at'] as Date | null) ?? null,
    confirmNote: (row['confirm_note'] as string | null) ?? null,
  };
}
