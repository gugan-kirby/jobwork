import type { Logger } from '@jobwork/observability';
import type { OutboxEventRow } from '../types';

/**
 * Some domain events are published before anything subscribes — the scan verdicts are
 * facts other increments will act on (notification in IN-10, transmittals in F-10.4).
 * Without a handler the poller would dead-letter them, which reads as a delivery
 * failure and would page someone. Acknowledging them keeps the event stream honest
 * and the dead-letter queue meaningful; replacing this with a real subscriber is a
 * one-line change in `main.ts`.
 */
export function acknowledgeHandler(log: Logger, note: string) {
  return (event: OutboxEventRow): Promise<void> => {
    log.info({ eventId: event.id, eventType: event.eventType }, note);
    return Promise.resolve();
  };
}
