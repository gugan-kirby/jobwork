import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMailer, FileMailer, SmtpMailer, smtpOptions } from '../src/mailer';

/** Without a real transport no customer can verify an email and no invitation arrives. */
describe('worker mail transport', () => {
  let server: SMTPServer | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('keeps the file transport for log://', () => {
    expect(buildMailer({ smtpUrl: 'log://', smtpFrom: '' })).toBeInstanceOf(FileMailer);
  });

  it('builds an SMTP transport for smtp:// and smtps://', () => {
    const from = 'JobWork <jobwork.staging@gmail.com>';
    expect(buildMailer({ smtpUrl: 'smtp://localhost:1025', smtpFrom: from })).toBeInstanceOf(SmtpMailer);
    expect(buildMailer({ smtpUrl: 'smtps://localhost:465', smtpFrom: from })).toBeInstanceOf(SmtpMailer);
  });

  it('refuses an SMTP transport with no sender', () => {
    expect(() => buildMailer({ smtpUrl: 'smtp://localhost:1025', smtpFrom: '' })).toThrow(/SMTP_FROM/);
  });

  it('refuses an unknown scheme', () => {
    expect(() => buildMailer({ smtpUrl: 'http://localhost', smtpFrom: 'a@b.test' })).toThrow(/unsupported SMTP_URL/);
  });

  it('decodes credentials and will not send them over a plain connection', () => {
    const options = smtpOptions('smtp://jobwork.staging%40gmail.com:abcdefghijklmnop@smtp.gmail.com:587');
    expect(options).toMatchObject({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'jobwork.staging@gmail.com', pass: 'abcdefghijklmnop' },
    });
  });

  it('connects with implicit TLS for smtps:// and needs no auth without credentials', () => {
    expect(smtpOptions('smtps://mail.test:465')).toMatchObject({ port: 465, secure: true, requireTLS: false });
    expect(smtpOptions('smtps://mail.test:465').auth).toBeUndefined();
  });

  it('delivers through a real SMTP conversation', async () => {
    const received: { from: string; to: string[]; raw: string }[] = [];
    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, session, callback) {
        let raw = '';
        stream.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        stream.on('end', () => {
          received.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((r) => r.address),
            raw,
          });
          callback();
        });
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server.server, 'listening');
    const { port } = server.server.address() as AddressInfo;

    const mailer = buildMailer({ smtpUrl: `smtp://127.0.0.1:${port}`, smtpFrom: 'JobWork <noreply@jobwork.test>' });
    await mailer.send({ to: 'buyer@customer.test', subject: 'Verify your email', text: 'Open this link', deliveryId: 'd-1' });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ from: 'noreply@jobwork.test', to: ['buyer@customer.test'] });
    expect(received[0]!.raw).toContain('Subject: Verify your email');
    expect(received[0]!.raw).toContain('Open this link');
  });

  it('surfaces a failed delivery so the outbox retries it', async () => {
    const mailer = buildMailer({ smtpUrl: 'smtp://127.0.0.1:1', smtpFrom: 'noreply@jobwork.test' });
    await expect(mailer.send({ to: 'a@b.test', subject: 's', text: 't', deliveryId: 'd-2' })).rejects.toThrow();
  });
});
