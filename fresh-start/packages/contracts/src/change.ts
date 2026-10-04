import { z } from 'zod';

/**
 * Engineering change control (IN-13 F-13.2; doc 06 §9; doc 09 §§7–8). Three audiences:
 * JobWork sees everything; the customer sees the change, its effect on its price and
 * delivery, and its own decision; a supplier sees only JobWork's brief, the interim
 * decisions on its own purchase orders and its own amendment.
 */

export const changeStatusSchema = z.enum([
  'proposed',
  'triage',
  'clarification',
  'impact_analysis',
  'commercial_approval',
  'approved',
  'rejected',
  'released',
  'implemented',
  'verified',
  'closed',
  'withdrawn',
]);
export const changeOriginSchema = z.enum(['customer', 'supplier', 'internal', 'document_revision']);
export const changeClassificationSchema = z.enum(['clarification', 'correction', 'scope']);
export const changeUrgencySchema = z.enum(['normal', 'urgent']);

/** Doc 09 §8: every area is answered, or marked not applicable with a reason. */
export const IMPACT_AREAS = ['configuration', 'wip', 'process_tooling', 'quality', 'commercial', 'schedule', 'contract', 'logistics'] as const;
export const impactAreaSchema = z.enum(IMPACT_AREAS);
export const impactAnswerSchema = z.discriminatedUnion('applicable', [
  z.object({ applicable: z.literal(true), answer: z.string().trim().min(3).max(2000) }),
  z.object({ applicable: z.literal(false), reason: z.string().trim().min(3).max(500) }),
]);
export const wipDispositionSchema = z.enum(['reuse', 'rework', 'scrap']);

const reason = z.string().trim().min(3).max(2000);
const versioned = { expectedVersion: z.number().int().positive() };

export const proposeChangeRequestSchema = z.object({
  salesOrderId: z.uuid(),
  title: z.string().trim().min(3).max(200),
  reason,
  urgency: changeUrgencySchema.default('normal'),
  /** JobWork only: who asked, when it was not JobWork itself. */
  origin: z.enum(['internal', 'supplier']).optional(),
  contextDocumentVersionIds: z.array(z.uuid()).max(20).default([]),
});

export const changeVersionRequestSchema = z.object(versioned);
export const requestChangeInfoSchema = z.object({ ...versioned, question: reason });
export const provideChangeInfoSchema = z.object({ ...versioned, answer: reason });
export const classifyChangeSchema = z.object({
  ...versioned,
  classification: changeClassificationSchema,
  supplierBrief: z.string().trim().max(2000).default(''),
  note: z.string().trim().max(2000).default(''),
});
export const withdrawChangeSchema = z.object({ ...versioned, reason });

export const issueInterimDecisionSchema = z.object({
  purchaseOrderIds: z.array(z.uuid()).min(1).max(20),
  decision: z.enum(['stop', 'continue']),
  reason: z.string().trim().min(3).max(1000),
  expiresAt: z.iso.datetime(),
});
export const liftInterimDecisionSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const recordImpactSchema = z.object({
  ...versioned,
  areas: z.record(impactAreaSchema, impactAnswerSchema),
  /** Tax-inclusive change to what the customer pays; negative is a credit. */
  customerPriceDeltaMinor: z.number().int(),
  deliveryDateDeltaDays: z.number().int().min(-365).max(365),
  purchaseOrders: z
    .array(z.object({ purchaseOrderId: z.uuid(), costDeltaMinor: z.number().int(), leadTimeDeltaDays: z.number().int().min(-365).max(365) }))
    .max(20)
    .default([]),
  wip: z
    .array(
      z.object({
        purchaseOrderId: z.uuid(),
        quantity: z.number().positive(),
        disposition: wipDispositionSchema,
        costMinor: z.number().int().nonnegative(),
        note: z.string().trim().max(500).default(''),
      }),
    )
    .max(50)
    .default([]),
  candidateBaselineId: z.uuid().optional(),
});

export const customerChangeDecisionSchema = z.object({
  ...versioned,
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().max(1000).default(''),
  acknowledgeEffect: z.literal(true),
});

export const supplierImpactSchema = z.object({
  purchaseOrderId: z.uuid(),
  costDeltaMinor: z.number().int(),
  leadTimeDeltaDays: z.number().int().min(-365).max(365),
  wip: z
    .array(z.object({ quantity: z.number().positive(), disposition: wipDispositionSchema, costMinor: z.number().int().nonnegative(), note: z.string().trim().max(500).default('') }))
    .max(50)
    .default([]),
  note: z.string().trim().max(2000).default(''),
});
export const supplierChangeAcknowledgeSchema = z.object({ purchaseOrderId: z.uuid(), note: z.string().trim().max(1000).default('') });
export const verifyChangeSchema = z.object({ ...versioned, note: reason });

const impactVersionSchema = z.object({
  versionNo: z.number().int().positive(),
  areas: z.record(z.string(), impactAnswerSchema),
  customerPriceDeltaMinor: z.number().int(),
  deliveryDateDeltaDays: z.number().int(),
  purchaseOrders: z.array(z.object({ purchaseOrderId: z.uuid(), costDeltaMinor: z.number().int(), leadTimeDeltaDays: z.number().int() })),
  wip: z.array(z.object({ purchaseOrderId: z.uuid(), quantity: z.number(), disposition: wipDispositionSchema, costMinor: z.number().int(), note: z.string() })),
  recordedAt: z.string(),
});

