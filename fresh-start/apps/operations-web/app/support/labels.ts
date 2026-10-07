import type { CaseKind, CaseStatus, ResolutionActionKind } from '@jobwork/contracts';
import type { Tone } from '@jobwork/ui';

export const CASE_KIND: Record<CaseKind, string> = {
  delivery_issue: 'Delivery issue',
  warranty: 'Warranty',
  dispute: 'Dispute',
  supplier_failure: 'Supplier failure',
  chargeback: 'Chargeback',
};

export const CASE_TONE: Record<CaseStatus, Tone> = {
  open: 'attention',
  triage: 'attention',
  investigating: 'progress',
  resolution_proposed: 'special',
  resolution_approved: 'progress',
  executing: 'progress',
  verifying: 'progress',
  closed: 'positive',
  rejected: 'neutral',
  withdrawn: 'neutral',
};

export const ACTION_KIND: Record<ResolutionActionKind, string> = {
  return_to_jobwork: 'Return to JobWork',
  return_to_supplier: 'Return to supplier',
  rework: 'Rework at supplier',
  replacement: 'Replacement',
  credit_note: 'Credit note',
  refund: 'Refund',
  supplier_recovery: 'Recovery from supplier',
  carrier_claim: 'Carrier claim',
  concession: 'Concession',
};
