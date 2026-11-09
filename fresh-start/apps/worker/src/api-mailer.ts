import type { InternalApiClient } from './internal-api';
import type { Mailer, OutboundMail } from './mailer';

/**
 * `MAIL_TRANSPORT=api` (F-CW.5, ADR-0009): no mail leaves the environment. Each message
 * goes to the API, which keeps it for platform admins on the operations Mail page. The
 * delivery id is the idempotency key, so a retried event stores one copy.
 */
export class ApiMailer implements Mailer {
  constructor(private readonly api: InternalApiClient) {}

  async send(mail: OutboundMail): Promise<void> {
    await this.api.recordMail(
      { deliveryId: mail.deliveryId, to: mail.to, subject: mail.subject, text: mail.text },
      { correlationId: mail.deliveryId, idempotencyKey: `mail:${mail.deliveryId}` },
    );
  }
}
