import { z } from 'zod';

/**
 * Orders and the payment boundary (IN-08, `FR-407`, `FR-501`–`FR-502`, `FR-80x`).
 *
 * Three audiences, three families of shapes that never share a field they must not:
 * internal (`salesOrderSchema`, `purchaseOrderSchema`, `invoiceSchema` …), the customer
 * (`customerOrder*`, `customerInvoice*`, `customerPayment*` — no supplier, no PO, no
 * cost), and the supplier (`supplierPurchaseOrderSchema` — no customer, no sell price).
 */

export const balanceTriggerSchema = z.enum(['on_acceptance', 'before_dispatch', 'on_delivery', 'net_30']);

export const salesOrderStatusSchema = z.enum([
  'pending_commercial_release',
  'pending_technical_release',
  'planning',
  'released_to_production',
  'in_production',
  'quality_hold',
  'quality_released',
  'ready_supplier_dispatch',
  'in_supplier_to_jobwork_transit',
  'received_jobwork',
  'ready_customer_dispatch',
  'in_customer_transit',
  'delivered',
  'customer_accepted',
  'closed',
  'cancelled',
]);

// ------------------------------------------------------------------ acceptance

/**
 * `FR-407`: the customer binds the exact bytes. The request names the version, its hash
 * and the terms hash it saw; a mismatch means the customer is looking at something
 * other than what would be accepted, and is refused.
 */
export const acceptQuoteRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  quoteVersionNo: z.number().int().positive(),
  contentHash: z.string().length(64),
  termsHash: z.string().length(64),
  acknowledgeTerms: z.literal(true),
  deliverySiteId: z.uuid().optional(),
});

export const acceptanceSchema = z.object({
  acceptanceId: z.uuid(),
  quoteVersionNo: z.number().int().positive(),
  contentHash: z.string(),
  termsVersionNo: z.number().int().positive(),
  termsHash: z.string(),
  acceptedBy: z.uuid(),
  acceptedByName: z.string(),
  acceptedAt: z.string(),
  authoritySnapshot: z.object({
    roles: z.array(z.string()),
    limitMinor: z.number().int().nullable(),
    currency: z.string().nullable(),
  }),
});

// ------------------------------------------------------------------ instalments and invoices

export const installmentSchema = z.object({
  installmentId: z.uuid(),
  seq: z.number().int().positive(),
  kind: z.enum(['advance', 'balance', 'change']),
  label: z.string(),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string(),
  trigger: balanceTriggerSchema,
  status: z.enum(['pending', 'invoiced', 'paid', 'waived']),
  invoiceId: z.uuid().nullable(),
});

export const invoiceLineSchema = z.object({
  lineNo: z.number().int().positive(),
  description: z.string(),
  quantity: z.number().positive(),
  unit: z.string(),
  unitPriceMinor: z.number().int().nonnegative(),
  amountMinor: z.number().int().nonnegative(),
});

export const invoiceStatusSchema = z.enum(['issued', 'partially_paid', 'paid', 'void']);

export const invoiceSchema = z.object({
  invoiceId: z.uuid(),
  number: z.string(),
  salesOrderId: z.uuid(),
  salesOrderNumber: z.string(),
  installmentId: z.uuid().nullable(),
  customerOrganizationId: z.uuid(),
  kind: z.enum(['advance', 'balance', 'final', 'change']),
  currency: z.string(),
  lines: z.array(invoiceLineSchema),
  subtotalMinor: z.number().int().nonnegative(),
  taxRateBp: z.number().int(),
  taxMinor: z.number().int().nonnegative(),
  totalMinor: z.number().int().nonnegative(),
  paidMinor: z.number().int().nonnegative(),
  openMinor: z.number().int(),
  status: invoiceStatusSchema,
  contentHash: z.string(),
  issuedAt: z.string(),
  dueAt: z.string(),
  aggregateVersion: z.number().int().positive(),
});

// ------------------------------------------------------------------ sales order (internal)

