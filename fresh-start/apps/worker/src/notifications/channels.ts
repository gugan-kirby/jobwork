import type { PendingDelivery } from '@jobwork/contracts';
import type { Mailer } from '../mailer';

/**
 * Delivery channels (`FR-1003`, `D-18`): email, SMS and WhatsApp only deliver a pointer
 * to the authenticated thread; the thread is the record. Each channel returns the
 * provider's reference for the delivery it accepted.
 */
export interface DeliveryChannel {
  send(delivery: PendingDelivery): Promise<string>;
}

export class ChannelNotConfigured extends Error {
  constructor(readonly channel: string) {
    super(`no ${channel} provider is configured`);
    this.name = 'ChannelNotConfigured';
  }
}

/** The stable delivery id goes to the provider, so a resend of the same delivery is recognisable. */
export class EmailChannel implements DeliveryChannel {
  constructor(private readonly mailer: Mailer) {}

  async send(delivery: PendingDelivery): Promise<string> {
    await this.mailer.send({ to: delivery.destination, subject: delivery.subject, text: delivery.text, deliveryId: delivery.deliveryId });
    return `mail:${delivery.deliveryId}`;
  }
}

/**
 * SMS and WhatsApp are ports until a provider is chosen (`T-0x` inception decision).
 * They refuse rather than pretend to have sent anything.
 */
export class UnconfiguredChannel implements DeliveryChannel {
  constructor(private readonly channel: string) {}

  send(): Promise<string> {
    return Promise.reject(new ChannelNotConfigured(this.channel));
  }
}

export type Channels = Record<PendingDelivery['channel'], DeliveryChannel>;

export function defaultChannels(mailer: Mailer): Channels {
  return { email: new EmailChannel(mailer), sms: new UnconfiguredChannel('sms'), whatsapp: new UnconfiguredChannel('whatsapp') };
}
