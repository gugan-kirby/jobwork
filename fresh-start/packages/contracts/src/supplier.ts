import { z } from 'zod';

/**
 * Supplier network contracts (FR-105, FR-201..FR-203, doc 06 §14).
 * Nothing here that reaches a customer may carry supplier identity — see
 * `capabilityCardSchema`, which is deliberately the narrowest shape in the file.
 */

export const verificationKindSchema = z.enum([
  'gst',
  'udyam',
  'pan',
  'bank_account',
  'address_proof',
  'quality_system',
  'certification',
]);

export const verificationStatusSchema = z.enum([
  'draft',
  'submitted',
  'under_review',
  'verified',
  'returned_for_evidence',
  'expiring',
  'expired',
  'revoked',
]);

export const submitVerificationRequestSchema = z.object({
  kind: verificationKindSchema,
  referenceValue: z.string().trim().min(1).max(64).optional(),
  /** Evidence is a document version, which must already be scan-clean (BR-ENG-08). */
  evidenceDocumentVersionId: z.uuid().optional(),
  expiresAt: z.iso.datetime().optional(),
});

export const reviewVerificationRequestSchema = z
  .object({
    decision: z.enum(['verify', 'return']),
    reason: z.string().trim().min(1).max(300).optional(),
    /** A verifier may set or correct the expiry the evidence actually shows. */
    expiresAt: z.iso.datetime().optional(),
  })
  .refine((v) => v.decision !== 'return' || Boolean(v.reason), {
    message: 'Returning evidence requires a reason the supplier can act on',
    path: ['reason'],
  });

export const revokeVerificationRequestSchema = z.object({
  reason: z.string().trim().min(1).max(300),
});

export const verificationItemSchema = z.object({
  verificationItemId: z.uuid(),
  supplierProfileId: z.uuid(),
  kind: verificationKindSchema,
  versionNo: z.number().int().positive(),
  status: verificationStatusSchema,
  referenceValue: z.string().nullable(),
  evidenceDocumentVersionId: z.uuid().nullable(),
  expiresAt: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewReason: z.string().nullable(),
  createdAt: z.string(),
});

export const reviewQueueItemSchema = verificationItemSchema.extend({
  organizationId: z.uuid(),
  organizationName: z.string(),
  submittedAt: z.string().nullable(),
});

// ------------------------------------------------------------------ capabilities

export const capabilityKindSchema = z.enum(['process', 'material', 'finish']);

export const capabilityRefSchema = z.object({
  capabilityId: z.uuid(),
  code: z.string(),
  kind: capabilityKindSchema,
  label: z.string(),
  /** The family a process belongs to (Category → Sub category in the wizard); null for a family itself. */
  parentId: z.uuid().nullable().optional(),
  /** A family groups leaves for display; a requirement or declaration never points at one. */
  isFamily: z.boolean().optional(),
});

export const publishCapabilityRequestSchema = z.object({
  capabilityCode: z.string().trim().min(2).max(64),
  attributes: z.record(z.string(), z.unknown()).default({}),
  evidenceDocumentVersionId: z.uuid().optional(),
  validUntil: z.iso.datetime().optional(),
});

export const machineEnvelopeSchema = z.object({
  xMm: z.number().positive().max(100_000),
  yMm: z.number().positive().max(100_000),
  zMm: z.number().positive().max(100_000),
  maxWeightKg: z.number().positive().max(1_000_000).optional(),
});

export const registerMachineRequestSchema = z.object({
  machineKey: z.string().trim().min(2).max(64),
  label: z.string().trim().min(2).max(120),
  capabilityCode: z.string().trim().min(2).max(64).optional(),
  quantity: z.number().int().positive().max(999).default(1),
  axes: z.number().int().min(2).max(9).optional(),
  envelope: machineEnvelopeSchema,
});

