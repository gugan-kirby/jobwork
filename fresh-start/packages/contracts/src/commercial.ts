import { z } from 'zod';

/**
 * Internal commercial contracts (IN-07, `FR-402`–`FR-406`). Everything here is
 * JobWork-only: evaluations name suppliers and originals, cost sheets carry margin,
 * awards cite bid versions. None of these shapes is ever returned to a customer or a
 * supplier; the customer sees `customer-quote.ts` and nothing else.
 */

// ------------------------------------------------------------------ evaluation

export const nreAllocationPolicySchema = z.enum(['quantity', 'value', 'equal', 'direct']);

export const evaluationScenarioSchema = z.object({
  /** Which bid freight figure to compare on: what was quoted, or one estimate for all. */
  freightPolicy: z.enum(['as_quoted', 'estimate']).default('as_quoted'),
  freightEstimateMinor: z.number().int().nonnegative().default(0),
  nreAllocation: nreAllocationPolicySchema.default('value'),
  /** Per-bid allowance for JobWork's inspection and packaging effort. */
  inspectionPackagingMinor: z.number().int().nonnegative().default(0),
  /** Financing/risk adjustment applied to item cost, in basis points. */
  financingRiskBp: z.number().int().min(0).max(5000).default(0),
  gstRateBp: z.number().int().min(0).max(5000).default(1800),
  /** Whether input GST on the buy side is recoverable (then it is not a cost). */
  taxAssumption: z.enum(['recoverable', 'non_recoverable']).default('recoverable'),
  note: z.string().trim().max(1000).default(''),
});

export const evaluationLineSchema = z.object({
  rfqItemId: z.uuid(),
  lineNo: z.number().int().positive(),
  quantity: z.number().positive(),
  unit: z.string(),
  originalLineMinor: z.number().int().nonnegative(),
  nreAllocatedMinor: z.number().int().nonnegative(),
  normalizedLineMinor: z.number().int().nonnegative(),
});

export const evaluationComponentsSchema = z.object({
  itemCostMinor: z.number().int().nonnegative(),
  itemCostExTaxMinor: z.number().int().nonnegative(),
  nreMinor: z.number().int().nonnegative(),
  freightMinor: z.number().int().nonnegative(),
  inspectionPackagingMinor: z.number().int().nonnegative(),
  financingRiskMinor: z.number().int().nonnegative(),
  nonRecoverableTaxMinor: z.number().int().nonnegative(),
});

export const evaluationRowSchema = z.object({
  bidVersionId: z.uuid(),
  supplierOrganizationId: z.uuid(),
  supplierDisplayName: z.string(),
  versionNo: z.number().int().positive(),
  originalTotalMinor: z.number().int().nonnegative(),
  normalizedLandedMinor: z.number().int().nonnegative(),
  components: evaluationComponentsSchema,
  lines: z.array(evaluationLineSchema),
  leadTimeDays: z.number().int().positive(),
  validityUntil: z.string(),
  feasibility: z.string(),
  rank: z.number().int().positive(),
  flags: z.array(z.enum(['late', 'single_source', 'expiring_validity', 'deviation', 'not_feasible'])),
});

export const evaluationSchema = z.object({
  evaluationId: z.uuid(),
  rfqId: z.uuid(),
  configVersion: z.string(),
  scenario: evaluationScenarioSchema,
  scenarioHash: z.string(),
  currency: z.string(),
  rows: z.array(evaluationRowSchema),
  createdAt: z.string(),
});

export const createEvaluationRequestSchema = z.object({
  /** Absent means the default scenario; the command parses `{}` through the schema. */
  scenario: evaluationScenarioSchema.optional(),
});

// ------------------------------------------------------------------ approvals

export const approvalKindSchema = z.enum(['award', 'cost_sheet', 'quote', 'allocation', 'change', 'deviation']);
export const approvalRequestStatusSchema = z.enum(['pending', 'approved', 'rejected', 'returned', 'superseded']);
export const approvalDecisionKindSchema = z.enum(['approved', 'rejected', 'returned']);

export const approvalDecisionSchema = z.object({
  decisionId: z.uuid(),
  decision: approvalDecisionKindSchema,
  decidedBy: z.uuid(),
  decidedByName: z.string(),
  decidedAt: z.string(),
  authoritySnapshot: z.object({ roles: z.array(z.string()), organizationId: z.uuid().nullable() }),
  reason: z.string(),
});

