import { z } from 'zod';
import { INSPECTION_STAGES } from './constants';

/**
 * Quality plans, inspections and instruments (IN-14 F-14.3; doc 09 §§9–10; doc 08 §§2, 5).
 * A measured value travels as a decimal string with its unit and declared precision, never as
 * a float (doc 08 §2): `{ "value": "3.2", "unit": "um", "declaredPrecision": 1 }`.
 */

export const inspectionStageSchema = z.enum(INSPECTION_STAGES);
export const inspectionStatusSchema = z.enum(['planned', 'in_progress', 'results_submitted', 'under_review', 'passed', 'failed', 'invalidated']);
export const criticalitySchema = z.enum(['critical', 'major', 'minor']);
export const outcomeSchema = z.enum(['pass', 'fail', 'cannot_evaluate']);
export const calibrationStatusSchema = z.enum(['valid', 'expired', 'uncalibrated', 'not_required']);
export const qualityPlanStatusSchema = z.enum(['draft', 'approved', 'superseded']);

const decimalString = z.string().trim().regex(/^-?\d{1,12}(\.\d{1,12})?$/, 'A plain decimal, e.g. 12.05');
const unitCode = z.string().trim().regex(/^[A-Za-z_]{1,16}$/);
const versioned = { expectedVersion: z.number().int().positive() };
const reason = z.string().trim().min(3).max(1000);

export const boundSchema = z.object({ value: decimalString, inclusive: z.boolean() });

export const characteristicInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('variable'),
    drawingReference: z.string().trim().max(60).default(''),
    name: z.string().trim().min(2).max(200),
    criticality: criticalitySchema,
    mandatory: z.boolean().default(true),
    unit: unitCode,
    nominal: decimalString.nullable().default(null),
    lower: boundSchema.nullable().default(null),
    upper: boundSchema.nullable().default(null),
    stages: z.array(inspectionStageSchema).min(1).max(6),
    method: z.string().trim().max(200).default(''),
    instrumentKind: z.string().trim().max(80).default(''),
    reactionPlan: z.string().trim().max(500).default(''),
  }),
  z.object({
    kind: z.literal('attribute'),
    drawingReference: z.string().trim().max(60).default(''),
    name: z.string().trim().min(2).max(200),
    criticality: criticalitySchema,
    mandatory: z.boolean().default(true),
    acceptedValues: z.array(z.string().trim().min(1).max(60)).min(1).max(10),
    stages: z.array(inspectionStageSchema).min(1).max(6),
    method: z.string().trim().max(200).default(''),
    instrumentKind: z.string().trim().max(80).default(''),
    reactionPlan: z.string().trim().max(500).default(''),
  }),
]);

export const planStageSchema = z.object({ stage: inspectionStageSchema, sampleSize: z.number().int().min(1).max(500) });

export const createQualityPlanRequestSchema = z.object({ workPackageId: z.uuid(), templateCode: z.string().trim().min(2).max(60) });
export const saveQualityPlanDraftRequestSchema = z.object({
  ...versioned,
  stages: z.array(planStageSchema).min(1).max(6),
  characteristics: z.array(characteristicInputSchema).min(1).max(200),
});
export const qualityPlanVersionRequestSchema = z.object(versioned);

export const characteristicSchema = z.object({
  characteristicId: z.uuid(),
  seq: z.number().int().positive(),
  drawingReference: z.string(),
  name: z.string(),
  kind: z.enum(['variable', 'attribute']),
  criticality: criticalitySchema,
  mandatory: z.boolean(),
  unit: z.string().nullable(),
  nominal: z.string().nullable(),
  lower: boundSchema.nullable(),
  upper: boundSchema.nullable(),
  acceptedValues: z.array(z.string()),
  stages: z.array(inspectionStageSchema),
  method: z.string(),
  instrumentKind: z.string(),
  reactionPlan: z.string(),
});

