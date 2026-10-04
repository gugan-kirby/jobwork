import type { EnquiryStatus, JobType } from '@jobwork/contracts';
import { DomainError } from '../../../platform/http/domain-error';

/**
 * The doc 06 §3 enquiry lifecycle. Every move is a named command with a guard; there is
 * no "set status" anywhere, which is why this table is the only place transitions live.
 *
 *   draft -> submitted -> under_review -> clarification_required -> under_review
 *   under_review -> approved_for_sourcing | closed
 *   draft | submitted -> cancelled
 */
const TRANSITIONS: Record<EnquiryStatus, readonly EnquiryStatus[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['under_review', 'cancelled'],
  under_review: ['clarification_required', 'approved_for_sourcing', 'closed'],
  clarification_required: ['under_review'],
  approved_for_sourcing: ['closed'],
  closed: [],
  cancelled: [],
};

export function canTransition(from: EnquiryStatus, to: EnquiryStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class EnquiryTransitionRejected extends DomainError {
  constructor(from: EnquiryStatus, to: EnquiryStatus) {
    super(
      'ENQUIRY_TRANSITION_REJECTED',
      409,
      'That is not a step this enquiry can take',
      `Recorded ${from}; refused ${to}.`,
    );
  }
}

export function assertTransition(from: EnquiryStatus, to: EnquiryStatus): void {
  if (!canTransition(from, to)) throw new EnquiryTransitionRejected(from, to);
}

export class EnquiryNotFound extends DomainError {
  constructor() {
    super('ENQUIRY_NOT_FOUND', 404, 'Enquiry not found');
  }
}

export class EnquiryItemNotFound extends DomainError {
  constructor(enquiryItemId: string) {
    super('ENQUIRY_ITEM_NOT_FOUND', 422, 'That item is not on this enquiry', undefined, [{ path: 'items', message: enquiryItemId }]);
  }
}

export class EnquiryVersionConflict extends DomainError {
  constructor(expected: number, actual: number) {
    super(
      'VERSION_CONFLICT',
      409,
      'Someone else changed this enquiry while you were editing',
      `You were working from version ${expected}; it is now version ${actual}. Reload to see their changes before saving yours.`,
    );
  }
}

export function assertVersion(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new EnquiryVersionConflict(expected, actual);
  }
}

export class DraftNotEditable extends DomainError {
  constructor(status: EnquiryStatus) {
    super(
      'DRAFT_NOT_EDITABLE',
      409,
      'This enquiry is no longer a draft',
      `It is ${status}. A change now goes through clarification, not by editing what was submitted.`,
    );
  }
}

export class ClarificationNotOpen extends DomainError {
  constructor() {
    super('CLARIFICATION_NOT_OPEN', 409, 'That question is not open for an answer');
  }
}

/**
 * A field the customer must supply before an enquiry can be sourced, expressed as a
 * path the wizard can highlight rather than a sentence it has to parse (doc 14 §4).
 */
export interface FieldIssue {
  path: string;
  code: string;
  message: string;
}

export class EnquiryIncomplete extends DomainError {
  constructor(issues: FieldIssue[]) {
    // The field paths travel in `errors`, which the problem filter already emits, so
    // the wizard can highlight the exact step that is short rather than show a wall.
    super(
      'ENQUIRY_INCOMPLETE',
      422,
      'Some required details are still missing',
      `${issues.length} field${issues.length === 1 ? '' : 's'} still needed.`,
      issues.map((issue) => ({ path: issue.path, message: issue.message })),
    );
  }
}

export interface SubmissionCandidate {
  title: string;
  jobType: JobType;
  changeReference: string;
  changeDescription: string;
  requiredByDate: string | null;
  assistedIntake: boolean;
  items: readonly {
    lineNo: number;
    partName: string;
    description: string;
    processCapabilityId: string | null;
    materialCapabilityId: string | null;
    materialGrade: string | null;
    quantityBreakpoints: readonly { quantity: number }[];
  }[];
  documents: readonly { role: string; lineNo: number | null }[];
}

/**
 * `FR-302` category-dependent mandatory fields, checked once at submit.
 *
 * The assisted path (doc 19 §3, "only a photo/vague description") relaxes the
 * *technical* fields — process, material, tolerance — because the customer genuinely
 * does not know them yet and engineering will fill them in. It does not relax the
 * fields that make an enquiry an enquiry: something to make, how many, and at least
 * one piece of evidence to look at. An assisted enquiry is accepted; it is simply
 * never released as an RFQ from intake alone.
 */
export function validateForSubmission(candidate: SubmissionCandidate): FieldIssue[] {
  const issues: FieldIssue[] = [];

  if (candidate.title.trim().length === 0) {
    issues.push({ path: 'title', code: 'required', message: 'Give the enquiry a short title' });
  }
  if (candidate.items.length === 0) {
    issues.push({ path: 'items', code: 'required', message: 'Add at least one item' });
  }

  // `FR-307`: a correction without a reference and a description of the change is a
  // new-model enquiry wearing the wrong label. Neither is relaxed on the assisted path —
  // the customer always knows *what* they want changed even when they cannot say how.
  if (candidate.jobType === 'correction_ecn') {
    if (candidate.changeReference.trim().length === 0) {
      issues.push({
        path: 'changeReference',
        code: 'required',
        message: 'Quote your change reference (ECN or revision number)',
      });
    }
    if (candidate.changeDescription.trim().length === 0) {
      issues.push({
        path: 'changeDescription',
        code: 'required',
        message: 'Describe what changed against the previous version',
      });
    }
  }

  for (const item of candidate.items) {
    const at = `items[${item.lineNo}]`;
    const described =
      item.partName.trim().length > 0 || item.description.trim().length > 0;
    if (!described) {
      issues.push({
        path: `${at}.partName`,
        code: 'required',
        message: 'Name the part or describe what it is',
      });
    }
    const totalQuantity = item.quantityBreakpoints.reduce((sum, b) => sum + b.quantity, 0);
    if (totalQuantity <= 0) {
      issues.push({
        path: `${at}.quantityBreakpoints`,
        code: 'required',
        message: 'State at least one quantity',
      });
    }

    if (candidate.assistedIntake) continue;

    if (!item.processCapabilityId) {
      issues.push({
        path: `${at}.processCapabilityId`,
        code: 'required',
        message: 'Choose a manufacturing process, or ask for assisted intake',
      });
    }
    if (!item.materialCapabilityId && !item.materialGrade) {
      issues.push({
        path: `${at}.materialCapabilityId`,
        code: 'required',
        message: 'Choose a material or state a grade, or ask for assisted intake',
      });
    }
  }

  // Something has to be lookable-at. On the assisted path a photo is enough; otherwise
  // an engineering document is what a supplier will actually quote against.
  const hasEngineeringDocument = candidate.documents.some(
    (doc) => doc.role === 'governing' || doc.role === 'reference',
  );
  const hasAnyDocument = candidate.documents.length > 0;
  if (candidate.assistedIntake ? !hasAnyDocument : !hasEngineeringDocument) {
    issues.push({
      path: 'documents',
      code: 'required',
      message: candidate.assistedIntake
        ? 'Attach at least a photo of the part'
        : 'Attach a drawing, CAD file or specification',
    });
  }

  if (!candidate.requiredByDate) {
    issues.push({
      path: 'requiredByDate',
      code: 'required',
      message: 'State when you need this by',
    });
  }

  return issues;
}