export const declareCapacityRequestSchema = z
  .object({
    capabilityCode: z.string().trim().min(2).max(64).optional(),
    windowStart: z.iso.date(),
    windowEnd: z.iso.date(),
    availableHours: z.number().nonnegative().max(1_000_000).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .refine((v) => v.windowEnd >= v.windowStart, {
    message: 'windowEnd must not precede windowStart',
    path: ['windowEnd'],
  });

export const supplierCapabilitySchema = z.object({
  supplierCapabilityId: z.uuid(),
  capability: capabilityRefSchema,
  versionNo: z.number().int().positive(),
  status: z.enum(['published', 'superseded', 'withdrawn']),
  attributes: z.record(z.string(), z.unknown()),
  validFrom: z.string(),
  validUntil: z.string().nullable(),
});

export const machineSchema = z.object({
  machineId: z.uuid(),
  machineKey: z.string(),
  label: z.string(),
  versionNo: z.number().int().positive(),
  status: z.enum(['published', 'superseded', 'withdrawn']),
  quantity: z.number().int().positive(),
  axes: z.number().int().nullable(),
  envelope: machineEnvelopeSchema,
  capability: capabilityRefSchema.nullable(),
});

export const capacityWindowSchema = z.object({
  capacityWindowId: z.uuid(),
  versionNo: z.number().int().positive(),
  status: z.enum(['published', 'superseded', 'withdrawn']),
  windowStart: z.string(),
  windowEnd: z.string(),
  availableHours: z.number().nullable(),
  note: z.string().nullable(),
  capability: capabilityRefSchema.nullable(),
});

// ------------------------------------------------------------------- eligibility

export const exclusionCodeSchema = z.enum([
  'profile_not_active',
  /** The supplier's own statement that it cannot take work right now (F-SN). */
  'supplier_unavailable',
  'organization_suspended',
  'missing_mandatory_verification',
  'verification_expired',
  'verification_revoked',
  'no_published_capability',
  'certification_expired',
]);

export const eligibilitySchema = z.object({
  supplierProfileId: z.uuid(),
  organizationId: z.uuid(),
  eligible: z.boolean(),
  exclusions: z.array(exclusionCodeSchema),
  capabilityCodes: z.array(z.string()),
  evaluatedAt: z.string(),
});

/**
 * `FR-203`: the only supplier-shaped payload a customer may ever see. It carries no
 * organization id, no name, no address, and no contact — only what a capability can be
 * described as, plus a region class coarse enough not to identify a workshop. The
 * opaque `cardId` is derived, not the profile id, so cards cannot be correlated back.
 */
export const capabilityCardSchema = z.object({
  cardId: z.string(),
  regionClass: z.string(),
  capabilities: z.array(
    z.object({ code: z.string(), kind: capabilityKindSchema, label: z.string() }),
  ),
  certificationTypes: z.array(z.string()),
  machineEnvelopeMaxMm: z
    .object({ xMm: z.number(), yMm: z.number(), zMm: z.number() })
    .nullable(),
  verified: z.boolean(),
});

// ------------------------------------------------------------------- onboarding

/**
 * Network membership (F-SO). Deliberately not eligibility: an `active` supplier whose
 * GST evidence expired this morning is still a member of the network and still excluded
 * from matching. One is a relationship, the other is a computed verdict.
 */
export const supplierNetworkStatusSchema = z.enum([
  'onboarding',
  'submitted',
  'active',
  'paused',
  'rejected',
  'exited',
]);

export const employeeBandSchema = z.enum(['1-10', '11-50', '51-200', '201-500', '500+']);

export const supplierRoleKeySchema = z.enum([
  'org_admin',
  'supplier_estimator',
  'supplier_production',
  'supplier_quality',
]);

/** Indian identity numbers, checked for shape here and against evidence by a reviewer. */
export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, 'Not a valid GSTIN');

export const panSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Not a valid PAN');

/**
 * Admission (F-SO.2): JobWork creates the supplier organization and invites its first
 * user in one command, because a supplier organization nobody can sign into is not an
 * admission — it is a dangling row.
 */
export const admitSupplierRequestSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  displayName: z.string().trim().min(2).max(120),
  tradeName: z.string().trim().max(120).default(''),
  regionClass: z.string().trim().min(2).max(60),
  primaryContactName: z.string().trim().min(2).max(120),
  primaryContactEmail: z.email(),
  primaryContactPhone: z.string().trim().max(30).default(''),
  gstin: gstinSchema.optional(),
  pan: panSchema.optional(),
  firstUserEmail: z.email(),
  firstUserRoleKeys: z.array(supplierRoleKeySchema).min(1).max(4).default(['org_admin']),
  /** When admission answers a network application, the application is closed in the same transaction. */
  applicationId: z.uuid().optional(),
});

