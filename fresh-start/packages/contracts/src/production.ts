import { z } from 'zod';

/**
 * Technical baseline, transmittals, work packages and milestones (IN-09, `FR-503`–`FR-506`,
 * `BR-ENG-02/03/06/07`, `BR-OPS-01..04`). Internal shapes carry supplier and customer
 * names; the supplier shape carries neither customer nor sell price; the customer sees
 * only curated progress (see `customerOrderSchema.progress`).
 */

export const baselineItemPurposeSchema = z.enum(['governing', 'reference', 'inspection']);

export const baselineItemInputSchema = z.object({
  documentVersionId: z.uuid(),
  purpose: baselineItemPurposeSchema,
  governingPriority: z.number().int().min(1).max(9).default(1),
});

export const assembleBaselineRequestSchema = z.object({
  items: z.array(baselineItemInputSchema).min(1).max(100),
  note: z.string().trim().max(1000).default(''),
});

export const baselineVersionRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const baselineCandidateSchema = z.object({
  documentId: z.uuid(),
  documentVersionId: z.uuid(),
  title: z.string(),
  logicalType: z.string(),
  versionNo: z.number().int().positive(),
  filename: z.string(),
  fileSha256: z.string(),
  status: z.string(),
  scanState: z.string(),
  source: z.enum(['governing', 'reference', 'assisted_photo', 'internal', 'change']),
  selectable: z.boolean(),
  reason: z.string().nullable(),
});

export const baselineItemSchema = z.object({
  documentId: z.uuid(),
  documentVersionId: z.uuid(),
  title: z.string(),
  logicalType: z.string(),
  versionNo: z.number().int().positive(),
  filename: z.string(),
  fileSha256: z.string(),
  purpose: baselineItemPurposeSchema,
  governingPriority: z.number().int().positive(),
});

export const transmittalStatusSchema = z.enum(['issued', 'acknowledged', 'superseded', 'revoked']);

export const transmittalSchema = z.object({
  transmittalId: z.uuid(),
  number: z.string(),
  baselineId: z.uuid(),
  baselineNumber: z.string(),
  purchaseOrderId: z.uuid(),
  purchaseOrderNumber: z.string(),
  recipientOrganizationId: z.uuid(),
  recipientDisplayName: z.string(),
  manifestHash: z.string(),
  status: transmittalStatusSchema,
  acknowledgmentDueAt: z.string(),
  issuedAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  acknowledgmentNote: z.string(),
  overdue: z.boolean(),
  aggregateVersion: z.number().int().positive(),
});

export const baselineSchema = z.object({
  baselineId: z.uuid(),
  number: z.string(),
  salesOrderId: z.uuid(),
  kind: z.enum(['production', 'inspection']),
  status: z.enum(['draft', 'released', 'superseded']),
  note: z.string(),
  manifestHash: z.string().nullable(),
  items: z.array(baselineItemSchema),
  /** `BR-ENG-06`: conflicting governing documents, which block release. */
  conflicts: z.array(z.string()),
  releasedAt: z.string().nullable(),
  createdAt: z.string(),
  transmittals: z.array(transmittalSchema),
  aggregateVersion: z.number().int().positive(),
});

export const issueTransmittalsRequestSchema = z.object({
  baselineId: z.uuid(),
  acknowledgmentDays: z.number().int().min(1).max(14).default(3),
});

export const acknowledgeTransmittalRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  note: z.string().trim().max(1000).default(''),
});

// ------------------------------------------------------------------ work package

export const milestoneStatusSchema = z.enum([
  'not_ready',
  'ready',
  'in_progress',
  'evidence_submitted',
  'verified',
  'rejected_evidence',
  'blocked',
  'waived',
]);

export const milestoneInputSchema = z.object({
  title: z.string().trim().min(2).max(120),
  customerLabel: z.string().trim().max(120).optional(),
  plannedDate: z.iso.date(),
  evidencePolicy: z.enum(['photo', 'document', 'none']).default('photo'),
  minEvidence: z.number().int().min(0).max(10).default(1),
});

export const planWorkPackageRequestSchema = z.object({
  plannedStart: z.iso.date(),
  plannedFinish: z.iso.date(),
  qualityPlanPresent: z.boolean().default(false),
  planningNote: z.string().trim().max(1000).default(''),
  milestones: z.array(milestoneInputSchema).min(1).max(20).optional(),
});

export const gateKeySchema = z.enum(['commercial', 'technical', 'planning', 'compliance']);

