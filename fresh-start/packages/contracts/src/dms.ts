import { z } from 'zod';
import { DOCUMENT_PURPOSES, UPLOAD_POLICY, acceptAttribute, type PurposePolicy } from './constants';

// The policy table lives in the zod-free `./constants` so browsers can read it without
// loading every schema (F-FE.3); it is re-exported here for existing importers.
export { UPLOAD_POLICY, acceptAttribute, type PurposePolicy };

/**
 * Document core contracts (doc 08 §7). Upload purpose doubles as the document logical
 * type (doc 05 §7 enum) so size/format policy and stored metadata share one vocabulary.
 */
export const documentPurposeSchema = z.enum(DOCUMENT_PURPOSES);

export const sha256HexSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{64}$/, 'Must be a 64-character hexadecimal SHA-256 digest');

export const initiateUploadRequestSchema = z.object({
  purpose: documentPurposeSchema,
  filename: z.string().trim().min(1).max(255),
  declaredMediaType: z.string().trim().min(1).max(255),
  byteSize: z.number().int().positive().max(2 ** 40),
  /**
   * Declared before the bytes move: the grant binds this digest, so the object store
   * itself rejects any payload that does not hash to it (doc 09 §4 fail-closed).
   */
  sha256: sha256HexSchema,
  title: z.string().trim().min(1).max(200).optional(),
  documentId: z.uuid().optional(),
  expectedVersion: z.number().int().positive().optional(),
  engineeringRevision: z.string().trim().min(1).max(40).optional(),
});

export const initiateUploadResponseSchema = z.object({
  uploadSessionId: z.uuid(),
  expiresAt: z.string(),
  grant: z.object({
    method: z.literal('PUT'),
    url: z.string(),
    /** Every header here is inside the signature; changing one invalidates the grant. */
    headers: z.record(z.string(), z.string()),
  }),
});

export const finalizeUploadRequestSchema = z.object({
  byteSize: z.number().int().positive().max(2 ** 40),
  sha256: sha256HexSchema,
});

export const documentVersionStatusSchema = z.enum([
  'processing',
  'available',
  'quarantined',
  'revoked',
]);

export const scanStateSchema = z.enum([
  'quarantined',
  'scanning',
  'clean',
  'infected',
  'unsupported',
  'failed',
]);

export const documentVersionSchema = z.object({
  documentVersionId: z.uuid(),
  documentId: z.uuid(),
  versionNo: z.number().int().positive(),
  engineeringRevision: z.string().nullable(),
  originalFilename: z.string(),
  status: documentVersionStatusSchema,
  scanState: scanStateSchema,
  sha256: sha256HexSchema,
  byteSize: z.number().int().nonnegative(),
  /** Distinct audiences currently holding a live grant on this version. */
  audiences: z.array(z.enum(['internal', 'organization', 'auditor'])),
  createdAt: z.string(),
});

/** Resume support: a reloaded page asks what became of the session it started. */
export const uploadSessionStatusSchema = z.object({
  uploadSessionId: z.uuid(),
  status: z.enum(['initiated', 'finalized', 'expired', 'aborted']),
  purpose: documentPurposeSchema,
  filename: z.string(),
  byteSize: z.number().int().nonnegative(),
  expiresAt: z.string(),
  documentId: z.uuid().nullable(),
  documentVersionId: z.uuid().nullable(),
});

export const documentSummarySchema = z.object({
  documentId: z.uuid(),
  title: z.string(),
  logicalType: documentPurposeSchema,
  classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  currentVersionNo: z.number().int().nonnegative(),
  /**
   * The version an attach would actually use, with the two states that decide whether it
   * may be used at all (`BR-ENG-08`: owned by the reader's organization and scanned clean).
   * A summary without these cannot answer "can I attach this?", which is the only question
   * an enquiry asks of a document. Null until the first version finishes uploading.
   */
  currentVersionId: z.uuid().nullable(),
  currentVersionStatus: documentVersionStatusSchema.nullable(),
  currentVersionScanState: scanStateSchema.nullable(),
  aggregateVersion: z.number().int().positive(),
  createdAt: z.string(),
});

export const documentManifestSchema = z.object({
  document: documentSummarySchema,
  versions: z.array(documentVersionSchema),
});

export type DocumentPurpose = z.infer<typeof documentPurposeSchema>;
export type InitiateUploadRequest = z.infer<typeof initiateUploadRequestSchema>;
export type InitiateUploadResponse = z.infer<typeof initiateUploadResponseSchema>;
export type FinalizeUploadRequest = z.infer<typeof finalizeUploadRequestSchema>;
export type DocumentSummary = z.infer<typeof documentSummarySchema>;
export type DocumentVersionStatus = z.infer<typeof documentVersionStatusSchema>;
export type ScanState = z.infer<typeof scanStateSchema>;
export type DocumentVersionSummary = z.infer<typeof documentVersionSchema>;
export type DocumentManifest = z.infer<typeof documentManifestSchema>;
export type UploadSessionStatus = z.infer<typeof uploadSessionStatusSchema>;

/** Audience release (doc 09 §5). A grant names one immutable version — BR-ENG-02. */
export const audienceTypeSchema = z.enum(['internal', 'organization', 'auditor']);

export const grantActionSchema = z.enum(['view', 'download']);

export const grantAudienceRequestSchema = z
  .object({
    audienceType: audienceTypeSchema,
    organizationId: z.uuid().optional(),
    actions: z.array(grantActionSchema).min(1).max(2).default(['view', 'download']),
    /** A validity window that has already closed would grant nothing at all. */
    validUntil: z.iso
      .datetime()
      .refine((v) => new Date(v).getTime() > Date.now(), {
        message: 'validUntil must be in the future',
      })
      .optional(),
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .refine((v) => (v.audienceType === 'organization') === (v.organizationId !== undefined), {
    message: 'organizationId is required for, and only for, an organization audience',
    path: ['organizationId'],
  });

export const grantSummarySchema = z.object({
  grantId: z.uuid(),
  documentVersionId: z.uuid(),
  audienceType: audienceTypeSchema,
  organizationId: z.uuid().nullable(),
  actions: z.array(grantActionSchema),
  validUntil: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const downloadResponseSchema = z.object({
  /** Store-origin capability, never an application-origin path (doc 09 §4). */
  url: z.string(),
  filename: z.string(),
  sha256: sha256HexSchema,
  byteSize: z.number().int().nonnegative(),
  expiresAt: z.string(),
});

export type AudienceType = z.infer<typeof audienceTypeSchema>;
export type GrantAction = z.infer<typeof grantActionSchema>;
export type GrantAudienceRequest = z.infer<typeof grantAudienceRequestSchema>;
export type GrantSummary = z.infer<typeof grantSummarySchema>;
export type DownloadResponse = z.infer<typeof downloadResponseSchema>;
