import { z } from 'zod';

/**
 * The customer's view of a JobWork quotation (IN-07 `F-07.6`, doc 14 §4, doc 06 §13).
 *
 * This is the leak barrier (`ES-11`, `BR-COM-05`): a *different* type, built by
 * construction, with no field that could carry a supplier name, a bid, a cost or a
 * margin. The projection reads the internal quote and writes this; nothing is filtered
 * out at runtime because nothing is there to filter. The snapshot test in
 * `commercial.api.spec.ts` walks the serialized payload and refuses any key that smells
 * of the buy side.
 */

export const customerQuoteStatusSchema = z.enum([
  'quotation_ready',
  'revision_requested',
  'accepted',
  'rejected',
  'expired',
  'withdrawn',
]);

export const customerQuoteLineSchema = z.object({
  lineNo: z.number().int().positive(),
  description: z.string(),
  quantity: z.number().positive(),
  unit: z.string(),
  unitPriceMinor: z.number().int().nonnegative(),
  amountMinor: z.number().int().nonnegative(),
});

export const customerQuoteVersionSummarySchema = z.object({
  versionNo: z.number().int().positive(),
  totalMinor: z.number().int().nonnegative(),
  sentAt: z.string().nullable(),
  revisionReason: z.string().nullable(),
  /** What changed against the previous sent version — the diff the customer actually reads. */
  changes: z.array(z.object({ field: z.string(), from: z.string(), to: z.string() })),
});

export const customerQuoteSchema = z.object({
  quotationId: z.uuid(),
  reference: z.string(),
  optionLabel: z.enum(['standard', 'fast', 'premium']),
  status: customerQuoteStatusSchema,
  statusLabel: z.string(),
  versionNo: z.number().int().positive(),
  enquiry: z.object({ enquiryId: z.uuid(), reference: z.string().nullable(), title: z.string() }),
  issuedBy: z.literal('JobWork'),
  currency: z.string(),
  lines: z.array(customerQuoteLineSchema),
  subtotalMinor: z.number().int().nonnegative(),
  taxRateBp: z.number().int(),
  taxMinor: z.number().int().nonnegative(),
  freightMinor: z.number().int().nonnegative(),
  totalMinor: z.number().int().nonnegative(),
  deliveryLeadDays: z.number().int().positive(),
  paymentTerms: z.string(),
  /** The schedule the order will carry: advance share at acceptance, balance trigger. */
  advanceBp: z.number().int(),
  balanceTrigger: z.enum(['on_acceptance', 'before_dispatch', 'on_delivery', 'net_30']),
  validityUntil: z.string(),
  /** Days left on the validity; negative once past. Advisory — expiry is server truth. */
  daysToExpiry: z.number().int(),
  assumptions: z.string(),
  exclusions: z.string(),
  scopeNote: z.string(),
  terms: z.object({ code: z.string(), versionNo: z.number().int().positive(), hash: z.string() }),
  contentHash: z.string(),
  sentAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  siblingOptions: z.array(
    z.object({
      quotationId: z.uuid(),
      optionLabel: z.enum(['standard', 'fast', 'premium']),
      totalMinor: z.number().int().nonnegative(),
      deliveryLeadDays: z.number().int().positive(),
      status: customerQuoteStatusSchema,
    }),
  ),
  previousVersions: z.array(customerQuoteVersionSummarySchema),
  actions: z.object({
    canAccept: z.boolean(),
    canRequestRevision: z.boolean(),
    canReject: z.boolean(),
  }),
  aggregateVersion: z.number().int().positive(),
});

export const customerQuoteListItemSchema = z.object({
  quotationId: z.uuid(),
  reference: z.string(),
  optionLabel: z.enum(['standard', 'fast', 'premium']),
  status: customerQuoteStatusSchema,
  statusLabel: z.string(),
  enquiryTitle: z.string(),
  enquiryReference: z.string().nullable(),
  currency: z.string(),
  totalMinor: z.number().int().nonnegative(),
  validityUntil: z.string(),
  daysToExpiry: z.number().int(),
  sentAt: z.string().nullable(),
  versionNo: z.number().int().positive(),
});

export const customerQuoteDecisionRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(1000),
});

export type CustomerQuoteStatus = z.infer<typeof customerQuoteStatusSchema>;
export type CustomerQuote = z.infer<typeof customerQuoteSchema>;
export type CustomerQuoteLine = z.infer<typeof customerQuoteLineSchema>;
export type CustomerQuoteListItem = z.infer<typeof customerQuoteListItemSchema>;
export type CustomerQuoteDecisionRequest = z.infer<typeof customerQuoteDecisionRequestSchema>;
