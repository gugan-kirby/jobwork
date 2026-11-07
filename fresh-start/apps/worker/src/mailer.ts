import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTransport, type Transporter } from 'nodemailer';

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
 * humans can inspect outbound content without an SMTP server.
 */
export class FileMailer implements Mailer {
  constructor(private readonly dir: string = join(process.cwd(), 'var', 'mail')) {}

  async send(mail: OutboundMail): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${Date.now()}-${mail.deliveryId}.json`);
    writeFileSync(file, JSON.stringify({ ...mail, sentAt: new Date().toISOString() }, null, 2));
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  /** Credentials never cross a plain connection: STARTTLS is required, not opportunistic. */
  requireTLS: boolean;
  auth?: { user: string; pass: string };
}

/** `smtp://` upgrades with STARTTLS, `smtps://` is TLS from the first byte. */
export function smtpOptions(smtpUrl: string): SmtpOptions {
  const url = new URL(smtpUrl);
  const secure = url.protocol === 'smtps:';
  const user = decodeURIComponent(url.username);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    requireTLS: !secure && user !== '',
    ...(user ? { auth: { user, pass: decodeURIComponent(url.password) } } : {}),
  };
}

/** A rejected send throws, so the outbox retries it and a dead letter raises the alarm. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = createTransport(smtpOptions(smtpUrl));
  }

  async send(mail: OutboundMail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
  }
}

export function buildMailer(config: { smtpUrl: string; smtpFrom: string }): Mailer {
  if (config.smtpUrl.startsWith('log://')) return new FileMailer();
  if (!/^smtps?:\/\//.test(config.smtpUrl)) {
    // Only the scheme: the rest of this URL holds the password.
    throw new Error(`unsupported SMTP_URL scheme: ${config.smtpUrl.split(':')[0]}`);
  }
  if (!config.smtpFrom) throw new Error('SMTP_FROM is required with an SMTP transport');
  return new SmtpMailer(config.smtpUrl, config.smtpFrom);
}
