import { randomUUID } from 'node:crypto';
import type { Logger } from '@jobwork/observability';
import type { InternalApiClient } from '../internal-api';

/**
 * The SLA tick (F-11.1; doc 07 §11). The API owns the sweep — it holds the queue state and
 * the business tables (doc 20 §9); the worker only decides how often it is asked. A missed
 * tick delays an escalation, it never loses one: the due rows stay due until a sweep
 * records them, and the escalation key makes a repeated sweep harmless.
 */
export function slaEscalator(api: InternalApiClient, log: Logger) {
  return async (): Promise<void> => {
    const correlationId = randomUUID();
    try {
      const result = await api.sweepSla({ correlationId, idempotencyKey: `sla-sweep:${correlationId}` });
      if (result.opened + result.closed + result.rescheduled + result.escalated > 0) {
        log.info({ ...result, correlationId }, 'platform.sla_sweep');
      }
    } catch (cause) {
      log.warn({ correlationId, err: cause instanceof Error ? cause.message : String(cause) }, 'platform.sla_sweep_failed');
    }
  };
}
