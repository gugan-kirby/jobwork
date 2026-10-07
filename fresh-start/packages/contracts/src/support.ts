import { z } from 'zod';

/**
 * Support cases (IN-18 F-18.2; UC-34; doc 06 §15; doc 10 §15; FR-906). One case for a delivery
 * issue, a warranty claim, a dispute, a supplier's failure or a chargeback. Its resolution actions are
 * carried out by the module that owns each — a credit note, a refund, a return leg, a recovery — and
 * verified by someone else; the case closes only when every action is verified or cancelled.
 */

const versioned = { expectedVersion: z.number().int().positive() };
const quantity = z.string().trim().regex(/^\d{1,12}(\.\d{1,4})?$/, 'A quantity, e.g. 5 or 2.5');

export const caseKindSchema = z.enum(['delivery_issue', 'warranty', 'dispute', 'supplier_failure', 'chargeback']);
export const caseStatusSchema = z.enum(['open', 'triage', 'investigating', 'resolution_proposed', 'resolution_approved', 'executing', 'verifying', 'closed', 'rejected', 'withdrawn']);
export const resolutionActionKindSchema = z.enum(['return_to_jobwork', 'return_to_supplier', 'rework', 'replacement', 'credit_note', 'refund', 'supplier_recovery', 'carrier_claim', 'concession']);
export const resolutionActionStatusSchema = z.enum(['planned', 'done', 'verified', 'cancelled']);

export const openCaseRequestSchema = z.object({
  salesOrderId: z.uuid(),
  kind: caseKindSchema,
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).max(4000),
  /** The delivery it is about, when there is one. */
  shipmentId: z.uuid().optional(),
  /** JobWork only: delivery exceptions this case takes over; their hold lifts when it closes. */
  deliveryExceptionIds: z.array(z.uuid()).max(20).default([]),
  /** JobWork only: the supplier's purchase order a recovery or dispute concerns. */
  purchaseOrderId: z.uuid().optional(),
  evidenceDocumentVersionIds: z.array(z.uuid()).max(20).default([]),
});

export const caseVersionRequestSchema = z.object(versioned);
export const caseReasonRequestSchema = z.object({ ...versioned, reason: z.string().trim().min(3).max(1000) });
export const addCaseEventRequestSchema = z.object({
  note: z.string().trim().min(1).max(4000),
  /** JobWork chooses; a customer's note is always shared. */
  audience: z.enum(['customer', 'internal']).default('customer'),
  evidenceDocumentVersionIds: z.array(z.uuid()).max(20).default([]),
});

export const proposedActionSchema = z.object({
  kind: resolutionActionKindSchema,
  description: z.string().trim().min(3).max(1000),
  /** Tax-inclusive, for a credit note, refund or recovery. */
  amountMinor: z.number().int().positive().max(1_000_000_000_000).optional(),
  quantity: quantity.optional(),
  stockLotId: z.uuid().optional(),
});
export const proposeResolutionRequestSchema = z.object({ ...versioned, actions: z.array(proposedActionSchema).min(1).max(20) });

/** What carrying out an action needs; only the fields of its kind are read. */
export const executeActionRequestSchema = z.object({
  note: z.string().trim().max(1000).default(''),
  /** Credit note: the invoice it corrects. */
  invoiceId: z.uuid().optional(),
  /** Refund and others: the bank, carrier or supplier reference. */
  reference: z.string().trim().max(60).default(''),
  /** Return to JobWork: the delivery coming back. */
  shipmentId: z.uuid().optional(),
  /** Return to supplier and rework. */
  purchaseOrderId: z.uuid().optional(),
  from: z.enum(['stock', 'quarantine']).default('quarantine'),
  challanNumber: z.string().trim().max(60).default(''),
});
export const verifyActionRequestSchema = z.object({ note: z.string().trim().min(3).max(1000) });

export const caseEventSchema = z.object({ kind: z.string(), note: z.string(), audience: z.enum(['customer', 'internal']), authorParty: z.enum(['customer', 'jobwork', 'system']), evidenceCount: z.number().int(), createdAt: z.string() });

export const resolutionActionSchema = z.object({
  actionId: z.uuid(),
  seq: z.number().int(),
  kind: resolutionActionKindSchema,
  description: z.string(),
  amountMinor: z.number().int().nullable(),
  quantity: z.string().nullable(),
  status: resolutionActionStatusSchema,
  result: z.record(z.string(), z.unknown()),
  doneAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
});

export const supportCaseSchema = z.object({
  caseId: z.uuid(),
  number: z.string(),
  kind: caseKindSchema,
  status: caseStatusSchema,
  statusLabel: z.string(),
  salesOrderId: z.uuid(),
  orderNumber: z.string(),
  customerDisplayName: z.string(),
  shipmentId: z.uuid().nullable(),
  shipmentNumber: z.string(),
  purchaseOrderId: z.uuid().nullable(),
  title: z.string(),
  description: z.string(),
  openedByParty: z.enum(['customer', 'jobwork']),
  approvalRequestId: z.uuid().nullable(),
  events: z.array(caseEventSchema),
  actions: z.array(resolutionActionSchema),
  linkedExceptions: z.array(z.object({ number: z.string(), kind: z.string() })),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  aggregateVersion: z.number().int().positive(),
});

/** The customer's case: its own words and JobWork's shared ones, the remedies, nothing of the supplier. */
export const customerCaseSchema = z.object({
  caseId: z.uuid(),
  number: z.string(),
  kind: caseKindSchema,
  status: caseStatusSchema,
  statusLabel: z.string(),
  orderId: z.uuid(),
  orderNumber: z.string(),
  shipmentNumber: z.string(),
  title: z.string(),
  description: z.string(),
  events: z.array(caseEventSchema.omit({ audience: true })),
  remedies: z.array(z.object({ kind: resolutionActionKindSchema, description: z.string(), amountMinor: z.number().int().nullable(), status: resolutionActionStatusSchema })),
  canWithdraw: z.boolean(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  aggregateVersion: z.number().int().positive(),
});

export type CaseKind = z.infer<typeof caseKindSchema>;
export type CaseStatus = z.infer<typeof caseStatusSchema>;
export type ResolutionActionKind = z.infer<typeof resolutionActionKindSchema>;
export type OpenCaseRequest = z.infer<typeof openCaseRequestSchema>;
export type CaseVersionRequest = z.infer<typeof caseVersionRequestSchema>;
export type CaseReasonRequest = z.infer<typeof caseReasonRequestSchema>;
export type AddCaseEventRequest = z.infer<typeof addCaseEventRequestSchema>;
export type ProposeResolutionRequest = z.infer<typeof proposeResolutionRequestSchema>;
export type ExecuteActionRequest = z.infer<typeof executeActionRequestSchema>;
export type VerifyActionRequest = z.infer<typeof verifyActionRequestSchema>;
export type SupportCase = z.infer<typeof supportCaseSchema>;
export type CustomerCase = z.infer<typeof customerCaseSchema>;