export const admitSupplierResponseSchema = z.object({
  supplierProfileId: z.uuid(),
  organizationId: z.uuid(),
  invitationId: z.uuid(),
  acceptUrl: z.string().optional(),
});

export const supplierProfileSchema = z.object({
  supplierProfileId: z.uuid(),
  organizationId: z.uuid(),
  legalName: z.string(),
  displayName: z.string(),
  tradeName: z.string(),
  website: z.string(),
  summary: z.string(),
  regionClass: z.string(),
  yearEstablished: z.number().int().nullable(),
  employeeBand: employeeBandSchema.nullable(),
  primaryContactName: z.string(),
  primaryContactEmail: z.string(),
  primaryContactPhone: z.string(),
  status: supplierNetworkStatusSchema,
  /** The supplier's own availability, distinct from JobWork's suspension. */
  acceptingWork: z.boolean(),
  acceptingWorkNote: z.string(),
  acceptingWorkUntil: z.string().nullable(),
  aggregateVersion: z.number().int().positive(),
  submittedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  worksSite: z
    .object({
      siteId: z.uuid(),
      label: z.string(),
      addressLine1: z.string(),
      addressLine2: z.string(),
      city: z.string(),
      state: z.string(),
      postalCode: z.string(),
      countryCode: z.string(),
      gstin: z.string().nullable(),
      contactName: z.string(),
      contactPhone: z.string(),
    })
    .nullable(),
});

export const updateSupplierProfileRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  tradeName: z.string().trim().max(120),
  website: z.string().trim().max(200),
  summary: z.string().trim().max(2000),
  regionClass: z.string().trim().min(2).max(60),
  yearEstablished: z.number().int().min(1800).max(2200).nullable(),
  employeeBand: employeeBandSchema.nullable(),
  primaryContactName: z.string().trim().max(120),
  primaryContactEmail: z.union([z.email(), z.literal('')]),
  primaryContactPhone: z.string().trim().max(30),
});

export const declareWorksSiteRequestSchema = z.object({
  label: z.string().trim().min(2).max(80),
  addressLine1: z.string().trim().min(3).max(200),
  addressLine2: z.string().trim().max(200).default(''),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  postalCode: z.string().trim().regex(/^[0-9]{6}$/, 'A six-digit PIN code'),
  gstin: gstinSchema.optional(),
  contactName: z.string().trim().max(120).default(''),
  contactPhone: z.string().trim().max(30).default(''),
});

/**
 * The onboarding checklist is computed from the same facts a reviewer decides on, so
 * the supplier is never told it is ready while the reviewer sees a gap (`FR-105`).
 */
export const checklistRowStateSchema = z.enum(['complete', 'incomplete', 'blocked']);

export const checklistRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  state: checklistRowStateSchema,
  /** A blocking row refuses submission and refuses approval. */
  blocking: z.boolean(),
  detail: z.string(),
});

export const certificationSchema = z.object({
  certificationId: z.uuid(),
  certificationType: z.string(),
  certificateNumber: z.string().nullable(),
  issuer: z.string().nullable(),
  issuedOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
  status: z.enum(['declared', 'verified', 'expired', 'revoked']),
  evidenceDocumentVersionId: z.uuid().nullable(),
});

export const declareCertificationRequestSchema = z
  .object({
    certificationType: z.string().trim().min(2).max(60),
    certificateNumber: z.string().trim().max(80).optional(),
    issuer: z.string().trim().max(120).optional(),
    issuedOn: z.iso.date().optional(),
    expiresOn: z.iso.date().optional(),
    evidenceDocumentVersionId: z.uuid().optional(),
  })
  .refine((v) => !v.issuedOn || !v.expiresOn || v.expiresOn >= v.issuedOn, {
    message: 'A certificate cannot expire before it was issued',
    path: ['expiresOn'],
  });