export const approvalRequestSchema = z.object({
  approvalRequestId: z.uuid(),
  kind: approvalKindSchema,
  subjectType: z.string(),
  subjectId: z.uuid(),
  subjectVersionNo: z.number().int().positive().nullable(),
  subjectHash: z.string(),
  policyVersionId: z.uuid(),
  policyVersionNo: z.number().int().positive(),
  requestedBy: z.uuid(),
  requestedByName: z.string(),
  requestedAt: z.string(),
  amountMinor: z.number().int().nullable(),
  currency: z.string().nullable(),
  marginBp: z.number().int().nullable(),
  context: z.record(z.string(), z.unknown()),
  requiredRoles: z.array(z.string()),
  status: approvalRequestStatusSchema,
  decidedAt: z.string().nullable(),
  decisions: z.array(approvalDecisionSchema),
  /** Where the subject lives in the operations app. */
  href: z.string(),
  title: z.string(),
});

export const decideApprovalRequestSchema = z.object({
  decision: approvalDecisionKindSchema,
  reason: z.string().trim().max(1000).default(''),
});

// ------------------------------------------------------------------ award

export const awardStatusSchema = z.enum(['proposed', 'approved', 'rejected', 'withdrawn']);

export const proposeAwardRequestSchema = z.object({
  rfqId: z.uuid(),
  evaluationId: z.uuid().optional(),
  items: z
    .array(
      z.object({
        rfqItemId: z.uuid(),
        /** What the award covers for this line; split lines must sum to it. */
        targetQuantity: z.number().positive(),
        lines: z
          .array(
            z.object({
              bidVersionId: z.uuid(),
              /** The bid breakpoint the price is read from. */
              bidQuantity: z.number().positive(),
              quantity: z.number().positive(),
            }),
          )
          .min(1)
          .max(10),
      }),
    )
    .min(1)
    .max(50),
  rationale: z.string().trim().min(3).max(2000),
  /** Required when the round is single-source: what happens if this supplier fails. */
  fallbackNote: z.string().trim().max(1000).default(''),
});

export const awardLineSchema = z.object({
  awardLineId: z.uuid(),
  rfqItemId: z.uuid(),
  lineNo: z.number().int().positive(),
  bidVersionId: z.uuid(),
  supplierOrganizationId: z.uuid(),
  supplierDisplayName: z.string(),
  bidQuantity: z.number().positive(),
  quantity: z.number().positive(),
  unit: z.string(),
  unitPriceMinor: z.number().int().nonnegative(),
  setupAmountMinor: z.number().int().nonnegative(),
  /** The bid's own freight to JobWork and tooling/NRE, on the first line citing that bid (0019). */
  freightAmountMinor: z.number().int().nonnegative(),
  nreAmountMinor: z.number().int().nonnegative(),
  lineTotalMinor: z.number().int().nonnegative(),
});

export const awardSchema = z.object({
  awardId: z.uuid(),
  rfqId: z.uuid(),
  rfqReference: z.string().nullable(),
  enquiryId: z.uuid(),
  evaluationId: z.uuid().nullable(),
  status: awardStatusSchema,
  singleSource: z.boolean(),
  rationale: z.string(),
  fallbackNote: z.string(),
  proposedBy: z.uuid(),
  proposedAt: z.string(),
  approvalRequestId: z.uuid().nullable(),
  approvalStatus: approvalRequestStatusSchema.nullable(),
  decidedAt: z.string().nullable(),
  currency: z.string(),
  buyTotalMinor: z.number().int().nonnegative(),
  lines: z.array(awardLineSchema),
  costSheetId: z.uuid().nullable(),
  aggregateVersion: z.number().int().positive(),
});

// ------------------------------------------------------------------ cost sheet

export const costSheetStatusSchema = z.enum(['draft', 'pending_approval', 'approved', 'returned', 'superseded']);

export const costComponentCodeSchema = z.enum([
  'freight_inbound',
  'freight_outbound',
  'inspection',
  'quality_reserve',
  'packaging',
  'logistics_handling',
  'finance',
  'risk_contingency',
  'engineering',
  'other',
]);

export const costComponentSchema = z.object({
  code: costComponentCodeSchema,
  label: z.string().trim().min(1).max(120),
  amountMinor: z.number().int().nonnegative(),
  basis: z.string().trim().max(200).default(''),
});