export const salesOrderLineSchema = z.object({
  lineNo: z.number().int().positive(),
  description: z.string(),
  quantity: z.number().positive(),
  unit: z.string(),
  unitPriceMinor: z.number().int().nonnegative(),
  amountMinor: z.number().int().nonnegative(),
});

export const purchaseOrderStatusSchema = z.enum(['issued', 'acknowledged', 'cancelled']);

export const purchaseOrderLineSchema = z.object({
  lineNo: z.number().int().positive(),
  rfqItemId: z.uuid(),
  bidVersionId: z.uuid(),
  description: z.string(),
  quantity: z.number().positive(),
  unit: z.string(),
  unitPriceMinor: z.number().int().nonnegative(),
  setupAmountMinor: z.number().int().nonnegative(),
  freightAmountMinor: z.number().int().nonnegative(),
  nreAmountMinor: z.number().int().nonnegative(),
  amountMinor: z.number().int().nonnegative(),
});

export const purchaseOrderSchema = z.object({
  purchaseOrderId: z.uuid(),
  number: z.string(),
  salesOrderId: z.uuid(),
  salesOrderNumber: z.string(),
  awardId: z.uuid(),
  supplierOrganizationId: z.uuid(),
  supplierDisplayName: z.string(),
  status: purchaseOrderStatusSchema,
  baselineStatus: z.enum(['pending_baseline', 'baseline_released']),
  currency: z.string(),
  totalMinor: z.number().int().nonnegative(),
  leadTimeDays: z.number().int().positive(),
  paymentTerms: z.string(),
  instructions: z.string(),
  contentHash: z.string(),
  issuedAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  acknowledgmentNote: z.string(),
  lines: z.array(purchaseOrderLineSchema),
  aggregateVersion: z.number().int().positive(),
});

export const commercialGateSchema = z.object({
  pass: z.boolean(),
  basis: z.enum(['advance_paid', 'credit_covered', 'no_advance_due']).nullable(),
  reasons: z.array(z.string()),
  advanceDueMinor: z.number().int().nonnegative(),
  advancePaidMinor: z.number().int().nonnegative(),
  creditLimitMinor: z.number().int().nullable(),
  creditExposureMinor: z.number().int().nullable(),
  activeHolds: z.number().int().nonnegative(),
});

export const salesOrderSchema = z.object({
  salesOrderId: z.uuid(),
  number: z.string(),
  customerOrganizationId: z.uuid(),
  customerDisplayName: z.string(),
  enquiryId: z.uuid(),
  enquiryReference: z.string().nullable(),
  quoteId: z.uuid(),
  quoteReference: z.string().nullable(),
  acceptedQuoteVersionNo: z.number().int().positive(),
  title: z.string(),
  currency: z.string(),
  totalMinor: z.number().int().nonnegative(),
  deliveryLeadDays: z.number().int().positive(),
  deliverySiteId: z.uuid().nullable(),
  status: salesOrderStatusSchema,
  commercialReleasedAt: z.string().nullable(),
  commercialReleaseBasis: z.string().nullable(),
  acceptance: acceptanceSchema,
  contractHash: z.string(),
  lines: z.array(salesOrderLineSchema),
  installments: z.array(installmentSchema),
  invoices: z.array(invoiceSchema),
  purchaseOrders: z.array(purchaseOrderSchema),
  gate: commercialGateSchema,
  aggregateVersion: z.number().int().positive(),
  createdAt: z.string(),
});

export const acknowledgePurchaseOrderRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  note: z.string().trim().max(1000).default(''),
});

export const issueInstallmentInvoiceRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  installmentId: z.uuid(),
});

// ------------------------------------------------------------------ credit

export const creditProfileSchema = z.object({
  customerOrganizationId: z.uuid(),
  limitMinor: z.number().int().nonnegative(),
  currency: z.string(),
  termsDays: z.number().int().nonnegative(),
  approvedBy: z.uuid(),
  approvedAt: z.string(),
  validUntil: z.string().nullable(),
  note: z.string(),
  exposureMinor: z.number().int(),
  activeHolds: z.array(
    z.object({ holdId: z.uuid(), reason: z.string(), placedAt: z.string(), placedBy: z.uuid() }),
  ),
});

