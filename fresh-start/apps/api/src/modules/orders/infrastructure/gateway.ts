import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../../platform/config/config.service';

/**
 * The payment provider port (`T-03`, doc 10 §7). Everything the business logic needs
 * from a provider is: make an intent the customer can pay, and tell us — verifiably —
 * what happened. A real aggregator (Razorpay, Cashfree …) is another implementation of
 * this class; the ingestion path, idempotency and ledger postings do not change.
 */

export interface GatewayIntentRequest {
  intentId: string;
  amountMinor: number;
  currency: string;
  invoiceNumber: string;
  customerName: string;
  expiresAt: Date;
}

export interface GatewayIntent {
  providerIntentId: string;
  checkoutUrl: string;
}

export interface GatewayEvent {
  kind: 'captured' | 'failed';
  providerIntentId: string;
  providerTransactionId: string;
  amountMinor: number;
  currency: string;
  occurredAt: Date;
}

export interface WebhookVerdict {
  ok: boolean;
  deliveryId: string;
  eventType: string;
  event: GatewayEvent | null;
  reason: string | null;
}

/** doc 08 §11: a callback signed more than five minutes ago is refused as a possible replay. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export abstract class PaymentGateway {
  abstract readonly provider: string;
  abstract createIntent(request: GatewayIntentRequest): Promise<GatewayIntent>;
  abstract verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookVerdict;
}

interface DevWebhookBody {
  id: string;
  type: 'payment.captured' | 'payment.failed';
  data: { intentId: string; transactionId: string; amountMinor: number; currency: string; occurredAt: string };
}

/**
 * The development gateway: no network, no money. Its checkout page is a portal route; the
 * "pay" button there asks the API to synthesize a *signed* webhook and run it through the
 * same ingestion the real provider's callbacks use — so dev and test exercise signature
 * checks, delivery-id claims, idempotent posting and allocation exactly as production will.
 */
@Injectable()
export class DevGateway extends PaymentGateway {
  readonly provider = 'dev';
  private readonly secret: string;
  private readonly portalUrl: string;

  constructor(config: ConfigService) {
    super();
    this.secret = config.env.PAYMENT_WEBHOOK_SECRET;
    this.portalUrl = config.env.PORTAL_URL;
  }

  async createIntent(request: GatewayIntentRequest): Promise<GatewayIntent> {
    return {
      providerIntentId: `dev_pi_${randomUUID().replace(/-/g, '')}`,
      checkoutUrl: `${this.portalUrl}/pay/${request.intentId}`,
    };
  }

  /** Signed over `timestamp.body`, as hosted providers do, so a captured delivery cannot be replayed later. */
  sign(timestamp: string, rawBody: string | Buffer): string {
    return createHmac('sha256', this.secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  }

  /** What a provider would send; used by the simulator and by tests. */
  buildWebhook(input: {
    type: 'payment.captured' | 'payment.failed';
    providerIntentId: string;
    amountMinor: number;
    currency: string;
    transactionId?: string | undefined;
    deliveryId?: string | undefined;
    occurredAt?: Date | undefined;
  }): { body: string; headers: Record<string, string> } {
    const payload: DevWebhookBody = {
      id: input.deliveryId ?? `dev_evt_${randomUUID().replace(/-/g, '')}`,
      type: input.type,
      data: {
        intentId: input.providerIntentId,
        transactionId: input.transactionId ?? `dev_txn_${randomUUID().replace(/-/g, '')}`,
        amountMinor: input.amountMinor,
        currency: input.currency,
        occurredAt: (input.occurredAt ?? new Date()).toISOString(),
      },
    };
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      body,
      headers: { 'content-type': 'application/json', 'x-dev-signature': this.sign(timestamp, body), 'x-dev-timestamp': timestamp, 'x-dev-delivery-id': payload.id },
    };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookVerdict {
    const signature = headers['x-dev-signature'];
    const deliveryHeader = headers['x-dev-delivery-id'];
    const deliveryId = typeof deliveryHeader === 'string' ? deliveryHeader : '';
    const timestamp = headers['x-dev-timestamp'];
    if (typeof signature !== 'string' || typeof timestamp !== 'string') {
      return { ok: false, deliveryId, eventType: '', event: null, reason: 'missing signature' };
    }
    const sentAt = Number(timestamp);
    if (!Number.isInteger(sentAt) || Math.abs(Date.now() / 1000 - sentAt) > WEBHOOK_TOLERANCE_SECONDS) {
      return { ok: false, deliveryId, eventType: '', event: null, reason: 'timestamp outside tolerance' };
    }
    const expected = Buffer.from(this.sign(timestamp, rawBody));
    const provided = Buffer.from(signature);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return { ok: false, deliveryId, eventType: '', event: null, reason: 'bad signature' };
    }
    let parsed: DevWebhookBody;
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as DevWebhookBody;
    } catch {
      return { ok: false, deliveryId, eventType: '', event: null, reason: 'malformed body' };
    }
    if (!parsed || typeof parsed.id !== 'string' || !parsed.data || typeof parsed.data.intentId !== 'string') {
      return { ok: false, deliveryId, eventType: parsed?.type ?? '', event: null, reason: 'incomplete event' };
    }
    if (parsed.type !== 'payment.captured' && parsed.type !== 'payment.failed') {
      return { ok: true, deliveryId: parsed.id, eventType: String(parsed.type), event: null, reason: 'unsupported event type' };
    }
    const amount = Number(parsed.data.amountMinor);
    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, deliveryId: parsed.id, eventType: parsed.type, event: null, reason: 'amount is not a positive integer' };
    }
    return {
      ok: true,
      deliveryId: parsed.id,
      eventType: parsed.type,
      event: {
        kind: parsed.type === 'payment.captured' ? 'captured' : 'failed',
        providerIntentId: parsed.data.intentId,
        providerTransactionId: String(parsed.data.transactionId),
        amountMinor: amount,
        currency: String(parsed.data.currency),
        occurredAt: new Date(parsed.data.occurredAt),
      },
      reason: null,
    };
  }
}
