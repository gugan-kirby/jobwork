import { z } from 'zod';

/**
 * RFQ and bid contracts (IN-06, `FR-304`–`FR-306`, `FR-401`).
 *
 * Two audiences read these types and neither may read the other's fields. The supplier
 * shapes (`supplierRfqSchema`, `supplierBidVersionSchema`) carry no customer identity —
 * no organization name, no contact, no delivery address, no sell-side value — and the
 * internal shapes carry everything. That separation is the whole reason the supplier
 * types exist rather than reusing the internal ones with fields omitted at runtime.
 */

export const rfqStatusSchema = z.enum([
  'draft',
  'internal_review',
  'open',
  'responses_received',
  'evaluation',
  'awarded',
  'no_bid',
  'expired',
  'cancelled',
  // F-12.5: the requirement was revised while the round was live; its bids stand as history.
  'superseded',
]);

export const invitationStatusSchema = z.enum([
  'prepared',
  'invited',
  'acknowledged',
  'clarifying',
  'responded',
  'declined',
  'no_response',
  'revoked',
]);

export const bidVersionStatusSchema = z.enum([
  'submitted',
  'superseded',
  'selected',
  'rejected',
  'withdrawn',
  'expired',
]);

export const lateBidPolicySchema = z.enum(['reject', 'accept_flagged']);

export const declineCodeSchema = z.enum([
  'capacity',
  'capability',
  'commercial',
  'lead_time',
  'material',
  'other',
]);

export const feasibilitySchema = z.enum(['feasible', 'feasible_with_deviation', 'not_feasible']);

export const taxTreatmentSchema = z.enum(['gst_extra', 'gst_inclusive', 'exempt']);

// ------------------------------------------------------------------ matching

export const matchCandidateSchema = z.object({
  supplierProfileId: z.uuid(),
  organizationId: z.uuid(),
  displayName: z.string(),
  regionClass: z.string(),
  eligible: z.boolean(),
  exclusions: z.array(z.string()),
  capabilityCodes: z.array(z.string()),
  /** Requirement codes this supplier does not publish — the technical half of a miss. */
  missingCapabilityCodes: z.array(z.string()),
});

export const matchResultSchema = z.object({
  enquiryId: z.uuid(),
  configVersion: z.string(),
  requiredCapabilityCodes: z.array(z.string()),
  candidates: z.array(matchCandidateSchema),
  eligibleCount: z.number().int().nonnegative(),
  evaluatedAt: z.string(),
});

// ------------------------------------------------------------------ RFQ (internal)

export const createRfqRequestSchema = z.object({
  enquiryId: z.uuid(),
  deadlineAt: z.iso.datetime(),
  lateBidPolicy: lateBidPolicySchema.default('reject'),
  instructions: z.string().trim().max(4000).default(''),
});

export const inviteSupplierRequestSchema = z.object({
  supplierProfileId: z.uuid(),
  /**
   * Required when the supplier is not eligible. `FR-205`: preference never bypasses
   * eligibility silently — an override is a decision somebody signs.
   */
  overrideReason: z.string().trim().min(3).max(500).optional(),
});

export const releaseRfqRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const revokeInvitationRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const closeRfqRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().max(500).optional(),
});

export const rfqItemSchema = z.object({
  rfqItemId: z.uuid(),
  lineNo: z.number().int().positive(),
  partName: z.string(),
  description: z.string(),
  quantityBreakpoints: z.array(
    z.object({
      quantity: z.number().positive(),
      unit: z.string(),
      kind: z.string().optional(),
    }),
  ),
  specification: z.record(z.string(), z.unknown()),
});

export const rfqReleaseItemSchema = z.object({
  documentVersionId: z.uuid(),
  role: z.enum(['governing', 'reference', 'assisted_photo']),
  sha256: z.string(),
});

export const rfqInvitationSchema = z.object({
  rfqSupplierId: z.uuid(),
  supplierProfileId: z.uuid(),
  organizationId: z.uuid(),
  displayName: z.string(),
  status: invitationStatusSchema,
  eligibleAtRelease: z.boolean(),
  exclusionsAtRelease: z.array(z.string()),
  overrideReason: z.string().nullable(),
  invitedAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  respondedAt: z.string().nullable(),
  declineCode: declineCodeSchema.nullable(),
  declineReason: z.string().nullable(),
  bidVersionCount: z.number().int().nonnegative(),
});

export const rfqSchema = z.object({
  rfqId: z.uuid(),
  enquiryId: z.uuid(),
  requirementId: z.uuid(),
  reference: z.string().nullable(),
  roundNo: z.number().int().positive(),
  status: rfqStatusSchema,
  currency: z.string(),
  deadlineAt: z.string().nullable(),
  lateBidPolicy: lateBidPolicySchema,
  instructions: z.string(),
  aggregateVersion: z.number().int().positive(),
  releasedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  outcomeReason: z.string().nullable(),
  items: z.array(rfqItemSchema),
  release: z.array(rfqReleaseItemSchema),
  invitations: z.array(rfqInvitationSchema),
});

// ------------------------------------------------------------------ bids

export const bidLineSchema = z.object({
  rfqItemId: z.uuid(),
  lineNo: z.number().int().positive(),
  quantity: z.number().positive(),
  unit: z.string(),
  unitPriceMinor: z.number().int().nonnegative(),
  setupAmountMinor: z.number().int().nonnegative().default(0),
  leadTimeDays: z.number().int().positive().optional(),
  note: z.string().max(500).default(''),
});

