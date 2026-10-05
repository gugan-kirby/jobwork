import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CarrierStatus } from '@jobwork/contracts';
import { ConfigService } from '../../../platform/config/config.service';

const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface CarrierEvent {
  providerEventId: string;
  /** The shipment's tracking reference, or its number for the dev carrier. */
  reference: string;
  rawStatus: string;
  normalizedStatus: CarrierStatus;
  occurredAt: Date;
  raw: Record<string, unknown>;
}

export type CarrierVerdict = { ok: true; event: CarrierEvent | null; reason: string } | { ok: false; reason: string };

/**
 * The carrier behind one port (IN-16 F-16.2; `T-05` open; doc 08 §11). Whatever the provider says
 * arrives here signed, is normalized, and is kept raw beside the normalized status. A carrier's
 * "delivered" is evidence of the carrier's custody ending, never JobWork's receipt (doc 06 §11).
 */
export abstract class CarrierPort {
  abstract readonly provider: string;
  abstract verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): CarrierVerdict;
}

/** Raw dev codes, as a carrier aggregator would send them, onto the five normalized statuses. */
const DEV_CODES: Record<string, CarrierStatus> = { PU: 'picked_up', IT: 'in_transit', OFD: 'out_for_delivery', DL: 'delivered', EX: 'exception' };

/** The development carrier: no network. Webhooks are HMAC-signed over `timestamp.body`, as the payment gateway's are. */
@Injectable()
export class DevCarrier extends CarrierPort {
  readonly provider = 'dev';
  private readonly secret: string;

  constructor(config: ConfigService) {
    super();
    this.secret = config.env.CARRIER_WEBHOOK_SECRET;
  }

  sign(timestamp: string, rawBody: Buffer | string): string {
    return createHmac('sha256', this.secret).update(`${timestamp}.${rawBody.toString()}`).digest('hex');
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): CarrierVerdict {
    const signature = headers['x-dev-signature'];
    const timestamp = headers['x-dev-timestamp'];
    if (typeof signature !== 'string' || typeof timestamp !== 'string') return { ok: false, reason: 'missing signature' };
    const sentAt = Number(timestamp);
    if (!Number.isInteger(sentAt) || Math.abs(Date.now() / 1000 - sentAt) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: 'timestamp outside tolerance' };
    const expected = Buffer.from(this.sign(timestamp, rawBody));
    const provided = Buffer.from(signature);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return { ok: false, reason: 'bad signature' };
    let body: { id?: unknown; reference?: unknown; code?: unknown; occurredAt?: unknown };
    try {
      body = JSON.parse(rawBody.toString('utf8')) as typeof body;
    } catch {
      return { ok: false, reason: 'malformed body' };
    }
    if (typeof body.id !== 'string' || typeof body.reference !== 'string' || typeof body.code !== 'string') return { ok: false, reason: 'incomplete event' };
    const normalized = DEV_CODES[body.code];
    if (!normalized) return { ok: true, event: null, reason: `unmapped carrier code ${body.code}` };
    const occurredAt = typeof body.occurredAt === 'string' ? new Date(body.occurredAt) : new Date();
    if (Number.isNaN(occurredAt.getTime())) return { ok: false, reason: 'bad occurredAt' };
    return { ok: true, reason: '', event: { providerEventId: body.id, reference: body.reference, rawStatus: body.code, normalizedStatus: normalized, occurredAt, raw: body as Record<string, unknown> } };
  }
}