export const setCreditProfileRequestSchema = z.object({
  limitMinor: z.number().int().nonnegative(),
  currency: z.string().length(3).default('INR'),
  termsDays: z.number().int().min(0).max(180),
  validUntil: z.iso.date().optional(),
  note: z.string().trim().max(500).default(''),
});

export const placeCreditHoldRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const releaseCreditHoldRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

// ------------------------------------------------------------------ payments (internal)

export const paymentIntentStatusSchema = z.enum([
  'created',
  'pending_customer',
  'authorized',
  'captured',
  'failed',
  'cancelled',
  'expired',
]);

export const paymentIntentSchema = z.object({
  paymentIntentId: z.uuid(),
  invoiceId: z.uuid(),
  invoiceNumber: z.string(),
  salesOrderId: z.uuid(),
  amountMinor: z.number().int().positive(),
  currency: z.string(),
  provider: z.string(),
  providerIntentId: z.string(),
  checkoutUrl: z.string(),
  status: paymentIntentStatusSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  lastEventAt: z.string().nullable(),
});

export const paymentTransactionSchema = z.object({
  transactionId: z.uuid(),
  provider: z.string(),
  providerTransactionId: z.string(),
  intentId: z.uuid().nullable(),
  customerOrganizationId: z.uuid().nullable(),
  customerDisplayName: z.string().nullable(),
  kind: z.enum(['authorize', 'capture', 'refund', 'reversal', 'bank_transfer']),
  amountMinor: z.number().int().positive(),
  currency: z.string(),
  occurredAt: z.string(),
  receivedAt: z.string(),
  reference: z.string(),
  status: z.enum(['recorded', 'allocated', 'suspense', 'ignored']),
  note: z.string(),
  allocations: z.array(
    z.object({ invoiceId: z.uuid(), invoiceNumber: z.string(), amountMinor: z.number().int().positive(), approvalRequestId: z.uuid().nullable() }),
  ),
  unappliedMinor: z.number().int().nonnegative(),
});

export const createPaymentIntentRequestSchema = z.object({
  invoiceId: z.uuid(),
});

export const proposeAllocationRequestSchema = z.object({
  transactionId: z.uuid(),
  invoiceId: z.uuid(),
  amountMinor: z.number().int().positive(),
  note: z.string().trim().max(500).default(''),
});

export const recordBankTransferRequestSchema = z.object({
  bankReference: z.string().trim().min(3).max(120),
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3).default('INR'),
  occurredAt: z.iso.datetime(),
  customerOrganizationId: z.uuid().optional(),
  note: z.string().trim().max(500).default(''),
});

export const reconciliationQueueSchema = z.object({
  suspense: z.array(paymentTransactionSchema),
  pendingAllocations: z.array(
    z.object({
      approvalRequestId: z.uuid(),
      transactionId: z.uuid(),
      invoiceId: z.uuid(),
      invoiceNumber: z.string(),
      amountMinor: z.number().int().positive(),
      requestedByName: z.string(),
      requestedAt: z.string(),
    }),
  ),
  unappliedCredits: z.array(
    z.object({ creditId: z.uuid(), customerOrganizationId: z.uuid(), customerDisplayName: z.string(), amountMinor: z.number().int().positive(), currency: z.string(), createdAt: z.string() }),
  ),
});

// ------------------------------------------------------------------ customer projections

export const customerOrderStatusSchema = z.enum([
  'payment_needed',
  'technical_confirmation',
  'manufacturing_in_progress',
  'quality_review',
  'final_checks',
  'on_the_way',
  'delivery_confirmation_needed',
  'completed',
  'cancelled',
]);

export const customerOrderTimelineStepSchema = z.object({
  key: z.string(),
  label: z.string(),
  state: z.enum(['done', 'current', 'pending']),
  at: z.string().nullable(),
  detail: z.string().nullable(),
});