export const qualityPlanSchema = z.object({
  planId: z.uuid(),
  workPackageId: z.uuid(),
  workPackageNumber: z.string(),
  purchaseOrderId: z.uuid(),
  purchaseOrderNumber: z.string(),
  supplierDisplayName: z.string(),
  salesOrderId: z.uuid(),
  salesOrderNumber: z.string(),
  versionNo: z.number().int().positive(),
  status: qualityPlanStatusSchema,
  templateCode: z.string(),
  templateLabel: z.string(),
  templateVersionNo: z.number().int().positive(),
  requiresDrawingCharacteristic: z.boolean(),
  baselineId: z.uuid(),
  baselineNumber: z.string(),
  /** False once a change has released a newer baseline: the plan must be revised. */
  baselineCurrent: z.boolean(),
  stages: z.array(planStageSchema),
  characteristics: z.array(characteristicSchema),
  approvedAt: z.string().nullable(),
  aggregateVersion: z.number().int().positive(),
});

export const qualityUnitSchema = z.object({ code: z.string(), label: z.string(), dimension: z.string() });

export const qualityTemplateSchema = z.object({
  code: z.string(),
  label: z.string(),
  versionNo: z.number().int().positive(),
  capabilityCodes: z.array(z.string()),
  stages: z.array(planStageSchema),
  characteristicCount: z.number().int().nonnegative(),
});

// ----------------------------------------------------------------- instruments

export const registerInstrumentRequestSchema = z.object({
  assetTag: z.string().trim().min(1).max(60),
  kind: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).default(''),
  unit: unitCode.nullable().default(null),
  resolution: decimalString.nullable().default(null),
  rangeLow: decimalString.nullable().default(null),
  rangeHigh: decimalString.nullable().default(null),
});
export const recordCalibrationRequestSchema = z.object({
  performedAt: z.iso.datetime(),
  dueAt: z.iso.datetime(),
  outcome: z.enum(['pass', 'out_of_tolerance']),
  certificateDocumentVersionId: z.uuid(),
  note: z.string().trim().max(500).default(''),
});
export const retireInstrumentRequestSchema = z.object({ ...versioned, reason });

export const instrumentSchema = z.object({
  instrumentId: z.uuid(),
  ownerOrganizationId: z.uuid(),
  ownerDisplayName: z.string(),
  assetTag: z.string(),
  kind: z.string(),
  description: z.string(),
  unit: z.string().nullable(),
  resolution: z.string().nullable(),
  status: z.enum(['in_service', 'retired']),
  /** As of now; a result keeps its own status as of the moment it was measured. */
  calibrationStatus: z.enum(['valid', 'expired', 'uncalibrated']),
  calibrationDueAt: z.string().nullable(),
  calibrations: z.array(
    z.object({ calibrationId: z.uuid(), performedAt: z.string(), dueAt: z.string(), outcome: z.enum(['pass', 'out_of_tolerance']), certificateDocumentVersionId: z.uuid(), certificateSha256: z.string(), note: z.string() }),
  ),
  aggregateVersion: z.number().int().positive(),
});

// ----------------------------------------------------------------- inspections

export const measuredValueSchema = z.object({ value: z.string().trim().min(1).max(60), unit: unitCode.nullable(), declaredPrecision: z.number().int().min(0).max(12).nullable() });

export const planInspectionRequestSchema = z.object({
  workPackageId: z.uuid(),
  stage: inspectionStageSchema,
  /** At least the plan's sample size for the stage. */
  sampleSize: z.number().int().min(1).max(500).optional(),
  lot: z.string().trim().max(60).default(''),
  milestoneId: z.uuid().optional(),
  reinspectionOf: z.uuid().optional(),
  note: z.string().trim().max(500).default(''),
});
export const inspectionVersionRequestSchema = z.object(versioned);
export const submitResultsRequestSchema = z.object({
  ...versioned,
  inspectedAt: z.iso.datetime(),
  samples: z.array(z.object({ sampleNo: z.number().int().min(1), serial: z.string().trim().max(60).default(''), lot: z.string().trim().max(60).default(''), cavity: z.string().trim().max(30).default('') })).min(1).max(500),
  results: z
    .array(z.object({ sampleNo: z.number().int().min(1), characteristicId: z.uuid(), measurement: measuredValueSchema, instrumentId: z.uuid().nullable().default(null), method: z.string().trim().max(200).default('') }))
    .min(1)
    .max(5000),
  attachments: z.array(z.object({ documentVersionId: z.uuid(), note: z.string().trim().max(300).default('') })).max(20).default([]),
});
export const correctResultRequestSchema = z.object({
  ...versioned,
  resultId: z.uuid(),
  measurement: measuredValueSchema,
  instrumentId: z.uuid().nullable().default(null),
  reason,
});
export const calibrationDispositionRequestSchema = z.object({ ...versioned, resultId: z.uuid(), decision: z.enum(['accept', 'reinspect']), reason });
export const decideInspectionRequestSchema = z.object({ ...versioned, decision: z.enum(['passed', 'failed']), reason: z.string().trim().max(1000).default('') });
export const invalidateInspectionRequestSchema = z.object({ ...versioned, reason });

