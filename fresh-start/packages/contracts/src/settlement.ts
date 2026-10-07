import { z } from 'zod';

/**
 * Supplier bills and settlement (IN-18 F-18.1; doc 10 §5; FR-805; BR-FIN-03, BR-FIN-07). A bill is
 * matched against its purchase order and what JobWork accepted; it is paid only from a settlement
 * whose eligibility was computed. Money is in integer minor units.
 */

const versioned = { expectedVersion: z.number().int().positive() };
const quantity = z.string().trim().regex(/^\d{1,12}(\.\d{1,4})?$/, 'A quantity, e.g. 5 or 2.5');
const minor = z.number().int().min(0).max(1_000_000_000_000);

export const supplierBillStatusSchema = z.enum(['submitted', 'matched', 'match_exception', 'exception_approved', 'rejected']);
export const settlementStatusSchema = z.enum(['held', 'eligible', 'scheduled', 'paid']);

export const submitSupplierBillRequestSchema = z.object({
  purchaseOrderId: z.uuid(),
  /** The supplier's own invoice number. */
  supplierReference: z.string().trim().min(1).max(60),
  billDate: z.iso.date(),
  quantity,
  taxableMinor: minor,
  taxMinor: minor,
  /** The bill itself: the supplier's own clean file. */
  documentVersionId: z.uuid().optional(),
});

export const billVersionRequestSchema = z.object(versioned);
export const requestBillExceptionRequestSchema = z.object({ ...versioned, justification: z.string().trim().min(10).max(1000) });
export const rejectBillRequestSchema = z.object({ ...versioned, reason: z.string().trim().min(3).max(1000) });
export const scheduleSettlementRequestSchema = z.object({ ...versioned, scheduledFor: z.iso.date() });
export const markSettlementPaidRequestSchema = z.object({ ...versioned, paymentReference: z.string().trim().min(3).max(60) });

export const billMatchSchema = z.object({
  purchaseOrder: z.object({ number: z.string(), quantity: z.string(), totalMinor: z.number().int(), unitPriceMinor: z.number() }),
  receipt: z.object({ acceptedQuantity: z.string(), valueMinor: z.number().int() }),
  bill: z.object({ quantity: z.string(), taxableMinor: z.number().int() }),
  billedBeforeQuantity: z.string(),
  toleranceMinor: z.number().int(),
  pass: z.boolean(),
  reasons: z.array(z.string()),
});

export const settlementEligibilitySchema = z.object({ pass: z.boolean(), reasons: z.array(z.string()), computedAt: z.string() });

export const supplierBillSchema = z.object({
  billId: z.uuid(),
  number: z.string(),
  purchaseOrderId: z.uuid(),
  purchaseOrderNumber: z.string(),
  /** Empty for the supplier itself. */
  supplierDisplayName: z.string(),
  supplierReference: z.string(),
  billDate: z.string(),
  currency: z.string(),
  quantity: z.string(),
  taxableMinor: z.number().int(),
  taxMinor: z.number().int(),
  totalMinor: z.number().int(),
  status: supplierBillStatusSchema,
  match: billMatchSchema.nullable(),
  decisionNote: z.string(),
  approvalRequestId: z.uuid().nullable(),
  submittedAt: z.string(),
  settlement: z
    .object({
      settlementId: z.uuid(),
      status: settlementStatusSchema,
      eligibility: settlementEligibilitySchema,
      scheduledFor: z.string().nullable(),
      paidAt: z.string().nullable(),
      paymentReference: z.string(),
      aggregateVersion: z.number().int(),
    })
    .nullable(),
  aggregateVersion: z.number().int().positive(),
});

export type SupplierBillStatus = z.infer<typeof supplierBillStatusSchema>;
export type SettlementStatus = z.infer<typeof settlementStatusSchema>;
export type SubmitSupplierBillRequest = z.infer<typeof submitSupplierBillRequestSchema>;
export type BillVersionRequest = z.infer<typeof billVersionRequestSchema>;
export type RequestBillExceptionRequest = z.infer<typeof requestBillExceptionRequestSchema>;
export type RejectBillRequest = z.infer<typeof rejectBillRequestSchema>;
export type ScheduleSettlementRequest = z.infer<typeof scheduleSettlementRequestSchema>;
export type MarkSettlementPaidRequest = z.infer<typeof markSettlementPaidRequestSchema>;
export type BillMatch = z.infer<typeof billMatchSchema>;
export type SettlementEligibility = z.infer<typeof settlementEligibilitySchema>;
export type SupplierBill = z.infer<typeof supplierBillSchema>;

/**
 * One order's margin, planned against realized (IN-18 F-18.3; doc 05 §8 cost objects; doc 01 §7):
 * the approved cost sheet against what was actually posted to the order — revenue less credit notes,
 * the supplier's cost less recoveries, change and warranty cost. JobWork only.
 */
export const jobMarginSchema = z.object({
  salesOrderId: z.uuid(),
  orderNumber: z.string(),
  customerDisplayName: z.string(),
  status: z.string(),
  currency: z.string(),
  planned: z.object({ sellMinor: z.number().int(), landedMinor: z.number().int(), marginMinor: z.number().int(), marginBp: z.number().int() }).nullable(),
  actual: z.object({
    revenueMinor: z.number().int(),
    creditNotesMinor: z.number().int(),
    costOfGoodsMinor: z.number().int(),
    recoveriesMinor: z.number().int(),
    changeCostMinor: z.number().int(),
    warrantyCostMinor: z.number().int(),
    marginMinor: z.number().int(),
    marginBp: z.number().int().nullable(),
  }),
  /** Realized less planned margin; meaningful once every supplier bill is in. */
  varianceMinor: z.number().int().nullable(),
  billsComplete: z.boolean(),
});
export type JobMargin = z.infer<typeof jobMarginSchema>;
