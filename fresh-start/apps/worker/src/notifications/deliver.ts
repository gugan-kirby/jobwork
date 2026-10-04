import type { DispatchNotificationsResponse, RecordDeliveryRequest } from '@jobwork/contracts';
import type { Logger } from '@jobwork/observability';
import type { OutboxEventRow } from '../outbox/types';
import { ChannelNotConfigured, type Channels } from './channels';

export interface NotificationApi {
  dispatchNotifications(eventId: string, ctx: { correlationId: string; idempotencyKey: string }): Promise<DispatchNotificationsResponse>;
  recordDelivery(deliveryId: string, body: RecordDeliveryRequest, ctx: { correlationId: string; idempotencyKey: string }): Promise<unknown>;
}

/**
 * Outbox handler for every notified event (F-10.3). The API decides who hears about the
 * event and renders the words; this sends each pending delivery and reports the outcome.
 *
 * Any failed delivery fails the handler, so the poller retries with backoff. The retry
 * asks the API again, which hands back only deliveries that have not succeeded — with the
 * same delivery ids — so nobody is notified twice for one event.
 */
export function notificationHandler(deps: { api: NotificationApi; channels: Channels; log: Logger }) {
  return async (event: OutboxEventRow): Promise<void> => {
    const ctx = (suffix: string) => ({ correlationId: event.correlationId, idempotencyKey: `notify:${event.id}:${suffix}` });
    const { deliveries } = await deps.api.dispatchNotifications(event.id, ctx(`dispatch:${event.attempts}`));

    let failed = 0;
    for (const delivery of deliveries) {
      const report = ctx(`${delivery.deliveryId}:${delivery.attemptNo}`);
      let providerReference: string;
      try {
        providerReference = await deps.channels[delivery.channel].send(delivery);
      } catch (err) {
        failed += 1;
        const errorCode = err instanceof ChannelNotConfigured ? 'channel_not_configured' : 'send_failed';
        deps.log.warn({ eventId: event.id, deliveryId: delivery.deliveryId, channel: delivery.channel, errorCode }, 'notification delivery failed');
        await deps.api.recordDelivery(delivery.deliveryId, { attemptNo: delivery.attemptNo, status: 'failed', errorCode }, report);
        continue;
      }
      // If this report is lost, the next dispatch closes the attempt as "outcome unknown"
      // and resends under the same delivery id, which the provider can deduplicate.
      await deps.api.recordDelivery(delivery.deliveryId, { attemptNo: delivery.attemptNo, status: 'sent', providerReference }, report);
    }
    if (failed > 0) throw new Error(`${failed} of ${deliveries.length} notification deliveries failed; the event will be retried`);
    if (deliveries.length > 0) deps.log.info({ eventId: event.id, eventType: event.eventType, sent: deliveries.length }, 'notifications delivered');
  };
}
