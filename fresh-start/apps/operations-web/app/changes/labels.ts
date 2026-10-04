import type { ChangeRequest } from '@jobwork/contracts';
import type { Tone } from '@jobwork/ui';

export const CHANGE_TONE: Record<ChangeRequest['status'], Tone> = {
  proposed: 'attention',
  triage: 'progress',
  clarification: 'attention',
  impact_analysis: 'progress',
  commercial_approval: 'attention',
  approved: 'attention',
  rejected: 'neutral',
  released: 'progress',
  implemented: 'progress',
  verified: 'positive',
  closed: 'positive',
  withdrawn: 'neutral',
};

export const ORIGIN: Record<ChangeRequest['origin'], string> = {
  customer: 'Customer',
  supplier: 'Supplier',
  internal: 'JobWork',
  document_revision: 'New document revision',
};