export const sellLineSchema = z.object({
  rfqItemId: z.uuid(),
  lineNo: z.number().int().positive(),
  description: z.string(),
  quantity: z.number().positive(),
  unit: z.string(),
  landedLineMinor: z.number().int().nonnegative(),
  unitSellMinor: z.number().int().nonnegative(),
  amountMinor: z.number().int().nonnegative(),
});

export const saveCostSheetRequestSchema = z.object({
  components: z.array(costComponentSchema).max(20).default([]),
  /** Target margin on the sell price, in basis points (1000 = 10 %). Negative is allowed and blocks. */
  targetMarginBp: z.number().int().min(-10000).max(9000),
  note: z.string().trim().max(2000).default(''),
});

export const costSheetVersionSchema = z.object({
  costSheetVersionId: z.uuid(),
  versionNo: z.number().int().positive(),
  status: costSheetStatusSchema,
  currency: z.string(),
  buyTotalMinor: z.number().int().nonnegative(),
  components: z.array(costComponentSchema),
  landedTotalMinor: z.number().int().nonnegative(),
  marginMinor: z.number().int(),
  marginBp: z.number().int(),
  sellTotalMinor: z.number().int().nonnegative(),
  sellLines: z.array(sellLineSchema),
  note: z.string(),
  contentHash: z.string(),
  approvalRequestId: z.uuid().nullable(),
  approvalStatus: approvalRequestStatusSchema.nullable(),
  createdAt: z.string(),
  supersedesVersionId: z.uuid().nullable(),
});

export const costSheetSchema = z.object({
  costSheetId: z.uuid(),
  rfqId: z.uuid(),
  awardId: z.uuid(),
  enquiryId: z.uuid(),
  customerOrganizationId: z.uuid(),
  status: costSheetStatusSchema,
  currentVersionNo: z.number().int().nonnegative(),
  aggregateVersion: z.number().int().positive(),
  /** Policy floor the current version is judged against, for the UI to warn before asking. */
  minMarginBp: z.number().int(),
  versions: z.array(costSheetVersionSchema),
});

// ------------------------------------------------------------------ customer quote (internal)

export const quoteOptionLabelSchema = z.enum(['standard', 'fast', 'premium']);
export const quoteStatusSchema = z.enum([
  'draft',
  'internal_approval',
  'approved',
  'sent',
  'revision_requested',
  'accepted',
  'rejected',
  'expired',
  'withdrawn',
]);
export const quoteVersionStatusSchema = z.enum([
  'draft',
  'internal_approval',
  'approved',
  'sent',
  'superseded',
  'accepted',
  'rejected',
  'expired',
  'withdrawn',
]);

export const quoteLineInputSchema = z.object({
  lineNo: z.number().int().positive(),
  description: z.string().trim().min(1).max(300),
  quantity: z.number().positive(),
  unit: z.string().trim().min(1).max(20),
  unitPriceMinor: z.number().int().nonnegative(),
});

export const quoteContentInputSchema = z.object({
  lines: z.array(quoteLineInputSchema).min(1).max(50),
  taxRateBp: z.number().int().min(0).max(5000).default(1800),
  freightMinor: z.number().int().nonnegative().default(0),
  deliveryLeadDays: z.number().int().positive().max(365),
  paymentTerms: z.string().trim().min(1).max(500),
  /** Structured schedule (IN-08, doc 10 §4): share due at acceptance, and when the balance falls due. */
  advanceBp: z.number().int().min(0).max(10000).default(5000),
  balanceTrigger: z.enum(['on_acceptance', 'before_dispatch', 'on_delivery', 'net_30']).default('before_dispatch'),
  validityUntil: z.iso.date(),
  assumptions: z.string().trim().max(2000).default(''),
  exclusions: z.string().trim().max(2000).default(''),
  scopeNote: z.string().trim().max(2000).default(''),
});

export const draftQuoteRequestSchema = z.object({
  costSheetVersionId: z.uuid(),
  optionLabel: quoteOptionLabelSchema.default('standard'),
  /** Omitted lines/prices are taken from the approved cost sheet's sell lines. */
  content: quoteContentInputSchema.partial({ lines: true }).extend({
    lines: z.array(quoteLineInputSchema).min(1).max(50).optional(),
  }),
});

export const replaceQuoteRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  revisionReason: z.string().trim().min(3).max(1000),
  content: quoteContentInputSchema,
});

export const quoteVersionActionRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const withdrawQuoteRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
});

export const quoteLineSchema = quoteLineInputSchema.extend({
  amountMinor: z.number().int().nonnegative(),
});

