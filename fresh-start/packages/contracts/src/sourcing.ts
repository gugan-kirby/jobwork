import { z } from 'zod';
import { JOB_TYPES, JOB_TYPE_LABELS } from './constants';

/**
 * Enquiry intake contracts (`FR-301`–`FR-303`, doc 06 §3).
 * The customer states a requirement here; nothing in this file carries a supplier,
 * a cost, or an internal state name — the curated projection at the bottom is the
 * only enquiry status a customer is ever shown (doc 06 §13).
 */

export const confidentialitySchema = z.enum(['standard', 'confidential', 'nda_required']);

/**
 * The three kinds of work a customer can ask for (F-MX.1). It is the first question of
 * the wizard because it changes what else is mandatory:
 *  - `job_work`: a treatment or process on goods the customer owns (CGST Act s.2(68));
 *    the customer is the principal and normally supplies the material.
 *  - `new_model`: a part we have not made for this customer before; material is sourced.
 *  - `correction_ecn`: a correction or engineering change to a part already enquired or
 *    ordered; carries the ECN reference and what changed.
 */
export const jobTypeSchema = z.enum(JOB_TYPES);

export { JOB_TYPE_LABELS };

/** Who provides the raw material. Defaults follow the job type; the customer can override. */
export const materialSupplySchema = z.enum(['customer_supplied', 'to_be_sourced']);

export function defaultMaterialSupply(
  jobType: z.infer<typeof jobTypeSchema>,
): z.infer<typeof materialSupplySchema> {
  return jobType === 'job_work' ? 'customer_supplied' : 'to_be_sourced';
}

export const enquiryStatusSchema = z.enum([
  'draft',
  'submitted',
  'under_review',
  'clarification_required',
  'approved_for_sourcing',
  'closed',
  'cancelled',
]);

export const partialDeliverySchema = z.enum(['allowed', 'not_allowed']);

export const inspectionLevelSchema = z.enum([
  'standard',
  'dimensional_report',
  'third_party',
  'first_article',
]);

export const quantityKindSchema = z.enum(['prototype', 'production']);

/** Quantity units the intake accepts. No conversion happens anywhere: unit is carried. */
export const quantityUnitSchema = z.enum(['piece', 'set', 'kg', 'metre']);

export const quantityBreakpointSchema = z.object({
  quantity: z.number().int().positive().max(10_000_000),
  unit: quantityUnitSchema,
  kind: quantityKindSchema.default('production'),
});

/** A measurement keeps the value and the unit the customer typed (doc 02). */
export const measurementSchema = z.object({
  value: z.number().finite(),
  unit: z.enum(['mm', 'um', 'inch', 'deg']),
});

export const enquiryDocumentRoleSchema = z.enum(['governing', 'reference', 'assisted_photo']);

export const enquiryItemInputSchema = z.object({
  lineNo: z.number().int().positive().max(999),
  partName: z.string().trim().max(160).default(''),
  partNumber: z.string().trim().max(80).optional(),
  description: z.string().trim().max(4000).default(''),
  processCapabilityId: z.uuid().optional(),
  materialCapabilityId: z.uuid().optional(),
  materialGrade: z.string().trim().max(120).optional(),
  materialSourceRestriction: z.string().trim().max(240).optional(),
  quantityBreakpoints: z.array(quantityBreakpointSchema).max(6).default([]),
  toleranceClass: z.string().trim().max(40).optional(),
  criticalTolerance: measurementSchema.optional(),
  surfaceFinish: z.string().trim().max(120).optional(),
  heatTreatment: z.string().trim().max(120).optional(),
  coating: z.string().trim().max(120).optional(),
  inspectionLevel: inspectionLevelSchema.default('standard'),
  qualityNote: z.string().trim().max(2000).default(''),
  targetDate: z.iso.date().optional(),
  deliverySiteId: z.uuid().optional(),
});

export const enquiryDocumentInputSchema = z.object({
  documentVersionId: z.uuid(),
  lineNo: z.number().int().positive().max(999).optional(),
  role: enquiryDocumentRoleSchema.default('reference'),
  note: z.string().trim().max(400).default(''),
});

/**
 * The autosave payload. The whole draft is sent every time and `expectedVersion` is
 * the guard: the wizard is a form, not a patch stream, and two people editing the same
 * draft must collide loudly rather than interleave silently (doc 19 §9).
 */
export const saveDraftRequestSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  title: z.string().trim().max(200).default(''),
  applicationNote: z.string().trim().max(4000).default(''),
  confidentiality: confidentialitySchema.default('confidential'),
  jobType: jobTypeSchema.default('job_work'),
  /** Absent means "the default for the job type"; resolved by the command, never by the UI. */
  materialSupply: materialSupplySchema.optional(),
  /** Correction/ECN only: the customer's change reference (ECN number) and what changed. */
  changeReference: z.string().trim().max(80).default(''),
  changeDescription: z.string().trim().max(4000).default(''),
  /** Correction/ECN only: the enquiry being corrected; must be the customer's own. */
  relatedEnquiryId: z.uuid().optional(),
  assistedIntake: z.boolean().default(false),
  deliverySiteId: z.uuid().optional(),
  requiredByDate: z.iso.date().optional(),
  partialDelivery: partialDeliverySchema.default('not_allowed'),
  packagingNote: z.string().trim().max(1000).default(''),
  items: z.array(enquiryItemInputSchema).max(50).default([]),
  documents: z.array(enquiryDocumentInputSchema).max(50).default([]),
});

