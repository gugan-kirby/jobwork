import { randomUUID } from 'node:crypto';
import type { Logger } from '@jobwork/observability';
import type { InternalApiClient } from '../../internal-api';
import type { SweepReport } from '../../metrics';

/**
 * The RFQ deadline tick (F-06.6). Asks the API to disposition every invitation still
 * open past its round's deadline.
 *
 * Like the verification sweep, the schedule is a nudge and the command re-reads the
 * dates: a missed tick delays the disposition, it never leaves a lapsed invitation
 * looking live, because the control room computes readiness from the deadline itself.
 */
export function rfqDeadlineScan(api: InternalApiClient, log: Logger, report: SweepReport = () => undefined) {
  return async (): Promise<void> => {
    const correlationId = randomUUID();
    try {
      const result = await api.sweepRfqDeadlines({
        correlationId,
        idempotencyKey: `rfq-deadline-sweep:${correlationId}`,
      });
      if (result.lapsed > 0) log.info({ ...result, correlationId }, 'sourcing.rfq_deadline_sweep');
      report('ok');
    } catch (cause) {
      report('failed');
      log.warn(
        { correlationId, err: cause instanceof Error ? cause.message : String(cause) },
        'sourcing.rfq_deadline_sweep_failed',
      );
    }
  };
}