export const quoteVersionSchema = z.object({
  quoteVersionId: z.uuid(),
  versionNo: z.number().int().positive(),
  status: quoteVersionStatusSchema,
  currency: z.string(),
  lines: z.array(quoteLineSchema),
  subtotalMinor: z.number().int().nonnegative(),
  taxRateBp: z.number().int(),
  taxMinor: z.number().int().nonnegative(),
  freightMinor: z.number().int().nonnegative(),
  totalMinor: z.number().int().nonnegative(),
  deliveryLeadDays: z.number().int().positive(),
  paymentTerms: z.string(),
  validityUntil: z.string(),
  assumptions: z.string(),
  exclusions: z.string(),
  scopeNote: z.string(),
  advanceBp: z.number().int(),
  balanceTrigger: z.enum(['on_acceptance', 'before_dispatch', 'on_delivery', 'net_30']),
  termsVersionId: z.uuid(),
  termsVersionNo: z.number().int().positive(),
  termsHash: z.string(),
  contentHash: z.string(),
  approvalRequestId: z.uuid().nullable(),
  approvalStatus: approvalRequestStatusSchema.nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
  supersedesVersionId: z.uuid().nullable(),
  revisionReason: z.string().nullable(),
});

export const quoteSchema = z.object({
  quoteId: z.uuid(),
  offerSetId: z.uuid(),
  enquiryId: z.uuid(),
  enquiryReference: z.string().nullable(),
  enquiryTitle: z.string(),
  rfqId: z.uuid().nullable(),
  customerOrganizationId: z.uuid(),
  customerDisplayName: z.string(),
  optionLabel: quoteOptionLabelSchema,
  reference: z.string().nullable(),
  costSheetVersionId: z.uuid().nullable(),
  status: quoteStatusSchema,
  currentVersionNo: z.number().int().nonnegative(),
  decisionReason: z.string().nullable(),
  acceptedVersionId: z.uuid().nullable(),
  aggregateVersion: z.number().int().positive(),
  createdAt: z.string(),
  versions: z.array(quoteVersionSchema),
});

export type EvaluationScenario = z.infer<typeof evaluationScenarioSchema>;
export type EvaluationRow = z.infer<typeof evaluationRowSchema>;
export type EvaluationLine = z.infer<typeof evaluationLineSchema>;
export type EvaluationComponents = z.infer<typeof evaluationComponentsSchema>;
export type Evaluation = z.infer<typeof evaluationSchema>;
export type CreateEvaluationRequest = z.infer<typeof createEvaluationRequestSchema>;
export type ApprovalKind = z.infer<typeof approvalKindSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type ApprovalRequestStatus = z.infer<typeof approvalRequestStatusSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequestSchema>;
export type ProposeAwardRequest = z.infer<typeof proposeAwardRequestSchema>;
export type Award = z.infer<typeof awardSchema>;
export type AwardLine = z.infer<typeof awardLineSchema>;
export type AwardStatus = z.infer<typeof awardStatusSchema>;
export type CostComponent = z.infer<typeof costComponentSchema>;
export type CostComponentCode = z.infer<typeof costComponentCodeSchema>;
export type SellLine = z.infer<typeof sellLineSchema>;
export type SaveCostSheetRequest = z.infer<typeof saveCostSheetRequestSchema>;
export type CostSheet = z.infer<typeof costSheetSchema>;
export type CostSheetVersion = z.infer<typeof costSheetVersionSchema>;
export type CostSheetStatus = z.infer<typeof costSheetStatusSchema>;
export type QuoteOptionLabel = z.infer<typeof quoteOptionLabelSchema>;
export type QuoteStatus = z.infer<typeof quoteStatusSchema>;
export type QuoteVersionStatus = z.infer<typeof quoteVersionStatusSchema>;
export type QuoteLineInput = z.infer<typeof quoteLineInputSchema>;
export type QuoteContentInput = z.infer<typeof quoteContentInputSchema>;
export type DraftQuoteRequest = z.infer<typeof draftQuoteRequestSchema>;
export type ReplaceQuoteRequest = z.infer<typeof replaceQuoteRequestSchema>;
export type QuoteVersionActionRequest = z.infer<typeof quoteVersionActionRequestSchema>;
export type WithdrawQuoteRequest = z.infer<typeof withdrawQuoteRequestSchema>;
export type QuoteLine = z.infer<typeof quoteLineSchema>;
export type QuoteVersion = z.infer<typeof quoteVersionSchema>;
export type Quote = z.infer<typeof quoteSchema>;