const interimDecisionSchema = z.object({
  interimDecisionId: z.uuid(),
  purchaseOrderId: z.uuid(),
  purchaseOrderNumber: z.string(),
  decision: z.enum(['stop', 'continue']),
  reason: z.string(),
  expiresAt: z.string(),
  issuedAt: z.string(),
  liftedAt: z.string().nullable(),
  liftReason: z.string().nullable(),
  active: z.boolean(),
});

const poAmendmentSchema = z.object({
  purchaseOrderId: z.uuid(),
  purchaseOrderNumber: z.string(),
  costDeltaMinor: z.number().int(),
  leadTimeDeltaDays: z.number().int(),
  transmittalId: z.uuid(),
  acknowledgedAt: z.string().nullable(),
});

/** JobWork's whole view of a change. */
export const changeRequestSchema = z.object({
  changeRequestId: z.uuid(),
  number: z.string(),
  salesOrderId: z.uuid(),
  salesOrderNumber: z.string(),
  origin: changeOriginSchema,
  classification: changeClassificationSchema.nullable(),
  urgency: changeUrgencySchema,
  title: z.string(),
  reason: z.string(),
  status: changeStatusSchema,
  infoRequest: z.string().nullable(),
  infoResponse: z.string().nullable(),
  supplierBrief: z.string(),
  customerApprovalRequired: z.boolean().nullable(),
  approvalRequestId: z.uuid().nullable(),
  candidateBaselineId: z.uuid().nullable(),
  releasedBaselineId: z.uuid().nullable(),
  contextDocumentVersionIds: z.array(z.uuid()),
  outcomeNote: z.string().nullable(),
  impact: impactVersionSchema.nullable(),
  impactComplete: z.boolean(),
  missingAreas: z.array(z.string()),
  supplierImpacts: z.array(
    z.object({ purchaseOrderId: z.uuid(), supplierDisplayName: z.string(), costDeltaMinor: z.number().int(), leadTimeDeltaDays: z.number().int(), wip: z.array(z.record(z.string(), z.unknown())), note: z.string(), submittedAt: z.string() }),
  ),
  interimDecisions: z.array(interimDecisionSchema),
  customerDecision: z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string(), decidedAt: z.string() }).nullable(),
  amendments: z.array(poAmendmentSchema),
  proposedAt: z.string(),
  closedAt: z.string().nullable(),
  aggregateVersion: z.number().int().positive(),
});

/** The customer's view: the change and its effect on what it pays and when; nothing of the buy side. */
export const customerChangeSchema = z.object({
  changeRequestId: z.uuid(),
  number: z.string(),
  orderId: z.uuid(),
  orderNumber: z.string(),
  title: z.string(),
  reason: z.string(),
  status: changeStatusSchema,
  infoRequest: z.string().nullable(),
  infoResponse: z.string().nullable(),
  priceDeltaMinor: z.number().int().nullable(),
  currency: z.string(),
  deliveryDateDeltaDays: z.number().int().nullable(),
  decisionNeeded: z.boolean(),
  canDecide: z.boolean(),
  decision: z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string(), decidedAt: z.string() }).nullable(),
  proposedAt: z.string(),
  aggregateVersion: z.number().int().positive(),
});

/** A supplier's view: JobWork's brief and only what touches its own purchase orders. */
export const supplierChangeSchema = z.object({
  changeRequestId: z.uuid(),
  number: z.string(),
  brief: z.string(),
  status: changeStatusSchema,
  purchaseOrders: z.array(
    z.object({
      purchaseOrderId: z.uuid(),
      purchaseOrderNumber: z.string(),
      interimDecisions: z.array(interimDecisionSchema),
      amendment: poAmendmentSchema.nullable(),
      impactSubmitted: z.boolean(),
    }),
  ),
  impactInvited: z.boolean(),
});

export type ChangeStatus = z.infer<typeof changeStatusSchema>;
export type ChangeOrigin = z.infer<typeof changeOriginSchema>;
export type ChangeClassification = z.infer<typeof changeClassificationSchema>;
export type ImpactArea = z.infer<typeof impactAreaSchema>;
export type ImpactAnswer = z.infer<typeof impactAnswerSchema>;
export type ProposeChangeRequest = z.infer<typeof proposeChangeRequestSchema>;
export type ChangeVersionRequest = z.infer<typeof changeVersionRequestSchema>;
export type RequestChangeInfo = z.infer<typeof requestChangeInfoSchema>;
export type ProvideChangeInfo = z.infer<typeof provideChangeInfoSchema>;
export type ClassifyChange = z.infer<typeof classifyChangeSchema>;
export type WithdrawChange = z.infer<typeof withdrawChangeSchema>;
export type IssueInterimDecision = z.infer<typeof issueInterimDecisionSchema>;
export type LiftInterimDecision = z.infer<typeof liftInterimDecisionSchema>;
export type RecordImpact = z.infer<typeof recordImpactSchema>;
export type CustomerChangeDecision = z.infer<typeof customerChangeDecisionSchema>;
export type SupplierImpact = z.infer<typeof supplierImpactSchema>;
export type SupplierChangeAcknowledge = z.infer<typeof supplierChangeAcknowledgeSchema>;
export type VerifyChange = z.infer<typeof verifyChangeSchema>;
export type ChangeRequest = z.infer<typeof changeRequestSchema>;
export type CustomerChange = z.infer<typeof customerChangeSchema>;
export type SupplierChange = z.infer<typeof supplierChangeSchema>;
