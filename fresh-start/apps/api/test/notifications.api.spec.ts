import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { mintServiceToken, SCAN_WORKER_PRINCIPAL, SERVICE_TOKEN_HEADER } from '@jobwork/service-auth';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'notification-password-1';
const SERVICE_SECRET = 'test-service-token-secret';
type Body = Record<string, unknown>;

/**
 * F-10.3 end to end: every notification traces to a committed outbox event with its
 * template version and correlation id; one event reaches a person once however often it is
 * dispatched; a rolled-back command leaves nothing to send; a template that reaches outside
 * its allowlist sends nothing at all; and a thread notification never carries the message.
 */
describe('Notifications (F-10.3)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let customerOrgId: string;
  let supplierOrgA: string;
  let supplierOrgB: string;
  let enquiryId: string;
  let rfqId: string;
  let sourcingUserId: string;

  let buyer: TestClient;
  let approver: TestClient;
  let sourcing: TestClient;
  let supplierA: TestClient;

  const one = async <T = Body>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;

  function totp(secret: string, email: string): string {
    return new OTPAuth.TOTP({ issuer: 'JobWork', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  }

  async function seedOrg(type: string, name: string): Promise<string> {
    return (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ($1, $2, $2) RETURNING id`, [type, name])).id;
  }

  async function seedUser(orgId: string, email: string, roles: string[]): Promise<string> {
    const user = await one<{ id: string }>(
      `INSERT INTO iam.user_account (email, password_hash, password_params_version, display_name, status, email_verified_at) VALUES ($1, $2, 1, $3, 'active', now()) RETURNING id`,
      [email, await hashPassword(PASSWORD), email.split('@')[0]],
    );
    const m = await one<{ id: string }>(`INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`, [user.id, orgId]);
    await pg.query(`INSERT INTO iam.membership_role (membership_id, role_id) SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`, [m.id, roles]);
    return user.id;
  }

  async function signIn(email: string, mfa = false): Promise<TestClient> {
    const first = new TestClient(baseUrl);
    expect((await first.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(201);
    if (!mfa) return first;
    const enroll = await first.post('/api/v1/account/mfa/enroll');
    await first.post('/api/v1/account/mfa/activate', { code: totp(enroll.body['secret'] as string, email) });
    const fresh = new TestClient(baseUrl);
    await fresh.post('/api/v1/auth/login', { email, password: PASSWORD });
    const secret = await one<{ mfa_totp_secret: string }>(`SELECT mfa_totp_secret FROM iam.user_account WHERE email = $1`, [email]);
    await fresh.post('/api/v1/auth/mfa', { code: totp(secret.mfa_totp_secret, email) });
    return fresh;
  }

  async function worker(path: string, body: unknown): Promise<{ status: number; body: Body }> {
    const res = await fetch(`${baseUrl}/api/v1/internal/notifications/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SERVICE_TOKEN_HEADER]: mintServiceToken(SERVICE_SECRET, SCAN_WORKER_PRINCIPAL.name) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Body) : {} };
  }

  const dispatch = (eventId: string) => worker('dispatch', { eventId });

  async function commitEvent(eventType: string, aggregateType: string, aggregateId: string, data: Body, actorId: string | null = null): Promise<string> {
    return (await one<{ id: string }>(
      `INSERT INTO platform.outbox_event (event_type, aggregate_type, aggregate_id, actor, correlation_id, data)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [eventType, aggregateType, aggregateId, JSON.stringify({ type: 'user', id: actorId }), `corr-${eventType}`, JSON.stringify(data)],
    )).id;
  }

  async function eventFor(messageId: string): Promise<string> {
    return (await one<{ id: string }>(`SELECT id FROM platform.outbox_event WHERE aggregate_id = $1`, [messageId])).id;
  }

  async function recipientsOf(eventId: string): Promise<string[]> {
    const rows = await pg.query<{ email: string }>(
      `SELECT u.email FROM communication.notification n JOIN iam.user_account u ON u.id = n.recipient_user_id WHERE n.source_event_id = $1 ORDER BY u.email`,
      [eventId],
    );
    return rows.rows.map((r) => r.email);
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_notifications');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = SERVICE_SECRET;
    process.env['PORTAL_URL'] = 'https://portal.jobwork.test';
    process.env['OPERATIONS_URL'] = 'https://ops.jobwork.test';
    process.env['NODE_ENV'] = 'test';
    pg = new Client({ connectionString: db.url });
    await pg.connect();

    customerOrgId = await seedOrg('customer', 'Kovai Pumps');
    const internalOrg = await seedOrg('internal', 'JobWork Operations');
    supplierOrgA = await seedOrg('supplier', 'Anand Engineering');
    supplierOrgB = await seedOrg('supplier', 'Balaji Precision');
    for (const orgId of [supplierOrgA, supplierOrgB]) {
      await pg.query(`INSERT INTO supplier.supplier_profile (organization_id, status, decided_by, decided_at, submitted_by) VALUES ($1, 'active', gen_random_uuid(), now(), gen_random_uuid())`, [orgId]);
    }
    await seedUser(customerOrgId, 'buyer@kovai.test', ['customer_requester']);
    await seedUser(customerOrgId, 'approver@kovai.test', ['customer_approver']);
    sourcingUserId = await seedUser(internalOrg, 'sourcing@jobwork.test', ['jobwork_sourcing']);
    await seedUser(internalOrg, 'support@jobwork.test', ['jobwork_support']);
    await seedUser(internalOrg, 'sales@jobwork.test', ['jobwork_sales']);
    await seedUser(internalOrg, 'quality@jobwork.test', ['jobwork_quality']);
    await seedUser(supplierOrgA, 'estimator@anand.test', ['supplier_estimator']);
    await seedUser(supplierOrgB, 'estimator@balaji.test', ['supplier_estimator']);

    enquiryId = (await one<{ id: string }>(
      `INSERT INTO sourcing.enquiry (customer_organization_id, title, status, reference, submitted_at, submitted_by) VALUES ($1, 'Pump bracket', 'under_review', 'ENQ-2026-8001', now(), gen_random_uuid()) RETURNING id`,
      [customerOrgId],
    )).id;
    const req = await one<{ id: string }>(`INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash) VALUES ($1, 1, 'reviewed', '{}'::jsonb, 'r') RETURNING id`, [enquiryId]);
    rfqId = (await one<{ id: string }>(
      `INSERT INTO sourcing.rfq (enquiry_id, requirement_id, round_no, reference, status, currency, deadline_at, released_at) VALUES ($1, $2, 1, 'RFQ-2026-8001-R1', 'open', 'INR', '2026-10-20T12:30:00Z', now()) RETURNING id`,
      [enquiryId, req.id],
    )).id;
    for (const orgId of [supplierOrgA, supplierOrgB]) {
      const profile = await one<{ id: string }>(`SELECT id FROM supplier.supplier_profile WHERE organization_id = $1`, [orgId]);
      await pg.query(`INSERT INTO sourcing.rfq_supplier (rfq_id, supplier_profile_id, supplier_organization_id, status, invited_at) VALUES ($1, $2, $3, 'invited', now())`, [rfqId, profile.id, orgId]);
    }

    ({ app, baseUrl } = await createTestApp());
    buyer = await signIn('buyer@kovai.test');
    approver = await signIn('approver@kovai.test');
    sourcing = await signIn('sourcing@jobwork.test', true);
    supplierA = await signIn('estimator@anand.test');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('ships an in-app and an email version of every template a rule uses', async () => {
    const rows = await pg.query<{ template_key: string; channels: string[] }>(
      `SELECT template_key, array_agg(channel ORDER BY channel) AS channels FROM communication.template_version GROUP BY template_key`,
    );
    expect(rows.rows.length).toBe(38); // 18 from F-10.3, 3 from F-11.1 (SLA due, escalated, handed over), 1 from F-12.5 (round superseded), 2 from F-13.2 (change decision, interim decision), 2 from F-14.1 (inspection planned, decided), 3 from F-15.1 (NCR opened, NCR disposition, deviation decision), 2 from F-16.1 (shipment released, receiving discrepancy), 5 from F-17.1 (address confirmation, dispatched, confirmation needed, deemed accepted, delivery exception), 2 from IN-18 (case update, settlement paid)
    for (const row of rows.rows) expect(row.channels, row.template_key).toEqual(['email', 'in_app']);
  });

  it('tells the customer a quotation is ready, by reference only, traced to its event', async () => {
    const quoteId = (await one<{ id: string }>(`SELECT gen_random_uuid() AS id`)).id;
    const eventId = await commitEvent('commercial.quote_sent.v1', 'customer_quote', quoteId, {
      quoteId, reference: 'QUO-2026-8001', versionNo: 1, customerOrganizationId: customerOrgId, validityUntil: '2026-10-31',
    }, sourcingUserId);

    const res = await dispatch(eventId);
    expect(res.status).toBe(201);
    expect(res.body['notifications']).toBe(2);
    const deliveries = res.body['deliveries'] as Body[];
    expect(deliveries.map((d) => d['destination']).sort()).toEqual(['approver@kovai.test', 'buyer@kovai.test']);
    expect(deliveries[0]).toMatchObject({ channel: 'email', attemptNo: 1, subject: 'Your quotation QUO-2026-8001 is ready' });
    expect(deliveries[0]!['text']).toContain(`https://portal.jobwork.test/quotations/${quoteId}`);
    expect(deliveries[0]!['text']).toContain('valid until 31 Oct 2026');

    const row = await one<Body>(
      `SELECT n.correlation_id, n.locale, n.consent_basis, n.link, t.template_key, t.version
         FROM communication.notification n JOIN communication.template_version t ON t.id = n.template_version_id
        WHERE n.source_event_id = $1 LIMIT 1`,
      [eventId],
    );
    expect(row).toEqual({
      correlation_id: 'corr-commercial.quote_sent.v1', locale: 'en-IN', consent_basis: 'transactional',
      link: `/quotations/${quoteId}`, template_key: 'customer.quote_sent', version: 1,
    });

    const feed = await buyer.get('/api/v1/notifications');
    expect(feed.body['unread']).toBe(1);
    expect((feed.body['notifications'] as Body[])[0]).toMatchObject({ title: 'Your quotation QUO-2026-8001 is ready', link: `/quotations/${quoteId}`, readAt: null });
  });

  it('reaches each person once however often an event is dispatched, and keeps delivery ids', async () => {
    const invoiceId = (await one<{ id: string }>(`SELECT gen_random_uuid() AS id`)).id;
    const eventId = await commitEvent('finance.invoice_issued.v1', 'invoice', invoiceId, {
      invoiceId, number: 'INV-2026-8001', orderId: invoiceId, customerOrganizationId: customerOrgId, totalMinor: 100, dueAt: '2026-11-15T00:00:00.000Z',
    });
    const first = (await dispatch(eventId)).body['deliveries'] as Body[];
    const second = (await dispatch(eventId)).body['deliveries'] as Body[];
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM communication.notification WHERE source_event_id = $1`, [eventId])).n).toBe(2);
    // The same deliveries, re-opened: same ids, next attempt number.
    expect(second.map((d) => d['deliveryId']).sort()).toEqual(first.map((d) => d['deliveryId']).sort());
    expect(second.every((d) => d['attemptNo'] === 2)).toBe(true);

    for (const d of second) {
      expect((await worker(`deliveries/${d['deliveryId']}/result`, { attemptNo: 2, status: 'sent', providerReference: `prov-${d['deliveryId']}` })).body).toEqual({ outcome: 'recorded' });
      // The provider reports twice: nothing changes.
      expect((await worker(`deliveries/${d['deliveryId']}/result`, { attemptNo: 2, status: 'sent' })).body).toEqual({ outcome: 'already_recorded' });
      // The first attempt was closed as unknown when it was reopened.
      expect((await worker(`deliveries/${d['deliveryId']}/result`, { attemptNo: 1, status: 'sent' })).body).toEqual({ outcome: 'already_recorded' });
    }
    expect((await dispatch(eventId)).body['deliveries']).toEqual([]);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM communication.delivery_attempt WHERE notification_id IN (SELECT id FROM communication.notification WHERE source_event_id = $1) AND status = 'sent'`, [eventId])).n).toBe(2);
    expect((await worker(`deliveries/00000000-0000-4000-8000-000000000000/result`, { attemptNo: 1, status: 'sent' })).status).toBe(404);
  });

  it('has nothing to send for a command that rolled back', async () => {
    await pg.query('BEGIN');
    const ghost = (await one<{ id: string }>(
      `INSERT INTO platform.outbox_event (event_type, aggregate_type, aggregate_id, correlation_id, data) VALUES ('commercial.quote_sent.v1', 'customer_quote', 'x', 'corr-ghost', '{}') RETURNING id`,
    )).id;
    await pg.query('ROLLBACK');
    const res = await dispatch(ghost);
    expect(res.status).toBe(404);
    expect(res.body['code']).toBe('OUTBOX_EVENT_NOT_FOUND');
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM communication.notification WHERE correlation_id = 'corr-ghost'`)).n).toBe(0);

    // A command refused by the API writes no event either.
    const before = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM platform.outbox_event`)).n;
    expect((await buyer.post(`/api/v1/conversations/enquiry/${enquiryId}/messages`, { audience: 'supplier', body: 'trying' })).status).toBe(403);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM platform.outbox_event`)).n).toBe(before);
  });

  it('notifies the right side of a thread, and never carries the message itself', async () => {
    const staffMessage = await sourcing.post(`/api/v1/conversations/enquiry/${enquiryId}/messages`, { audience: 'customer', body: 'The bore needs a 0.05 mm tolerance; can you confirm?' });
    const staffEvent = await eventFor(staffMessage.body['messageId'] as string);
    const toCustomer = await dispatch(staffEvent);
    expect(await recipientsOf(staffEvent)).toEqual(['approver@kovai.test', 'buyer@kovai.test']);
    const email = (toCustomer.body['deliveries'] as Body[])[0]!;
    expect(email['subject']).toBe('New message about ENQ-2026-8001');
    expect(JSON.stringify(toCustomer.body)).not.toContain('0.05 mm');
    expect(JSON.stringify((await buyer.get('/api/v1/notifications')).body)).not.toContain('0.05 mm');

    const customerMessage = await buyer.post(`/api/v1/conversations/enquiry/${enquiryId}/messages`, { audience: 'customer', body: 'Confirmed, 0.05 mm.' });
    const customerEvent = await eventFor(customerMessage.body['messageId'] as string);
    const toStaff = await dispatch(customerEvent);
    expect(await recipientsOf(customerEvent)).toEqual(['sales@jobwork.test', 'sourcing@jobwork.test']);
    expect((toStaff.body['deliveries'] as Body[])[0]!['text']).toContain(`https://ops.jobwork.test/intake/${enquiryId}`);

    // A supplier's private exchange reaches that supplier only.
    const reply = await sourcing.post(`/api/v1/conversations/rfq/${rfqId}/messages`, { audience: 'supplier', supplierOrganizationId: supplierOrgA, body: 'Drive end only.' });
    const replyEvent = await eventFor(reply.body['messageId'] as string);
    await dispatch(replyEvent);
    expect(await recipientsOf(replyEvent)).toEqual(['estimator@anand.test']);

    // A supplier asking reaches JobWork's sourcing team, not the supplier itself.
    const question = await supplierA.post(`/api/v1/conversations/rfq/${rfqId}/messages`, { audience: 'supplier', body: 'Is Ra 1.6 acceptable?' });
    const questionEvent = await eventFor(question.body['messageId'] as string);
    await dispatch(questionEvent);
    expect(await recipientsOf(questionEvent)).toEqual(['sourcing@jobwork.test']);

    // Shared with everyone: every invited supplier hears of it.
    const shared = await sourcing.post(`/api/v1/messages/${question.body['messageId']}/share`, { body: 'For all: Ra 1.6 is acceptable on non-sealing faces.' });
    const sharedEvent = await eventFor(shared.body['messageId'] as string);
    await dispatch(sharedEvent);
    expect(await recipientsOf(sharedEvent)).toEqual(['estimator@anand.test', 'estimator@balaji.test']);
  });

  it('tells reviewers about a held message, never its author', async () => {
    const held = await sourcing.post(`/api/v1/conversations/enquiry/${enquiryId}/messages`, { audience: 'customer', body: 'Anand Engineering will machine it.' });
    expect(held.body['status']).toBe('held');
    const heldEvent = await eventFor(held.body['messageId'] as string);
    const res = await dispatch(heldEvent);
    expect(await recipientsOf(heldEvent)).toEqual(['support@jobwork.test']);
    expect((res.body['deliveries'] as Body[])[0]!['text']).toContain('https://ops.jobwork.test/leakage-reviews');
    // And nobody outside JobWork hears anything.
    expect(JSON.stringify((await approver.get('/api/v1/notifications')).body)).not.toContain('held');
  });

  it('keeps each feed to its owner and tracks what was read', async () => {
    const mine = (await buyer.get('/api/v1/notifications')).body['notifications'] as Body[];
    expect(mine.length).toBeGreaterThan(0);
    const theirs = (await approver.get('/api/v1/notifications')).body['notifications'] as Body[];
    expect(mine.map((n) => n['notificationId'])).not.toEqual(expect.arrayContaining(theirs.map((n) => n['notificationId'])));

    expect((await approver.post(`/api/v1/notifications/${mine[0]!['notificationId']}/read`)).status).toBe(404);
    const unreadBefore = (await buyer.get('/api/v1/notifications/unread-count')).body['unread'] as number;
    const after = await buyer.post(`/api/v1/notifications/${mine[0]!['notificationId']}/read`);
    expect(after.status).toBe(201);
    expect(after.body['unread']).toBe(unreadBefore - 1);
    expect((await buyer.post(`/api/v1/notifications/${mine[0]!['notificationId']}/read`)).status).toBe(201);
    expect((await buyer.post('/api/v1/notifications/read-all')).body['unread']).toBe(0);
  });

  it('lets only the worker dispatch', async () => {
    const res = await sourcing.post('/api/v1/internal/notifications/dispatch', { eventId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(401);
  });

  it('sends nothing at all when a template version reaches outside its allowlist', async () => {
    // A careless v2: the body asks for a supplier's name the allowlist never granted.
    await pg.query(
      `INSERT INTO communication.template_version (template_key, version, channel, audience, subject, body, variables)
       VALUES ('customer.payment_received', 2, 'email', 'customer', 'Payment for {{invoiceNumber}}', 'Paid to {{supplierName}}. {{link}}', ARRAY['invoiceNumber', 'link'])`,
    );
    const invoiceId = (await one<{ id: string }>(`SELECT gen_random_uuid() AS id`)).id;
    const eventId = await commitEvent('finance.payment_received.v1', 'invoice', invoiceId, {
      invoiceId, number: 'INV-2026-8002', orderId: invoiceId, customerOrganizationId: customerOrgId, allocatedMinor: 100, unappliedMinor: 0, status: 'paid',
    });
    const res = await dispatch(eventId);
    expect(res.status).toBe(500);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM communication.notification WHERE source_event_id = $1`, [eventId])).n).toBe(0);
  });
});
