import type { Inspection } from '@jobwork/contracts';

/** Stage names as a workshop says them (IN-14). */
export const STAGE: Record<Inspection['stage'], string> = {
  incoming: 'Incoming material',
  in_process: 'In-process',
  fai: 'First article',
  final: 'Final',
  jobwork_incoming: 'JobWork incoming',
  customer_receiving: 'Customer receiving',
};
