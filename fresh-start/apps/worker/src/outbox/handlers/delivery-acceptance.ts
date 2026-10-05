import { randomUUID } from 'node:crypto';
import type { Logger } from '@jobwork/observability';
import type { InternalApiClient } from '../../internal-api';
import type { SweepReport } from '../../metrics';

/**
 * The acceptance window's tick (IN-17 F-17.3; FR-905). Asks the API to deem accepted every
 * delivery whose window closed with nothing holding it. The timer only decides how often to ask;
 * the command re-reads each delivery under lock, so a customer's report that lands first wins.
 */
export function deliveryAcceptanceScan(api: InternalApiClient, log: Logger, report: SweepReport = () => undefined) {
  return async (): Promise<void> => {
    const correlationId = randomUUID();
    try {
      const result = await api.sweepDeliveryAcceptance({ correlationId, idempotencyKey: `delivery-acceptance-sweep:${correlationId}` });
      if (result.deemed > 0) log.info({ ...result, correlationId }, 'logistics.delivery_acceptance_sweep');
      report('ok');
    } catch (cause) {
      report('failed');
      log.warn({ correlationId, err: cause instanceof Error ? cause.message : String(cause) }, 'logistics.delivery_acceptance_sweep_failed');
    }
  };
}
