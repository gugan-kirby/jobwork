import type { Inspection } from '@jobwork/contracts';
import type { Tone } from '@jobwork/ui';

export const STAGE: Record<Inspection['stage'], string> = {
  incoming: 'Incoming material',
  in_process: 'In-process',
  fai: 'First article',
  final: 'Final',
  jobwork_incoming: 'JobWork incoming',
  customer_receiving: 'Customer receiving',
};

export const INSPECTION_TONE: Record<Inspection['status'], Tone> = {
  planned: 'neutral',
  in_progress: 'progress',
  results_submitted: 'attention',
  under_review: 'attention',
  passed: 'positive',
  failed: 'blocked',
  invalidated: 'neutral',
};

export const NCR_TONE: Record<string, Tone> = {
  open: 'blocked',
  containment: 'blocked',
  disposition_pending: 'attention',
  rework: 'progress',
  reinspection: 'progress',
  deviation_pending: 'attention',
  accepted_under_deviation: 'special',
  rejected: 'neutral',
  verified: 'positive',
  closed: 'positive',
};