export const releaseGateSchema = z.object({
  key: gateKeySchema,
  label: z.string(),
  pass: z.boolean(),
  reasons: z.array(z.string()),
  evidence: z.record(z.string(), z.string().nullable()),
});

export const milestoneEvidenceSchema = z.object({
  evidenceId: z.uuid(),
  documentId: z.uuid(),
  documentVersionId: z.uuid(),
  filename: z.string(),
  fileSha256: z.string(),
  scanState: z.string(),
  observedAt: z.string(),
  submittedAt: z.string(),
  flagged: z.boolean(),
  flagReason: z.string().nullable(),
  note: z.string(),
});

export const milestoneForecastSchema = z.object({
  revisionNo: z.number().int().positive(),
  forecastDate: z.string(),
  reasonCode: z.enum(['machine', 'material', 'labour', 'quality', 'customer', 'other']),
  reason: z.string(),
  recordedAt: z.string(),
});

export const milestoneSchema = z.object({
  milestoneId: z.uuid(),
  seq: z.number().int().positive(),
  title: z.string(),
  customerLabel: z.string().nullable(),
  evidencePolicy: z.enum(['photo', 'document', 'none']),
  minEvidence: z.number().int().nonnegative(),
  verifierRole: z.string(),
  status: milestoneStatusSchema,
  plannedDate: z.string(),
  forecastDate: z.string(),
  actualDate: z.string().nullable(),
  startedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  backdateReason: z.string().nullable(),
  forecasts: z.array(milestoneForecastSchema),
  evidence: z.array(milestoneEvidenceSchema),
  aggregateVersion: z.number().int().positive(),
});

export const containmentEventSchema = z.object({
  containmentId: z.uuid(),
  kind: z.enum(['unauthorized_start', 'subcontracting', 'other']),
  description: z.string(),
  reportedAt: z.string(),
  disposition: z.string().nullable(),
  disposedAt: z.string().nullable(),
});

export const workPackageStatusSchema = z.enum(['planned', 'released', 'in_production', 'completed', 'cancelled']);

export const workPackageSchema = z.object({
  workPackageId: z.uuid(),
  number: z.string(),
  salesOrderId: z.uuid(),
  salesOrderNumber: z.string(),
  purchaseOrderId: z.uuid(),
  purchaseOrderNumber: z.string(),
  supplierOrganizationId: z.uuid(),
  supplierDisplayName: z.string(),
  status: workPackageStatusSchema,
  plannedStart: z.string().nullable(),
  plannedFinish: z.string().nullable(),
  qualityPlanPresent: z.boolean(),
  planningNote: z.string(),
  gates: z.array(releaseGateSchema),
  allGreen: z.boolean(),
  releaseSnapshot: z.record(z.string(), z.unknown()).nullable(),
  releasedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  milestones: z.array(milestoneSchema),
  containment: z.array(containmentEventSchema),
  /** Every baseline this work package worked to, oldest first (BR-ENG-04; IN-13). */
  baselinesUsed: z.array(z.object({ baselineId: z.uuid(), number: z.string(), transmittalNumber: z.string(), effectiveFrom: z.string() })),
  aggregateVersion: z.number().int().positive(),
});

export const productionViewSchema = z.object({
  /** Just enough of the order to work production — no prices, no acceptance evidence (least privilege for quality). */
  order: z.object({
    salesOrderId: z.uuid(),
    number: z.string(),
    title: z.string(),
    customerDisplayName: z.string(),
    status: z.string(),
    deliveryLeadDays: z.number().int().positive(),
  }),
  purchaseOrders: z.array(
    z.object({
      purchaseOrderId: z.uuid(),
      number: z.string(),
      supplierDisplayName: z.string(),
      status: z.string(),
      leadTimeDays: z.number().int().positive(),
    }),
  ),
  baselines: z.array(baselineSchema),
  workPackages: z.array(workPackageSchema),
});

export const workPackageVersionRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const milestoneVersionRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const submitEvidenceRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  items: z
    .array(
      z.object({
        documentVersionId: z.uuid(),
        observedAt: z.iso.datetime().optional(),
        note: z.string().trim().max(500).default(''),
      }),
    )
    .min(1)
    .max(10),
});

export const verifyMilestoneRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  decision: z.enum(['verified', 'rejected_evidence']),
  reason: z.string().trim().max(1000).default(''),
  actualDate: z.iso.date().optional(),
  backdateReason: z.string().trim().max(1000).optional(),
});

export const reportDelayRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  forecastDate: z.iso.date(),
  reasonCode: z.enum(['machine', 'material', 'labour', 'quality', 'customer', 'other']),
  reason: z.string().trim().min(3).max(1000),
});

