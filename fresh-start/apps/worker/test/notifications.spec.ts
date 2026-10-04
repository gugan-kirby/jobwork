import { createLogger } from '@jobwork/observability';
import type { DispatchNotificationsResponse, PendingDelivery, RecordDeliveryRequest } from '@jobwork/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { OutboxEventRow } from '../src/outbox/types';
import type { Mailer, OutboundMail } from '../src/mailer';
import { defaultChannels } from '../src/notifications/channels';
import { notificationHandler, type NotificationApi } from '../src/notifications/deliver';

/** F-10.3 worker half: deliver what the API rendered, report each outcome, retry on failure. */

const log = createLogger({ service: 'worker-test', level: 'silent' });

const event: OutboxEventRow = {
  id: '0190a1b2-0000-7000-8000-000000000001',
  eventType: 'commercial.quote_sent.v1',
  occurredAt: new Date(),
  aggregateType: 'customer_quote',
  aggregateId: 'q1',
  aggregateVersion: 1,
  organizationId: null,
  actor: { type: 'user', id: null },
  correlationId: 'corr-1',
  data: {},
  attempts: 0,
};

function delivery(id: string, channel: PendingDelivery['channel'] = 'email'): PendingDelivery {
  return { deliveryId: id, attemptNo: 1, channel, destination: 'buyer@kovai.test', subject: 'Your quotation is ready', text: 'Sign in: https://portal' };
}

function fakes(deliveries: PendingDelivery[], mailer: Mailer) {
  const reports: Array<{ deliveryId: string; body: RecordDeliveryRequest }> = [];
  const api: NotificationApi = {
    dispatchNotifications: vi.fn(async (): Promise<DispatchNotificationsResponse> => ({ notifications: deliveries.length, deliveries })),
    recordDelivery: vi.fn(async (deliveryId: string, body: RecordDeliveryRequest) => {
      reports.push({ deliveryId, body });
      return { outcome: 'recorded' };
    }),
  };
  return { api, reports, handler: notificationHandler({ api, channels: defaultChannels(mailer), log }) };
}

describe('notification delivery', () => {
  it('sends each delivery under its stable id and reports it sent', async () => {
    const sent: OutboundMail[] = [];
    const { api, reports, handler } = fakes([delivery('d1'), delivery('d2')], { send: async (m) => void sent.push(m) });
    await handler(event);
    expect(api.dispatchNotifications).toHaveBeenCalledWith(event.id, expect.objectContaining({ correlationId: 'corr-1' }));
    expect(sent.map((m) => m.deliveryId)).toEqual(['d1', 'd2']);
    expect(reports).toEqual([
      { deliveryId: 'd1', body: { attemptNo: 1, status: 'sent', providerReference: 'mail:d1' } },
      { deliveryId: 'd2', body: { attemptNo: 1, status: 'sent', providerReference: 'mail:d2' } },
    ]);
  });

  it('reports a failed send and fails the event so it is retried', async () => {
    let calls = 0;
    const { reports, handler } = fakes([delivery('d1'), delivery('d2')], {
      send: async () => {
        calls += 1;
        if (calls === 1) throw new Error('smtp timeout');
      },
    });
    await expect(handler(event)).rejects.toThrow(/1 of 2 notification deliveries failed/);
    expect(reports.map((r) => [r.deliveryId, r.body.status, r.body.errorCode ?? null])).toEqual([
      ['d1', 'failed', 'send_failed'],
      ['d2', 'sent', null],
    ]);
  });

  it('refuses SMS and WhatsApp until a provider is chosen, rather than pretending', async () => {
    const { reports, handler } = fakes([delivery('s1', 'sms'), delivery('w1', 'whatsapp')], { send: async () => undefined });
    await expect(handler(event)).rejects.toThrow(/2 of 2/);
    expect(reports.every((r) => r.body.errorCode === 'channel_not_configured')).toBe(true);
  });

  it('does nothing when there is no one to tell', async () => {
    const send = vi.fn(async () => undefined);
    const { reports, handler } = fakes([], { send });
    await handler(event);
    expect(send).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });
});
