import { mintServiceToken, SCAN_WORKER_PRINCIPAL, SERVICE_TOKEN_HEADER } from '@jobwork/service-auth';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/boot';
import { buildWorld, WORLD_WEBHOOK_SECRET, type World } from './helpers/world';

const SERVICE_SECRET = 'test-service-token-secret';

/**
 * F-CW.5 (ADR-0009): mail an environment keeps instead of sending. The worker hands it
 * over; only a platform admin reads it, because sign-up and invitation links are
 * credentials.
 */
describe('Mailbox: mail kept instead of sent (F-CW.5)', () => {
  let db: TestDatabase;
  let pg: Client;
  let app: TestApp;
  let baseUrl: string;
  let world: World;

  const handOver = (body: unknown, token = mintServiceToken(SERVICE_SECRET, SCAN_WORKER_PRINCIPAL.name)): Promise<Response> =>
    fetch(`${baseUrl}/api/v1/internal/mail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { [SERVICE_TOKEN_HEADER]: token } : {}) },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_mailbox');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = SERVICE_SECRET;
    process.env['PAYMENT_WEBHOOK_SECRET'] = WORLD_WEBHOOK_SECRET;
    process.env['NODE_ENV'] = 'test';
    pg = new Client({ connectionString: db.url });
    await pg.connect();
    ({ app, baseUrl } = await createTestApp());
    world = await buildWorld(pg, baseUrl);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('keeps one copy per delivery, however often the worker hands it over', async () => {
    const mail = { deliveryId: 'evt-mail-1', to: 'new.customer@kovai.test', subject: 'Verify your email', text: 'Open http://portal/verify-email?token=abc' };
    const first = await handOver(mail);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ outcome: 'recorded' });
    const again = await handOver({ ...mail, subject: 'changed' });
    expect(await again.json()).toEqual({ outcome: 'already_recorded' });
    const rows = await pg.query(`SELECT subject FROM communication.mail_message WHERE delivery_id = 'evt-mail-1'`);
    expect(rows.rows).toEqual([{ subject: 'Verify your email' }]);
  });

  it('takes mail only from the worker, and only well-formed', async () => {
    expect([401, 403]).toContain((await handOver({ deliveryId: 'x', to: 'a@b.test', subject: 's', text: 't' }, '')).status);
    expect((await handOver({ deliveryId: 'evt-mail-2', to: '', subject: 's', text: 't' })).status).toBe(400);
  });

  it('shows the newest mail first to a platform admin', async () => {
    await handOver({ deliveryId: 'evt-mail-3', to: 'invitee@anand.test', subject: 'Invitation to join', text: 'Accept: http://portal/accept-invitation?token=xyz' });
    const read = await world.clients.admin.get('/api/v1/mailbox');
    expect(read.status).toBe(200);
    const messages = read.body['messages'] as Array<{ deliveryId: string; to: string; text: string }>;
    expect(messages.map((m) => m.deliveryId)).toEqual(['evt-mail-3', 'evt-mail-1']);
    expect(messages[0]!.text).toContain('accept-invitation?token=xyz');
  });

  it('refuses everyone else: other staff, customers, suppliers and strangers', async () => {
    expect((await world.clients.sourcing.get('/api/v1/mailbox')).status).toBe(403);
    for (const outsider of [world.clients.customerA, world.clients.supplier1]) {
      expect([403, 404]).toContain((await outsider.get('/api/v1/mailbox')).status);
    }
    expect((await world.clients.anonymous.get('/api/v1/mailbox')).status).toBe(401);
  });
});