export const inspectionResultSchema = z.object({
  resultId: z.uuid(),
  sampleNo: z.number().int(),
  characteristicId: z.uuid(),
  original: measuredValueSchema,
  normalized: z.object({ value: z.string(), unit: z.string() }).nullable(),
  outcome: outcomeSchema,
  outcomeReason: z.string(),
  ruleVersion: z.string(),
  method: z.string(),
  instrument: z.object({ instrumentId: z.uuid(), assetTag: z.string(), kind: z.string() }).nullable(),
  calibrationStatus: calibrationStatusSchema,
  disposition: z.object({ decision: z.enum(['accept', 'reinspect']), reason: z.string(), decidedAt: z.string() }).nullable(),
  /** Set when a later row corrected this one; the row itself is kept. */
  supersededByResultId: z.uuid().nullable(),
  supersedesResultId: z.uuid().nullable(),
  correctionReason: z.string().nullable(),
  recordedAt: z.string(),
});

export const inspectionSchema = z.object({
  inspectionId: z.uuid(),
  number: z.string(),
  workPackageId: z.uuid(),
  purchaseOrderId: z.uuid(),
  purchaseOrderNumber: z.string(),
  /** Empty in a supplier's own view. */
  supplierDisplayName: z.string(),
  stage: inspectionStageSchema,
  status: inspectionStatusSchema,
  sampleSize: z.number().int().positive(),
  lot: z.string(),
  note: z.string(),
  planId: z.uuid(),
  planVersionNo: z.number().int().positive(),
  baselineNumber: z.string(),
  characteristics: z.array(characteristicSchema),
  samples: z.array(z.object({ sampleNo: z.number().int(), serial: z.string(), lot: z.string(), cavity: z.string() })),
  results: z.array(inspectionResultSchema),
  attachments: z.array(z.object({ documentVersionId: z.uuid(), sha256: z.string(), filename: z.string(), note: z.string() })),
  /** Why `passed` is not available yet; empty when it is (doc 09 §10; BR-QLT-01, BR-QLT-05). */
  passBlockers: z.array(z.string()),
  plannedAt: z.string(),
  inspectedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  invalidationReason: z.string().nullable(),
  reinspectionOf: z.uuid().nullable(),
  canSubmit: z.boolean(),
  canReview: z.boolean(),
  aggregateVersion: z.number().int().positive(),
});

// ----------------------------------------------------------------- NCR and corrective action (IN-15)

export const ncrStatusSchema = z.enum(['open', 'containment', 'disposition_pending', 'rework', 'reinspection', 'deviation_pending', 'accepted_under_deviation', 'rejected', 'verified', 'closed']);
export const ncrSeveritySchema = z.enum(['critical', 'major', 'minor']);
export const costResponsibilitySchema = z.enum(['supplier', 'jobwork', 'customer', 'undetermined']);
const quantity = z.string().trim().regex(/^\d{1,12}(\.\d{1,4})?$/, 'A quantity, e.g. 5 or 2.5');
const tags = z.array(z.string().trim().min(1).max(60)).max(200).default([]);

