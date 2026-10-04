import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  deliveryId: string;
}

export interface Mailer {
  send(mail: OutboundMail): Promise<void>;
}

/**
 * Dev transport for SMTP_URL=log:// — writes each mail as JSON under var/mail/ so tests and
 * humans can inspect outbound content without an SMTP server. Real SMTP transport lands with
 * IN-02 delivery handlers (plan note: Mailpit/SMTP optional on this machine).
 */
export class FileMailer implements Mailer {
  constructor(private readonly dir: string = join(process.cwd(), 'var', 'mail')) {}

  async send(mail: OutboundMail): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${Date.now()}-${mail.deliveryId}.json`);
    writeFileSync(file, JSON.stringify({ ...mail, sentAt: new Date().toISOString() }, null, 2));
  }
}