/** What a supplier sees about itself: its own record, never anyone else's. */
export const supplierSelfViewSchema = z.object({
  profile: supplierProfileSchema,
  checklist: z.array(checklistRowSchema),
  verification: z.array(verificationItemSchema),
  certifications: z.array(certificationSchema),
  capabilityCount: z.number().int().nonnegative(),
  machineCount: z.number().int().nonnegative(),
  eligible: z.boolean(),
  exclusions: z.array(exclusionCodeSchema),
  canSubmit: z.boolean(),
});

/** One row of the internal directory (F-SO.8). Internal audience only. */
export const supplierDirectoryRowSchema = z.object({
  supplierProfileId: z.uuid(),
  organizationId: z.uuid(),
  displayName: z.string(),
  legalName: z.string(),
  regionClass: z.string(),
  status: supplierNetworkStatusSchema,
  eligible: z.boolean(),
  exclusions: z.array(exclusionCodeSchema),
  capabilityCount: z.number().int().nonnegative(),
  blockingCount: z.number().int().nonnegative(),
  submittedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export const supplierDetailSchema = supplierSelfViewSchema.extend({
  members: z.array(
    z.object({
      userId: z.uuid(),
      email: z.string(),
      displayName: z.string(),
      roles: z.array(z.string()),
      status: z.string(),
    }),
  ),
  pendingInvitations: z.array(
    z.object({ invitationId: z.uuid(), email: z.string(), expiresAt: z.string() }),
  ),
});

export const setAvailabilityRequestSchema = z.object({
  acceptingWork: z.boolean(),
  /** What JobWork should know — "shutdown until Diwali", "one machine down". */
  note: z.string().trim().max(300).default(''),
  /** When the supplier expects to be back. Nothing happens automatically on that date. */
  acceptingWorkUntil: z.iso.date().optional(),
});

export const withdrawDeclarationRequestSchema = z.object({
  reason: z.string().trim().max(300).default(''),
});

/**
 * Leaving is terminal, so it is typed rather than clicked: the supplier confirms with
 * its own display name, the way any irreversible thing should be confirmed.
 */
export const exitNetworkRequestSchema = z.object({
  confirmation: z.string().trim().min(2).max(200),
  reason: z.string().trim().max(300).default(''),
});

/** What an admitted supplier needs to watch: dates, returns, and whether it is matchable. */
export const supplierQueueSchema = z.object({
  key: z.enum([
    'evidence_expiring',
    'evidence_expired',
    'evidence_returned',
    'certifications_expiring',
  ]),
  label: z.string(),
  detail: z.string(),
  count: z.number().int().nonnegative(),
  /** The nearest date in this queue — the one that decides when work stops. */
  nearestDate: z.string().nullable(),
  href: z.string(),
});

export const supplierSummarySchema = z.object({
  queues: z.array(supplierQueueSchema),
  matchable: z.boolean(),
  exclusions: z.array(exclusionCodeSchema),
  acceptingWork: z.boolean(),
  generatedAt: z.string(),
});

/** Every negative decision carries its reason; approval may carry one. */
export const supplierDecisionRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500).optional(),
});

export const supplierNegativeDecisionRequestSchema = supplierDecisionRequestSchema.extend({
  reason: z.string().trim().min(3).max(500),
});