export const openNcrRequestSchema = z.object({
  inspectionId: z.uuid(),
  resultIds: z.array(z.uuid()).min(1).max(200),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).max(2000),
  severity: ncrSeveritySchema,
  affectedQuantity: quantity,
  lots: tags,
  serials: tags,
  suspectedCause: z.string().trim().max(1000).default(''),
  dueAt: z.iso.datetime().optional(),
  costResponsibility: costResponsibilitySchema.default('undetermined'),
  /** A new defect found while working another NCR (doc 09 §11 branch lineage). */
  parentNcrId: z.uuid().optional(),
});
export const ncrVersionRequestSchema = z.object(versioned);
export const containNcrRequestSchema = z.object({ action: z.string().trim().min(3).max(1000), location: z.string().trim().max(200).default(''), quantity: quantity.nullable().default(null) });
export const approveReworkRequestSchema = z.object({ ...versioned, disposition: z.enum(['rework', 'remake', 'sort']), plan: z.string().trim().min(3).max(2000) });
export const recordReworkRequestSchema = z.object({ ...versioned, note: z.string().trim().min(3).max(2000) });
export const planReinspectionRequestSchema = z.object({ ...versioned, sampleSize: z.number().int().min(1).max(500).optional() });
export const rejectLotRequestSchema = z.object({ ...versioned, disposition: z.enum(['return', 'scrap']), costResponsibility: costResponsibilitySchema, reason });
export const closeNcrRequestSchema = z.object({ ...versioned, note: reason });
export const respondCorrectiveActionRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  problemDefinition: z.string().trim().min(3).max(2000),
  occurrenceCause: z.string().trim().min(3).max(2000),
  escapeCause: z.string().trim().min(3).max(2000),
  actions: z.array(z.object({ action: z.string().trim().min(3).max(500), owner: z.string().trim().min(2).max(120), dueDate: z.iso.date() })).min(1).max(20),
});
export const reviewCorrectiveActionRequestSchema = z.object({ expectedVersion: z.number().int().positive(), decision: z.enum(['accept', 'return']), note: z.string().trim().max(1000).default('') });
export const verifyCorrectiveActionRequestSchema = z.object({ expectedVersion: z.number().int().positive(), evidence: reason });

export const ncrSchema = z.object({
  ncrId: z.uuid(),
  number: z.string(),
  workPackageId: z.uuid(),
  purchaseOrderId: z.uuid(),
  purchaseOrderNumber: z.string(),
  /** Empty in a supplier's own view. */
  supplierDisplayName: z.string(),
  inspectionId: z.uuid(),
  inspectionNumber: z.string(),
  stage: z.string(),
  title: z.string(),
  description: z.string(),
  severity: ncrSeveritySchema,
  affectedQuantity: z.string(),
  lots: z.array(z.string()),
  serials: z.array(z.string()),
  suspectedCause: z.string(),
  status: ncrStatusSchema,
  attemptNo: z.number().int(),
  dueAt: z.string(),
  costResponsibility: costResponsibilitySchema,
  parent: z.object({ ncrId: z.uuid(), number: z.string() }).nullable(),
  children: z.array(z.object({ ncrId: z.uuid(), number: z.string(), status: ncrStatusSchema })),
  defects: z.array(
    z.object({
      resultId: z.uuid(),
      characteristicId: z.uuid(),
      characteristicName: z.string(),
      sampleNo: z.number().int(),
      original: z.object({ value: z.string(), unit: z.string().nullable() }),
      normalized: z.object({ value: z.string(), unit: z.string() }).nullable(),
      outcome: outcomeSchema,
      outcomeReason: z.string(),
    }),
  ),
  containment: z.array(z.object({ action: z.string(), location: z.string(), quantity: z.string().nullable(), recordedAt: z.string(), by: z.enum(['jobwork', 'supplier']) })),
  dispositions: z.array(
    z.object({
      attemptNo: z.number().int(),
      disposition: z.enum(['rework', 'remake', 'sort', 'use_as_is', 'return', 'scrap']),
      plan: z.string(),
      decidedAt: z.string(),
      reworkNote: z.string().nullable(),
      reworkRecordedAt: z.string().nullable(),
      reinspection: z.object({ inspectionId: z.uuid(), number: z.string(), status: inspectionStatusSchema }).nullable(),
      outcome: z.enum(['pending', 'verified', 'still_nonconforming', 'deviation_approved', 'deviation_rejected', 'rejected']),
    }),
  ),
  correctiveAction: z
    .object({
      status: z.enum(['requested', 'responded', 'accepted', 'verified']),
      dueAt: z.string(),
      problemDefinition: z.string().nullable(),
      occurrenceCause: z.string().nullable(),
      escapeCause: z.string().nullable(),
      actions: z.array(z.object({ action: z.string(), owner: z.string(), dueDate: z.string() })),
      reviewNote: z.string().nullable(),
      effectivenessEvidence: z.string().nullable(),
      aggregateVersion: z.number().int().positive(),
    })
    .nullable(),
  /** Why it cannot close for the reader; empty when it can (internal view only). */
  closeBlockers: z.array(z.string()),
  closedAt: z.string().nullable(),
  closureNote: z.string().nullable(),
  aggregateVersion: z.number().int().positive(),
});

