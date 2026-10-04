import type { Logger } from '@jobwork/observability';
import { randomUUID } from 'node:crypto';
import type { InternalApiClient } from '../../internal-api';
import type { SweepReport } from '../../metrics';

/**
 * The scheduled half of doc 06 §14: ask the API to settle every verification item whose
 * stored expiry has passed, and to warn on the ones approaching it.
 *
 * The schedule is a nudge, not the source of truth — the command re-reads the dates
 * every time, so a missed run delays a notification rather than leaving an expired
 * supplier quietly matchable. Running it twice is a no-op the second time.
 */
export function verificationExpiryScan(api: InternalApiClient, log: Logger, report: SweepReport = () => undefined) {
  return async (): Promise<void> => {
    const correlationId = randomUUID();
    try {
      const result = await api.sweepVerificationExpiry({
        correlationId,
        idempotencyKey: `verification-sweep:${correlationId}`,
      });
      if (result.expired > 0 || result.expiring > 0) {
        log.info({ ...result, correlationId }, 'supplier.verification_sweep');
      }
      report('ok');
    } catch (cause) {
      report('failed');
      // A failed sweep is retried on the next tick; nothing is left half-applied
      // because the command runs in one transaction.
      log.warn(
        { correlationId, err: cause instanceof Error ? cause.message : String(cause) },
        'supplier.verification_sweep_failed',
      );
    }
  };
}