export const customerOrderListItemSchema = z.object({
  orderId: z.uuid(),
  number: z.string(),
  title: z.string(),
  status: customerOrderStatusSchema,
  statusLabel: z.string(),
  currency: z.string(),
  totalMinor: z.number().int().nonnegative(),
  acceptedAt: z.string(),
  expectedDeliveryAt: z.string().nullable(),
  /** The one thing the customer should do next on this order: pay, confirm where a delivery goes, or confirm what arrived. */
  actionNeeded: z
    .object({ kind: z.enum(['pay_advance', 'pay_balance', 'confirm_address', 'confirm_delivery']), label: z.string(), invoiceId: z.uuid().nullable(), shipmentId: z.uuid().nullable() })
    .nullable(),
});

export const customerInvoiceSchema = z.object({
  invoiceId: z.uuid(),
  number: z.string(),
  orderId: z.uuid(),
  orderNumber: z.string(),
  orderTitle: z.string(),
  kind: z.enum(['advance', 'balance', 'final', 'change']),
  currency: z.string(),
  lines: z.array(invoiceLineSchema),
  subtotalMinor: z.number().int().nonnegative(),
  taxRateBp: z.number().int(),
  taxMinor: z.number().int().nonnegative(),
  totalMinor: z.number().int().nonnegative(),
  paidMinor: z.number().int().nonnegative(),
  openMinor: z.number().int(),
  status: z.enum(['unpaid', 'partially_paid', 'paid', 'void']),
  statusLabel: z.string(),
  issuedAt: z.string(),
  dueAt: z.string(),
  contentHash: z.string(),
  /** The newest intent still in flight, so the page can say "we are verifying". */
  pendingPayment: z.object({ paymentIntentId: z.uuid(), status: paymentIntentStatusSchema, createdAt: z.string() }).nullable(),
});

export const customerOrderSchema = z.object({
  orderId: z.uuid(),
  number: z.string(),
  title: z.string(),
  status: customerOrderStatusSchema,
  statusLabel: z.string(),
  quotation: z.object({ quotationId: z.uuid(), reference: z.string(), versionNo: z.number().int().positive() }),
  enquiry: z.object({ enquiryId: z.uuid(), reference: z.string().nullable() }),
  currency: z.string(),
  lines: z.array(salesOrderLineSchema),
  totalMinor: z.number().int().nonnegative(),
  acceptedAt: z.string(),
  acceptedBy: z.string(),
  deliveryLeadDays: z.number().int().positive(),
  expectedDeliveryAt: z.string().nullable(),
  contractHash: z.string(),
  installments: z.array(installmentSchema),
  invoices: z.array(customerInvoiceSchema),
  timeline: z.array(customerOrderTimelineStepSchema),
  /** Verified checkpoints only, in curated words (doc 06 §13) — never a workshop, never an internal state. */
  progress: z.array(z.object({ label: z.string(), at: z.string() })),
  /** A forecast slipped past plan: said plainly, without the internal reason. */
  scheduleUnderReview: z.boolean(),
  nextStep: z.object({ owner: z.enum(['you', 'jobwork']), label: z.string(), detail: z.string() }),
  aggregateVersion: z.number().int().positive(),
});

export const customerPaymentSchema = z.object({
  transactionId: z.uuid(),
  kind: z.enum(['payment', 'refund', 'credit']),
  label: z.string(),
  amountMinor: z.number().int(),
  currency: z.string(),
  occurredAt: z.string(),
  invoiceNumber: z.string().nullable(),
  orderNumber: z.string().nullable(),
  reference: z.string(),
});

export const customerPaymentsSchema = z.object({
  payments: z.array(customerPaymentSchema),
  unappliedCreditMinor: z.number().int().nonnegative(),
  currency: z.string(),
});

/** The customer's view of one payment attempt — what the checkout page renders. */
export const customerPaymentIntentSchema = z.object({
  paymentIntentId: z.uuid(),
  invoiceId: z.uuid(),
  invoiceNumber: z.string(),
  orderNumber: z.string(),
  amountMinor: z.number().int().positive(),
  currency: z.string(),
  status: paymentIntentStatusSchema,
  provider: z.string(),
  checkoutUrl: z.string(),
  expiresAt: z.string(),
  /** Dev gateway only: the checkout page may simulate the provider. */
  simulated: z.boolean(),
});