export const submitEnquiryRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const cancelEnquiryRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(300),
});

export const copyEnquiryRequestSchema = z.object({
  title: z.string().trim().max(200).optional(),
});

// ------------------------------------------------------------------- triage

export const clarificationTopicSchema = z.enum([
  'material',
  'tolerance',
  'quantity',
  'documents',
  'quality',
  'delivery',
  'commercial',
  'other',
]);

export const requestClarificationRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  questions: z
    .array(
      z.object({
        topic: clarificationTopicSchema,
        question: z.string().trim().min(1).max(1000),
        lineNo: z.number().int().positive().max(999).optional(),
      }),
    )
    .min(1)
    .max(20),
});

export const submitClarificationRequestSchema = z.object({
  answers: z
    .array(
      z.object({
        clarificationId: z.uuid(),
        answer: z.string().trim().min(1).max(4000),
        answerDocumentVersionId: z.uuid().optional(),
      }),
    )
    .min(1)
    .max(20),
});

export const startTriageRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const approveForSourcingRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  /** The reviewer's explicit answer to a CAD/2D conflict, if one was flagged. */
  governingDocumentVersionId: z.uuid().optional(),
  note: z.string().trim().max(1000).optional(),
});

export const declineEnquiryRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000),
});

// ------------------------------------------------------------------ responses

export const clarificationSchema = z.object({
  clarificationId: z.uuid(),
  sequenceNo: z.number().int().positive(),
  roundNo: z.number().int().positive(),
  topic: clarificationTopicSchema,
  question: z.string(),
  lineNo: z.number().int().positive().nullable(),
  askedAgainstRevisionNo: z.number().int().positive(),
  status: z.enum(['open', 'answered', 'withdrawn']),
  answer: z.string().nullable(),
  answerDocumentVersionId: z.uuid().nullable(),
  askedAt: z.string(),
  answeredAt: z.string().nullable(),
});

export const enquiryItemSchema = enquiryItemInputSchema.extend({
  enquiryItemId: z.uuid(),
});

export const enquiryDocumentSchema = z.object({
  enquiryDocumentId: z.uuid(),
  documentVersionId: z.uuid(),
  lineNo: z.number().int().positive().nullable(),
  role: enquiryDocumentRoleSchema,
  note: z.string(),
});

/** What operations sees: the real state, every guard, and the reviewer's checklist. */
export const enquirySchema = z.object({
  enquiryId: z.uuid(),
  reference: z.string().nullable(),
  customerOrganizationId: z.uuid(),
  title: z.string(),
  applicationNote: z.string(),
  status: enquiryStatusSchema,
  confidentiality: confidentialitySchema,
  jobType: jobTypeSchema,
  materialSupply: materialSupplySchema,
  changeReference: z.string(),
  changeDescription: z.string(),
  relatedEnquiryId: z.uuid().nullable(),
  assistedIntake: z.boolean(),
  deliverySiteId: z.uuid().nullable(),
  requiredByDate: z.string().nullable(),
  partialDelivery: partialDeliverySchema,
  packagingNote: z.string(),
  submittedRevisionNo: z.number().int().positive().nullable(),
  currentRevisionNo: z.number().int().positive().nullable(),
  aggregateVersion: z.number().int().positive(),
  copiedFromEnquiryId: z.uuid().nullable(),
  submittedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  items: z.array(enquiryItemSchema),
  documents: z.array(enquiryDocumentSchema),
  clarifications: z.array(clarificationSchema),
});

export const requirementRevisionSchema = z.object({
  requirementId: z.uuid(),
  revisionNo: z.number().int().positive(),
  kind: z.enum(['intake', 'reviewed']),
  contentHash: z.string(),
  frozenAt: z.string(),
  snapshot: z.unknown(),
  /** Why engineering revised a requirement already in sourcing (F-12.5); null otherwise. */
  revisionReason: z.string().nullable().optional(),
});

/**
 * Engineering revises a requirement after suppliers have bid on it (F-12.5; doc 19 §10
 * scenario 5). Only what a supplier prices can change: specification, quantities, the
 * governing drawing. Rounds still live on the old revision are superseded; bids on them
 * are kept as submitted and never awarded.
 */
export const reviseRequirementItemSchema = z.object({
  enquiryItemId: z.uuid(),
  description: z.string().trim().max(4000).optional(),
  materialGrade: z.string().trim().max(120).optional(),
  quantityBreakpoints: z.array(quantityBreakpointSchema).min(1).max(6).optional(),
  toleranceClass: z.string().trim().max(40).optional(),
  criticalTolerance: measurementSchema.nullable().optional(),
  surfaceFinish: z.string().trim().max(120).optional(),
  heatTreatment: z.string().trim().max(120).optional(),
  coating: z.string().trim().max(120).optional(),
  inspectionLevel: inspectionLevelSchema.optional(),
  qualityNote: z.string().trim().max(2000).optional(),
});

