import { randomUUID } from 'node:crypto';
import type { Logger } from '@jobwork/observability';
import type { InternalApiClient } from '../../internal-api';
import type { SweepReport } from '../../metrics';

/**
 * The payment reconcile tick (F-08.5). Asks the API to close payment intents that
 * expired unpaid. Like the other sweeps, the timer only decides how often to ask; the
 * command re-reads each intent under lock, and a capture that arrives late is still
 * posted by the callback path.
 */
export function paymentReconcileScan(api: InternalApiClient, log: Logger, report: SweepReport = () => undefined) {
  return async (): Promise<void> => {
    const correlationId = randomUUID();
    try {
      const result = await api.sweepPayments({ correlationId, idempotencyKey: `payment-reconcile-sweep:${correlationId}` });
      if (result.expired > 0) log.info({ ...result, correlationId }, 'finance.payment_reconcile_sweep');
      report('ok');
    } catch (cause) {
      report('failed');
      log.warn({ correlationId, err: cause instanceof Error ? cause.message : String(cause) }, 'finance.payment_reconcile_sweep_failed');
    }
  };
}
