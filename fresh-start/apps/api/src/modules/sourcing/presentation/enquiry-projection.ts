import {
  JOB_TYPE_LABELS,
  type CustomerEnquiry,
  type CustomerEnquiryStatus,
  type Enquiry,
} from '@jobwork/contracts';

/**
 * The customer-facing projection of an enquiry (doc 06 §13 rows 1–2, `FR-303`).
 *
 * This is the only shape a customer endpoint returns. It is built by *construction*,
 * not by deletion: the function reads the internal enquiry and writes a new object
 * with a different vocabulary, so there is no path by which an internal state name,
 * a reviewer's note, a decline reason draft, or anything about a supplier can reach a
 * customer by someone forgetting to strip a field.
 *
 * Two internal states collapse deliberately:
 *   - `submitted` and `under_review` both read as "Requirement review". Whether a
 *     JobWork reviewer has opened it yet is our business, not a status the customer
 *     should be refreshing.
 *   - `approved_for_sourcing` reads as "Sourcing in progress" and carries no hint of
 *     how many suppliers were approached, or that suppliers exist at all.
 */

const STATUS_LABELS: Record<CustomerEnquiryStatus, string> = {
  draft: 'Draft',
  requirement_review: 'Requirement review',
  information_needed: 'Information needed',
  sourcing_in_progress: 'Sourcing in progress',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

function customerStatusOf(enquiry: Enquiry): CustomerEnquiryStatus {
  switch (enquiry.status) {
    case 'draft':
      return 'draft';
    case 'submitted':
    case 'under_review':
      return 'requirement_review';
    case 'clarification_required':
      return 'information_needed';
    case 'approved_for_sourcing':
      return 'sourcing_in_progress';
    case 'closed':
      return 'closed';
    case 'cancelled':
      return 'cancelled';
  }
}

export function projectForCustomer(enquiry: Enquiry): CustomerEnquiry {
  const status = customerStatusOf(enquiry);
  const openQuestionCount = enquiry.clarifications.filter((c) => c.status === 'open').length;

  let actionNeeded: CustomerEnquiry['actionNeeded'] = null;
  if (status === 'information_needed') {
    actionNeeded = {
      kind: 'answer_questions',
      label: 'Answer structured questions',
      detail:
        openQuestionCount === 1
          ? 'One question needs an answer before sourcing can start.'
          : `${openQuestionCount} questions need answers before sourcing can start.`,
      openQuestionCount,
    };
  } else if (status === 'draft') {
    actionNeeded = {
      kind: 'complete_draft',
      label: 'Finish and submit',
      detail: 'Pick it up where you left off, or discard it.',
      openQuestionCount: 0,
    };
  }

  return {
    enquiryId: enquiry.enquiryId,
    reference: enquiry.reference,
    title: enquiry.title,
    jobType: enquiry.jobType,
    jobTypeLabel: JOB_TYPE_LABELS[enquiry.jobType],
    status,
    statusLabel: STATUS_LABELS[status],
    actionNeeded,
    itemCount: enquiry.items.length,
    aggregateVersion: enquiry.aggregateVersion,
    requiredByDate: enquiry.requiredByDate,
    submittedAt: enquiry.submittedAt,
    updatedAt: enquiry.updatedAt,
  };
}

/**
 * The clarification thread as the customer sees it: their own questions and answers.
 * A withdrawn question is dropped rather than shown as withdrawn — the customer never
 * needed to know it was considered.
 */
export function projectClarifications(enquiry: Enquiry): {
  clarificationId: string;
  topic: string;
  question: string;
  lineNo: number | null;
  status: 'open' | 'answered';
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
}[] {
  return enquiry.clarifications
    .filter((c) => c.status !== 'withdrawn')
    .map((c) => ({
      clarificationId: c.clarificationId,
      topic: c.topic,
      question: c.question,
      lineNo: c.lineNo,
      status: c.status as 'open' | 'answered',
      answer: c.answer,
      askedAt: c.askedAt,
      answeredAt: c.answeredAt,
    }));
}