export const reviseRequirementRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(3, 'Say why the requirement changed').max(1000),
    items: z.array(reviseRequirementItemSchema).max(50).default([]),
    governingDocumentVersionId: z.uuid().optional(),
  })
  .refine((r) => r.items.length > 0 || r.governingDocumentVersionId !== undefined, {
    message: 'Change at least one item or the governing document',
    path: ['items'],
  });

/**
 * The customer projection (doc 06 §13). Deliberately a *different shape*, not a
 * filtered enquiry: there is no field here that could accidentally carry an internal
 * state name, and the wording is fixed by the doc rather than by whoever renders it.
 */
export const customerEnquiryStatusSchema = z.enum([
  'draft',
  'requirement_review',
  'information_needed',
  'sourcing_in_progress',
  'closed',
  'cancelled',
]);

export const customerEnquirySchema = z.object({
  enquiryId: z.uuid(),
  reference: z.string().nullable(),
  title: z.string(),
  jobType: jobTypeSchema,
  jobTypeLabel: z.string(),
  status: customerEnquiryStatusSchema,
  statusLabel: z.string(),
  actionNeeded: z
    .object({
      kind: z.enum(['answer_questions', 'complete_draft']),
      label: z.string(),
      detail: z.string(),
      openQuestionCount: z.number().int().nonnegative(),
    })
    .nullable(),
  itemCount: z.number().int().nonnegative(),
  /**
   * The concurrency token, not an internal fact: a customer command that changes this
   * enquiry — withdrawing it — has to say which version it was looking at. Without it the
   * projection can be read but never acted on, which is how the withdraw button came to
   * be missing in the first place.
   */
  aggregateVersion: z.number().int().positive(),
  requiredByDate: z.string().nullable(),
  submittedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export const completenessFlagSchema = z.object({
  code: z.enum([
    'missing_process',
    'missing_material',
    'missing_quantity',
    'missing_documents',
    'missing_required_date',
    'cad_2d_conflict',
    'assisted_intake_unresolved',
    'open_clarifications',
    'missing_change_reference',
    'change_without_related_enquiry',
    'customer_material_custody',
  ]),
  severity: z.enum(['blocking', 'advisory']),
  label: z.string(),
  lineNo: z.number().int().positive().nullable(),
});

export type Confidentiality = z.infer<typeof confidentialitySchema>;
export type JobType = z.infer<typeof jobTypeSchema>;
export type MaterialSupply = z.infer<typeof materialSupplySchema>;
export type EnquiryStatus = z.infer<typeof enquiryStatusSchema>;
export type QuantityBreakpoint = z.infer<typeof quantityBreakpointSchema>;
export type Measurement = z.infer<typeof measurementSchema>;
export type EnquiryItemInput = z.infer<typeof enquiryItemInputSchema>;
export type EnquiryDocumentInput = z.infer<typeof enquiryDocumentInputSchema>;
export type SaveDraftRequest = z.infer<typeof saveDraftRequestSchema>;
export type SubmitEnquiryRequest = z.infer<typeof submitEnquiryRequestSchema>;
export type CancelEnquiryRequest = z.infer<typeof cancelEnquiryRequestSchema>;
export type CopyEnquiryRequest = z.infer<typeof copyEnquiryRequestSchema>;
export type StartTriageRequest = z.infer<typeof startTriageRequestSchema>;
export type RequestClarificationRequest = z.infer<typeof requestClarificationRequestSchema>;
export type SubmitClarificationRequest = z.infer<typeof submitClarificationRequestSchema>;
export type ApproveForSourcingRequest = z.infer<typeof approveForSourcingRequestSchema>;
export type DeclineEnquiryRequest = z.infer<typeof declineEnquiryRequestSchema>;
export type Clarification = z.infer<typeof clarificationSchema>;
export type EnquiryItem = z.infer<typeof enquiryItemSchema>;
export type EnquiryDocument = z.infer<typeof enquiryDocumentSchema>;
export type Enquiry = z.infer<typeof enquirySchema>;
export type RequirementRevision = z.infer<typeof requirementRevisionSchema>;
export type ReviseRequirementItem = z.infer<typeof reviseRequirementItemSchema>;
export type ReviseRequirementRequest = z.infer<typeof reviseRequirementRequestSchema>;
export type CustomerEnquiryStatus = z.infer<typeof customerEnquiryStatusSchema>;
export type CustomerEnquiry = z.infer<typeof customerEnquirySchema>;
export type CompletenessFlag = z.infer<typeof completenessFlagSchema>;
export type ClarificationTopic = z.infer<typeof clarificationTopicSchema>;
export type InspectionLevel = z.infer<typeof inspectionLevelSchema>;
export type EnquiryDocumentRole = z.infer<typeof enquiryDocumentRoleSchema>;