export const bidDraftSchema = z.object({
  currency: z.string().length(3).default('INR'),
  taxTreatment: taxTreatmentSchema.default('gst_extra'),
  lines: z.array(bidLineSchema),
  nreAmountMinor: z.number().int().nonnegative().default(0),
  freightAmountMinor: z.number().int().nonnegative().default(0),
  leadTimeDays: z.number().int().positive(),
  validityUntil: z.iso.date(),
  feasibility: feasibilitySchema.default('feasible'),
  assumptions: z.string().max(2000).default(''),
  exclusions: z.string().max(2000).default(''),
  paymentTerms: z.string().max(500).default(''),
  note: z.string().max(2000).default(''),
});

export const saveBidDraftRequestSchema = z.object({
  draft: bidDraftSchema.partial(),
});

export const submitBidRequestSchema = bidDraftSchema.extend({
  /** Required from the second version on: a revision says what changed and why. */
  revisionReason: z.string().trim().max(500).optional(),
});

export const withdrawBidRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const acknowledgeRfqRequestSchema = z.object({
  note: z.string().trim().max(500).default(''),
});

export const declineRfqRequestSchema = z.object({
  declineCode: declineCodeSchema,
  reason: z.string().trim().min(3).max(500),
});

export const bidVersionSchema = z.object({
  bidVersionId: z.uuid(),
  versionNo: z.number().int().positive(),
  status: bidVersionStatusSchema,
  currency: z.string(),
  taxTreatment: taxTreatmentSchema,
  linesTotalMinor: z.number().int().nonnegative(),
  nreAmountMinor: z.number().int().nonnegative(),
  freightAmountMinor: z.number().int().nonnegative(),
  totalAmountMinor: z.number().int().nonnegative(),
  leadTimeDays: z.number().int().positive(),
  validityUntil: z.string(),
  feasibility: feasibilitySchema,
  assumptions: z.string(),
  exclusions: z.string(),
  paymentTerms: z.string(),
  note: z.string(),
  contentHash: z.string(),
  receivedAt: z.string(),
  late: z.boolean(),
  revisionReason: z.string().nullable(),
  lines: z.array(
    bidLineSchema.extend({ setupAmountMinor: z.number().int().nonnegative() }),
  ),
});

export const supplierBidSchema = z.object({
  supplierBidId: z.uuid(),
  rfqId: z.uuid(),
  currentVersionNo: z.number().int().nonnegative(),
  draft: bidDraftSchema.partial(),
  versions: z.array(bidVersionSchema),
});

/**
 * What a supplier sees of an RFQ (`BR-COM-06`). Deliberately narrow: a reference, the
 * lines, the released documents, the deadline and its own invitation. There is no
 * customer field on this type at all, so no code path can leak one by forgetting to
 * strip it.
 */
export const supplierRfqSchema = z.object({
  rfqId: z.uuid(),
  reference: z.string().nullable(),
  roundNo: z.number().int().positive(),
  status: rfqStatusSchema,
  currency: z.string(),
  deadlineAt: z.string().nullable(),
  lateBidPolicy: lateBidPolicySchema,
  instructions: z.string(),
  invitationStatus: invitationStatusSchema,
  invitedAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  items: z.array(rfqItemSchema),
  documents: z.array(
    z.object({
      documentVersionId: z.uuid(),
      role: z.enum(['governing', 'reference', 'assisted_photo']),
      sha256: z.string(),
      filename: z.string(),
    }),
  ),
  bid: supplierBidSchema.nullable(),
});

export const supplierRfqListItemSchema = z.object({
  rfqId: z.uuid(),
  reference: z.string().nullable(),
  status: rfqStatusSchema,
  invitationStatus: invitationStatusSchema,
  deadlineAt: z.string().nullable(),
  itemCount: z.number().int().nonnegative(),
  bidVersionCount: z.number().int().nonnegative(),
});

export type RfqStatus = z.infer<typeof rfqStatusSchema>;
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;
export type BidVersionStatus = z.infer<typeof bidVersionStatusSchema>;
export type LateBidPolicy = z.infer<typeof lateBidPolicySchema>;
export type DeclineCode = z.infer<typeof declineCodeSchema>;
export type MatchCandidate = z.infer<typeof matchCandidateSchema>;
export type MatchResult = z.infer<typeof matchResultSchema>;
export type CreateRfqRequest = z.infer<typeof createRfqRequestSchema>;
export type InviteSupplierRequest = z.infer<typeof inviteSupplierRequestSchema>;
export type ReleaseRfqRequest = z.infer<typeof releaseRfqRequestSchema>;
export type RevokeInvitationRequest = z.infer<typeof revokeInvitationRequestSchema>;
export type CloseRfqRequest = z.infer<typeof closeRfqRequestSchema>;
export type Rfq = z.infer<typeof rfqSchema>;
export type RfqItem = z.infer<typeof rfqItemSchema>;
export type RfqInvitation = z.infer<typeof rfqInvitationSchema>;
export type BidDraft = z.infer<typeof bidDraftSchema>;
export type BidLine = z.infer<typeof bidLineSchema>;
export type SaveBidDraftRequest = z.infer<typeof saveBidDraftRequestSchema>;
export type SubmitBidRequest = z.infer<typeof submitBidRequestSchema>;
export type WithdrawBidRequest = z.infer<typeof withdrawBidRequestSchema>;
export type AcknowledgeRfqRequest = z.infer<typeof acknowledgeRfqRequestSchema>;
export type DeclineRfqRequest = z.infer<typeof declineRfqRequestSchema>;
export type BidVersion = z.infer<typeof bidVersionSchema>;
export type SupplierBid = z.infer<typeof supplierBidSchema>;
export type SupplierRfq = z.infer<typeof supplierRfqSchema>;
export type SupplierRfqListItem = z.infer<typeof supplierRfqListItemSchema>;