export type InspectionStage = z.infer<typeof inspectionStageSchema>;
export type InspectionStatus = z.infer<typeof inspectionStatusSchema>;
export type CharacteristicInput = z.infer<typeof characteristicInputSchema>;
export type PlanStage = z.infer<typeof planStageSchema>;
export type CreateQualityPlanRequest = z.infer<typeof createQualityPlanRequestSchema>;
export type SaveQualityPlanDraftRequest = z.infer<typeof saveQualityPlanDraftRequestSchema>;
export type QualityPlanVersionRequest = z.infer<typeof qualityPlanVersionRequestSchema>;
export type Characteristic = z.infer<typeof characteristicSchema>;
export type QualityPlan = z.infer<typeof qualityPlanSchema>;
export type QualityTemplate = z.infer<typeof qualityTemplateSchema>;
export type QualityUnit = z.infer<typeof qualityUnitSchema>;
export type RegisterInstrumentRequest = z.infer<typeof registerInstrumentRequestSchema>;
export type RecordCalibrationRequest = z.infer<typeof recordCalibrationRequestSchema>;
export type RetireInstrumentRequest = z.infer<typeof retireInstrumentRequestSchema>;
export type Instrument = z.infer<typeof instrumentSchema>;
export type MeasuredValue = z.infer<typeof measuredValueSchema>;
export type PlanInspectionRequest = z.infer<typeof planInspectionRequestSchema>;
export type InspectionVersionRequest = z.infer<typeof inspectionVersionRequestSchema>;
export type SubmitResultsRequest = z.infer<typeof submitResultsRequestSchema>;
export type CorrectResultRequest = z.infer<typeof correctResultRequestSchema>;
export type CalibrationDispositionRequest = z.infer<typeof calibrationDispositionRequestSchema>;
export type DecideInspectionRequest = z.infer<typeof decideInspectionRequestSchema>;
export type InvalidateInspectionRequest = z.infer<typeof invalidateInspectionRequestSchema>;
export type InspectionResult = z.infer<typeof inspectionResultSchema>;
export type Inspection = z.infer<typeof inspectionSchema>;
export type NcrStatus = z.infer<typeof ncrStatusSchema>;
export type OpenNcrRequest = z.infer<typeof openNcrRequestSchema>;
export type NcrVersionRequest = z.infer<typeof ncrVersionRequestSchema>;
export type ContainNcrRequest = z.infer<typeof containNcrRequestSchema>;
export type ApproveReworkRequest = z.infer<typeof approveReworkRequestSchema>;
export type RecordReworkRequest = z.infer<typeof recordReworkRequestSchema>;
export type PlanReinspectionRequest = z.infer<typeof planReinspectionRequestSchema>;
export type RejectLotRequest = z.infer<typeof rejectLotRequestSchema>;
export type CloseNcrRequest = z.infer<typeof closeNcrRequestSchema>;
export type RespondCorrectiveActionRequest = z.infer<typeof respondCorrectiveActionRequestSchema>;
export type ReviewCorrectiveActionRequest = z.infer<typeof reviewCorrectiveActionRequestSchema>;
export type VerifyCorrectiveActionRequest = z.infer<typeof verifyCorrectiveActionRequestSchema>;
export type Ncr = z.infer<typeof ncrSchema>;
