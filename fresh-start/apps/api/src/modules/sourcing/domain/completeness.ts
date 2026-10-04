import type { CompletenessFlag, Enquiry } from '@jobwork/contracts';
import { DomainError } from '../../../platform/http/domain-error';

/**
 * The reviewer's checklist (doc 14 §6). It is computed, never stored: a checklist that
 * can be ticked independently of the data drifts away from it. `blocking` flags stop
 * approve-for-sourcing; `advisory` ones are worth saying out loud but are the
 * reviewer's judgement to overrule.
 */

const LABELS: Record<CompletenessFlag['code'], string> = {
  missing_process: 'No manufacturing process stated',
  missing_material: 'No material or grade stated',
  missing_quantity: 'No quantity stated',
  missing_documents: 'No drawing, CAD file or specification attached',
  missing_required_date: 'No required-by date',
  cad_2d_conflict: 'A CAD file and a 2D drawing are both attached with no governing document declared',
  assisted_intake_unresolved: 'Assisted intake: engineering has not completed the technical fields',
  open_clarifications: 'Questions to the customer are still unanswered',
  missing_change_reference: 'Correction/ECN without a change reference or description',
  change_without_related_enquiry:
    'Correction/ECN does not point at an enquiry on file — confirm which part it corrects',
  customer_material_custody:
    'Job work on customer-supplied material — receiving, custody and delivery challan apply',
};

function flag(
  code: CompletenessFlag['code'],
  severity: CompletenessFlag['severity'],
  lineNo: number | null = null,
): CompletenessFlag {
  return { code, severity, label: LABELS[code], lineNo };
}

/**
 * Doc 19 §3, "CAD and 2D drawing conflict": two engineering documents of different
 * kinds can each claim to be the truth, so somebody has to declare which one governs
 * before a supplier is asked to price it. We detect the situation structurally — a
 * `cad_3d` and a `drawing_2d` present with no `governing` link — rather than trying to
 * read the files and guess whether they actually disagree.
 */
export function evaluateCompleteness(
  enquiry: Enquiry,
  documentTypes: ReadonlyMap<string, string>,
): CompletenessFlag[] {
  const flags: CompletenessFlag[] = [];

  for (const item of enquiry.items) {
    if (!item.processCapabilityId) flags.push(flag('missing_process', 'blocking', item.lineNo));
    if (!item.materialCapabilityId && !item.materialGrade) {
      flags.push(flag('missing_material', 'blocking', item.lineNo));
    }
    if (item.quantityBreakpoints.length === 0) {
      flags.push(flag('missing_quantity', 'blocking', item.lineNo));
    }
  }

  const engineeringDocuments = enquiry.documents.filter((doc) => doc.role !== 'assisted_photo');
  if (engineeringDocuments.length === 0) flags.push(flag('missing_documents', 'blocking'));

  if (!enquiry.requiredByDate) flags.push(flag('missing_required_date', 'advisory'));

  const kinds = new Set(
    enquiry.documents.map((doc) => documentTypes.get(doc.documentVersionId)).filter(Boolean),
  );
  const hasGoverning = enquiry.documents.some((doc) => doc.role === 'governing');
  if (kinds.has('cad_3d') && kinds.has('drawing_2d') && !hasGoverning) {
    flags.push(flag('cad_2d_conflict', 'blocking'));
  }

  if (enquiry.assistedIntake) {
    const technicalGapRemains = enquiry.items.some(
      (item) => !item.processCapabilityId || (!item.materialCapabilityId && !item.materialGrade),
    );
    if (technicalGapRemains) flags.push(flag('assisted_intake_unresolved', 'blocking'));
  }

  if (enquiry.clarifications.some((c) => c.status === 'open')) {
    flags.push(flag('open_clarifications', 'blocking'));
  }

  // Job-type rules (`FR-307`). The blocking one mirrors submit; the advisories are the
  // reviewer's cue to look at custody or lineage before approving.
  if (enquiry.jobType === 'correction_ecn') {
    if (!enquiry.changeReference.trim() || !enquiry.changeDescription.trim()) {
      flags.push(flag('missing_change_reference', 'blocking'));
    }
    if (!enquiry.relatedEnquiryId) flags.push(flag('change_without_related_enquiry', 'advisory'));
  }
  if (enquiry.materialSupply === 'customer_supplied') {
    flags.push(flag('customer_material_custody', 'advisory'));
  }

  return flags;
}

export class SourcingBlocked extends DomainError {
  constructor(flags: CompletenessFlag[]) {
    super(
      'SOURCING_BLOCKED',
      409,
      'This enquiry is not ready to be sourced',
      'Resolve the blocking checklist items first.',
      flags.map((f) => ({ path: f.lineNo ? `items[${f.lineNo}].${f.code}` : f.code, message: f.label })),
    );
  }
}

export function assertReadyForSourcing(flags: CompletenessFlag[]): void {
  const blocking = flags.filter((f) => f.severity === 'blocking');
  if (blocking.length > 0) throw new SourcingBlocked(blocking);
}
