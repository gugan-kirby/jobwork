import type { CaseKind, CaseStatus, ResolutionActionKind } from '@jobwork/contracts';
import type { Tone } from '@jobwork/ui';

/** What a customer can raise; supplier failures and chargebacks are JobWork's to open. */
export const CUSTOMER_CASE_KINDS: ReadonlyArray<{ value: CaseKind; label: string }> = [
  { value: 'delivery_issue', label: 'Something is wrong with a delivery' },
  { value: 'warranty', label: 'A part failed in use (warranty)' },
  { value: 'dispute', label: 'A disagreement about the order or invoice' },
];

export const CASE_KIND: Record<CaseKind, string> = {
  delivery_issue: 'Delivery issue',
  warranty: 'Warranty',
  dispute: 'Dispute',
  supplier_failure: 'Order issue',
  chargeback: 'Payment issue',
};

export const CASE_TONE: Record<CaseStatus, Tone> = {
  open: 'progress',
  triage: 'progress',
  investigating: 'progress',
  resolution_proposed: 'progress',
  resolution_approved: 'attention',
  executing: 'attention',
  verifying: 'attention',
  closed: 'positive',
  rejected: 'neutral',
  withdrawn: 'neutral',
};

export const REMEDY: Record<ResolutionActionKind, string> = {
  return_to_jobwork: 'JobWork collects the parts',
  return_to_supplier: 'Parts go back for correction',
  rework: 'Parts are reworked',
  replacement: 'Replacement parts',
  credit_note: 'Credit note',
  refund: 'Refund',
  supplier_recovery: '',
  carrier_claim: 'Claim with the carrier',
  concession: 'Agreed concession',
};