export const simulatePaymentRequestSchema = z.object({
  outcome: z.enum(['success', 'failure']),
});

export const orderVersionRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

// ------------------------------------------------------------------ supplier projection

export const supplierPurchaseOrderSchema = z.object({
  purchaseOrderId: z.uuid(),
  number: z.string(),
  status: purchaseOrderStatusSchema,
  baselineStatus: z.enum(['pending_baseline', 'baseline_released']),
  rfqReference: z.string().nullable(),
  currency: z.string(),
  totalMinor: z.number().int().nonnegative(),
  leadTimeDays: z.number().int().positive(),
  paymentTerms: z.string(),
  instructions: z.string(),
  contentHash: z.string(),
  issuedAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  acknowledgmentNote: z.string(),
  lines: z.array(purchaseOrderLineSchema),
  /** What must happen before work may start (doc 06 §7), in the supplier's words. */
  beforeWork: z.array(z.string()),
  aggregateVersion: z.number().int().positive(),
});

export type BalanceTrigger = z.infer<typeof balanceTriggerSchema>;
export type SalesOrderStatus = z.infer<typeof salesOrderStatusSchema>;
export type AcceptQuoteRequest = z.infer<typeof acceptQuoteRequestSchema>;
export type Acceptance = z.infer<typeof acceptanceSchema>;
export type Installment = z.infer<typeof installmentSchema>;
export type Invoice = z.infer<typeof invoiceSchema>;
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;
export type SalesOrder = z.infer<typeof salesOrderSchema>;
export type SalesOrderLine = z.infer<typeof salesOrderLineSchema>;
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;
export type PurchaseOrderLine = z.infer<typeof purchaseOrderLineSchema>;
export type PurchaseOrderStatus = z.infer<typeof purchaseOrderStatusSchema>;
export type CommercialGate = z.infer<typeof commercialGateSchema>;
export type AcknowledgePurchaseOrderRequest = z.infer<typeof acknowledgePurchaseOrderRequestSchema>;
export type IssueInstallmentInvoiceRequest = z.infer<typeof issueInstallmentInvoiceRequestSchema>;
export type CreditProfile = z.infer<typeof creditProfileSchema>;
export type SetCreditProfileRequest = z.infer<typeof setCreditProfileRequestSchema>;
export type PlaceCreditHoldRequest = z.infer<typeof placeCreditHoldRequestSchema>;
export type ReleaseCreditHoldRequest = z.infer<typeof releaseCreditHoldRequestSchema>;
export type PaymentIntent = z.infer<typeof paymentIntentSchema>;
export type PaymentIntentStatus = z.infer<typeof paymentIntentStatusSchema>;
export type PaymentTransaction = z.infer<typeof paymentTransactionSchema>;
export type CreatePaymentIntentRequest = z.infer<typeof createPaymentIntentRequestSchema>;
export type ProposeAllocationRequest = z.infer<typeof proposeAllocationRequestSchema>;
export type RecordBankTransferRequest = z.infer<typeof recordBankTransferRequestSchema>;
export type ReconciliationQueue = z.infer<typeof reconciliationQueueSchema>;
export type CustomerOrderStatus = z.infer<typeof customerOrderStatusSchema>;
export type CustomerOrderListItem = z.infer<typeof customerOrderListItemSchema>;
export type CustomerOrder = z.infer<typeof customerOrderSchema>;
export type CustomerOrderTimelineStep = z.infer<typeof customerOrderTimelineStepSchema>;
export type CustomerInvoice = z.infer<typeof customerInvoiceSchema>;
export type CustomerPayment = z.infer<typeof customerPaymentSchema>;
export type CustomerPayments = z.infer<typeof customerPaymentsSchema>;
export type SupplierPurchaseOrder = z.infer<typeof supplierPurchaseOrderSchema>;
export type CustomerPaymentIntent = z.infer<typeof customerPaymentIntentSchema>;
export type SimulatePaymentRequest = z.infer<typeof simulatePaymentRequestSchema>;
export type OrderVersionRequest = z.infer<typeof orderVersionRequestSchema>;