export type SupplierNetworkStatus = z.infer<typeof supplierNetworkStatusSchema>;
export type EmployeeBand = z.infer<typeof employeeBandSchema>;
export type SupplierRoleKey = z.infer<typeof supplierRoleKeySchema>;
export type AdmitSupplierRequest = z.infer<typeof admitSupplierRequestSchema>;
export type AdmitSupplierResponse = z.infer<typeof admitSupplierResponseSchema>;
export type SupplierProfile = z.infer<typeof supplierProfileSchema>;
export type UpdateSupplierProfileRequest = z.infer<typeof updateSupplierProfileRequestSchema>;
export type DeclareWorksSiteRequest = z.infer<typeof declareWorksSiteRequestSchema>;
export type ChecklistRow = z.infer<typeof checklistRowSchema>;
export type ChecklistRowState = z.infer<typeof checklistRowStateSchema>;
export type Certification = z.infer<typeof certificationSchema>;
export type DeclareCertificationRequest = z.infer<typeof declareCertificationRequestSchema>;
export type SupplierSelfView = z.infer<typeof supplierSelfViewSchema>;
export type SupplierDirectoryRow = z.infer<typeof supplierDirectoryRowSchema>;
export type SupplierDetail = z.infer<typeof supplierDetailSchema>;
export type SupplierDecisionRequest = z.infer<typeof supplierDecisionRequestSchema>;
export type SetAvailabilityRequest = z.infer<typeof setAvailabilityRequestSchema>;
export type WithdrawDeclarationRequest = z.infer<typeof withdrawDeclarationRequestSchema>;
export type ExitNetworkRequest = z.infer<typeof exitNetworkRequestSchema>;
export type SupplierQueue = z.infer<typeof supplierQueueSchema>;
export type SupplierSummary = z.infer<typeof supplierSummarySchema>;
export type VerificationKind = z.infer<typeof verificationKindSchema>;
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;
export type SubmitVerificationRequest = z.infer<typeof submitVerificationRequestSchema>;
export type ReviewVerificationRequest = z.infer<typeof reviewVerificationRequestSchema>;
export type RevokeVerificationRequest = z.infer<typeof revokeVerificationRequestSchema>;
export type VerificationItem = z.infer<typeof verificationItemSchema>;
export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;
export type PublishCapabilityRequest = z.infer<typeof publishCapabilityRequestSchema>;
export type RegisterMachineRequest = z.infer<typeof registerMachineRequestSchema>;
export type DeclareCapacityRequest = z.infer<typeof declareCapacityRequestSchema>;
export type SupplierCapability = z.infer<typeof supplierCapabilitySchema>;
export type Machine = z.infer<typeof machineSchema>;
export type CapacityWindow = z.infer<typeof capacityWindowSchema>;
export type MachineEnvelope = z.infer<typeof machineEnvelopeSchema>;
export type ExclusionCode = z.infer<typeof exclusionCodeSchema>;
export type Eligibility = z.infer<typeof eligibilitySchema>;
export type CapabilityCard = z.infer<typeof capabilityCardSchema>;
export type CapabilityRef = z.infer<typeof capabilityRefSchema>;

// ------------------------------------------------------------- network applications

/**
 * A workshop's request to join the network (F-MX.4, prototype tile 3 "Vendor" tab).
 * It creates a request, never an account: admission stays JobWork's decision (F-SO).
 */
export const supplierApplicationRequestSchema = z.object({
  companyName: z.string().trim().min(2).max(200),
  contactName: z.string().trim().min(2).max(120),
  email: z.email(),
  phone: z.string().trim().max(30).default(''),
  city: z.string().trim().max(120).default(''),
  /** Process capability codes the workshop claims; validated against the taxonomy, not trusted. */
  processCodes: z.array(z.string().trim().min(2).max(64)).max(10).default([]),
  note: z.string().trim().max(1000).default(''),
  acceptTerms: z.literal(true),
});

export const supplierApplicationStatusSchema = z.enum(['received', 'admitted', 'declined']);

export const supplierApplicationSchema = z.object({
  applicationId: z.uuid(),
  companyName: z.string(),
  contactName: z.string(),
  email: z.string(),
  phone: z.string(),
  city: z.string(),
  processCodes: z.array(z.string()),
  note: z.string(),
  status: supplierApplicationStatusSchema,
  decidedAt: z.string().nullable(),
  decisionReason: z.string(),
  admittedOrganizationId: z.uuid().nullable(),
  createdAt: z.string(),
});

export const declineApplicationRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export type SupplierApplicationRequest = z.infer<typeof supplierApplicationRequestSchema>;
export type SupplierApplication = z.infer<typeof supplierApplicationSchema>;
export type SupplierApplicationStatus = z.infer<typeof supplierApplicationStatusSchema>;
export type DeclineApplicationRequest = z.infer<typeof declineApplicationRequestSchema>;