export const waiveMilestoneRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(10).max(1000),
});

export const recordContainmentRequestSchema = z.object({
  kind: z.enum(['unauthorized_start', 'subcontracting', 'other']),
  description: z.string().trim().min(5).max(2000),
});

export const verificationQueueItemSchema = z.object({
  milestoneId: z.uuid(),
  title: z.string(),
  seq: z.number().int().positive(),
  workPackageId: z.uuid(),
  workPackageNumber: z.string(),
  salesOrderId: z.uuid(),
  salesOrderNumber: z.string(),
  supplierDisplayName: z.string(),
  submittedAt: z.string(),
  evidenceCount: z.number().int().nonnegative(),
  flagged: z.boolean(),
  aggregateVersion: z.number().int().positive(),
});

// ------------------------------------------------------------------ supplier projection

export const supplierTransmittalSchema = z.object({
  transmittalId: z.uuid(),
  number: z.string(),
  status: transmittalStatusSchema,
  manifestHash: z.string(),
  acknowledgmentDueAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  items: z.array(
    z.object({
      documentVersionId: z.uuid(),
      title: z.string(),
      logicalType: z.string(),
      versionNo: z.number().int().positive(),
      filename: z.string(),
      fileSha256: z.string(),
      purpose: baselineItemPurposeSchema,
    }),
  ),
  aggregateVersion: z.number().int().positive(),
});

export const supplierMilestoneSchema = milestoneSchema.omit({ verifierRole: true, customerLabel: true });

export const supplierProductionSchema = z.object({
  purchaseOrderId: z.uuid(),
  transmittal: supplierTransmittalSchema.nullable(),
  workPackage: z
    .object({
      workPackageId: z.uuid(),
      number: z.string(),
      status: workPackageStatusSchema,
      plannedStart: z.string().nullable(),
      plannedFinish: z.string().nullable(),
      released: z.boolean(),
      milestones: z.array(supplierMilestoneSchema),
      aggregateVersion: z.number().int().positive(),
    })
    .nullable(),
});

export type BaselineItemInput = z.infer<typeof baselineItemInputSchema>;
export type AssembleBaselineRequest = z.infer<typeof assembleBaselineRequestSchema>;
export type BaselineVersionRequest = z.infer<typeof baselineVersionRequestSchema>;
export type BaselineCandidate = z.infer<typeof baselineCandidateSchema>;
export type BaselineItem = z.infer<typeof baselineItemSchema>;
export type Baseline = z.infer<typeof baselineSchema>;
export type Transmittal = z.infer<typeof transmittalSchema>;
export type IssueTransmittalsRequest = z.infer<typeof issueTransmittalsRequestSchema>;
export type AcknowledgeTransmittalRequest = z.infer<typeof acknowledgeTransmittalRequestSchema>;
export type MilestoneStatus = z.infer<typeof milestoneStatusSchema>;
export type MilestoneInput = z.infer<typeof milestoneInputSchema>;
export type PlanWorkPackageRequest = z.infer<typeof planWorkPackageRequestSchema>;
export type GateKey = z.infer<typeof gateKeySchema>;
export type ReleaseGate = z.infer<typeof releaseGateSchema>;
export type Milestone = z.infer<typeof milestoneSchema>;
export type MilestoneEvidence = z.infer<typeof milestoneEvidenceSchema>;
export type ContainmentEvent = z.infer<typeof containmentEventSchema>;
export type WorkPackage = z.infer<typeof workPackageSchema>;
export type ProductionView = z.infer<typeof productionViewSchema>;
export type WorkPackageVersionRequest = z.infer<typeof workPackageVersionRequestSchema>;
export type MilestoneVersionRequest = z.infer<typeof milestoneVersionRequestSchema>;
export type SubmitEvidenceRequest = z.infer<typeof submitEvidenceRequestSchema>;
export type VerifyMilestoneRequest = z.infer<typeof verifyMilestoneRequestSchema>;
export type ReportDelayRequest = z.infer<typeof reportDelayRequestSchema>;
export type WaiveMilestoneRequest = z.infer<typeof waiveMilestoneRequestSchema>;
export type RecordContainmentRequest = z.infer<typeof recordContainmentRequestSchema>;
export type SupplierTransmittal = z.infer<typeof supplierTransmittalSchema>;
export type SupplierMilestone = z.infer<typeof supplierMilestoneSchema>;
export type SupplierProduction = z.infer<typeof supplierProductionSchema>;
export type VerificationQueueItem = z.infer<typeof verificationQueueItemSchema>;
