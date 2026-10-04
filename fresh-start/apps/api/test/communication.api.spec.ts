import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { scanText } from '../src/modules/communication/domain/leakage';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'communication-password-1';
type Body = Record<string, unknown>;

/**
 * IN-10 communication end to end: held-message review (F-10.4) and audience-bound
 * threads (F-10.2). The doc 03 §7 negative this suite exists for: internal content never
 * reaches an external reader, and a party's identity never crosses to the other side
 * without a person deciding it may.
 */
describe('Communication (IN-10)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let customerOrgId: string;
  let internalOrgId: string;
  let supplierOrgA: string;
  let supplierOrgB: string;
  let enquiryId: string;
  let rfqId: string;
  let sourcingUserId: string;

  let customer: TestClient;
  let sourcing: TestClient;
  let support: TestClient;
  let sales: TestClient;
  let supplierA: TestClient;

  const one = async <T = Body>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;

  function totp(secret: string, email: string): string {
    return new OTPAuth.TOTP({ issuer: 'JobWork', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  }

  async function seedOrg(type: string, name: string): Promise<string> {
    return (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ($1, $2, $2) RETURNING id`, [type, name])).id;
  }

  async function seedUser(orgId: string, email: string, roles: string[], displayName = email.split('@')[0]!): Promise<string> {
    const user = await one<{ id: string }>(
      `INSERT INTO iam.user_account (email, password_hash, password_params_version, display_name, status, email_verified_at) VALUES ($1, $2, 1, $3, 'active', now()) RETURNING id`,
      [email, await hashPassword(PASSWORD), displayName],
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

  /** A message the gate held, as F-10.2 will create it, with the detector's real findings. */
  async function seedHeld(body: string, audience = 'customer'): Promise<{ messageId: string; reviewId: string }> {
    const conversation = await one<{ id: string }>(
      `INSERT INTO communication.conversation (context_type, context_id) VALUES ('enquiry', $1)
       ON CONFLICT (context_type, context_id) DO UPDATE SET context_id = EXCLUDED.context_id RETURNING id`,
      [enquiryId],
    );
    const message = await one<{ id: string }>(
      `INSERT INTO communication.message (conversation_id, audience, author_user_id, author_organization_id, author_party, body, body_sha256, status)
       VALUES ($1, $2, $3, $4, 'internal', $5, 'h', 'held') RETURNING id`,
      [conversation.id, audience, sourcingUserId, internalOrgId, body],
    );
    const findings = scanText(body, { shielded: [{ party: 'supplier', kind: 'name', value: 'Anand Engineering Pvt Ltd' }], allowed: [] });
    const review = await one<{ id: string }>(
      `INSERT INTO communication.leakage_review (message_id, action, findings, detector_version, status) VALUES ($1, 'quarantine', $2, 'leakage-v1', 'open') RETURNING id`,
      [message.id, JSON.stringify(findings)],
    );
    return { messageId: message.id, reviewId: review.id };
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_communication');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['NODE_ENV'] = 'test';
    pg = new Client({ connectionString: db.url });
    await pg.connect();

    customerOrgId = await seedOrg('customer', 'Kovai Pumps');
    internalOrgId = await seedOrg('internal', 'JobWork Operations');
    supplierOrgA = await seedOrg('supplier', 'Anand Engineering Pvt Ltd');
    supplierOrgB = await seedOrg('supplier', 'Balaji Precision Works');
    for (const [orgId, phone, site] of [[supplierOrgA, '+91 90000 11111', 'https://anandengg.com'], [supplierOrgB, '+91 90000 22222', '']] as const) {
      await pg.query(
        `INSERT INTO supplier.supplier_profile (organization_id, region_class, status, decided_by, decided_at, submitted_by, trade_name, website, primary_contact_name, primary_contact_email, primary_contact_phone, summary)
         VALUES ($1, 'chennai_metro', 'active', gen_random_uuid(), now(), gen_random_uuid(), '', $2, 'Works Contact', 'contact@supplier.test', $3, 'Machining')`,
        [orgId, site, phone],
      );
    }
    await seedUser(customerOrgId, 'buyer@kovai.test', ['customer_requester'], 'Priya');
    sourcingUserId = await seedUser(internalOrgId, 'sourcing@jobwork.test', ['jobwork_sourcing'], 'Ravi Sourcing');
    await seedUser(internalOrgId, 'support@jobwork.test', ['jobwork_support'], 'Meena Support');
    await seedUser(internalOrgId, 'sales@jobwork.test', ['jobwork_sales'], 'Arun Sales');
    await seedUser(supplierOrgA, 'estimator@anand.test', ['supplier_estimator'], 'Kumar');
    await seedUser(supplierOrgB, 'estimator@balaji.test', ['supplier_estimator'], 'Selvi');

    enquiryId = (await one<{ id: string }>(
      `INSERT INTO sourcing.enquiry (customer_organization_id, title, status, reference, submitted_at, submitted_by) VALUES ($1, 'Pump bracket', 'under_review', 'ENQ-2026-7001', now(), gen_random_uuid()) RETURNING id`,
      [customerOrgId],
    )).id;
    const req = await one<{ id: string }>(`INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash) VALUES ($1, 1, 'reviewed', '{}'::jsonb, 'r') RETURNING id`, [enquiryId]);
    rfqId = (await one<{ id: string }>(
      `INSERT INTO sourcing.rfq (enquiry_id, requirement_id, round_no, reference, status, currency, deadline_at, released_at) VALUES ($1, $2, 1, 'RFQ-2026-7001-R1', 'open', 'INR', now() + interval '5 days', now()) RETURNING id`,
      [enquiryId, req.id],
    )).id;
    for (const orgId of [supplierOrgA, supplierOrgB]) {
      const profile = await one<{ id: string }>(`SELECT id FROM supplier.supplier_profile WHERE organization_id = $1`, [orgId]);
      await pg.query(`INSERT INTO sourcing.rfq_supplier (rfq_id, supplier_profile_id, supplier_organization_id, status, invited_at) VALUES ($1, $2, $3, 'invited', now())`, [rfqId, profile.id, orgId]);
    }

    ({ app, baseUrl } = await createTestApp());
    customer = await signIn('buyer@kovai.test');
    sourcing = await signIn('sourcing@jobwork.test', true);
    support = await signIn('support@jobwork.test', true);
    sales = await signIn('sales@jobwork.test', true);
    supplierA = await signIn('estimator@anand.test');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  // ---------------------------------------------------------------- F-10.4 review

  describe('held-message review (F-10.4)', () => {
    it('shows the queue to reviewers only, with the evidence and a suggested redaction', async () => {
      const { reviewId } = await seedHeld('The bracket was machined by Anand Engineering last month.');
      expect((await sales.get('/api/v1/leakage-reviews')).status).toBe(403);
      expect((await customer.get('/api/v1/leakage-reviews')).status).toBe(403);
      expect((await supplierA.get(`/api/v1/leakage-reviews/${reviewId}`)).status).toBe(403);

      const queue = await support.get('/api/v1/leakage-reviews');
      expect(queue.status).toBe(200);
      const item = (queue.body['reviews'] as Body[]).find((r) => r['reviewId'] === reviewId)!;
      expect(item).toMatchObject({ status: 'open', audience: 'customer', readerLabel: 'Kovai Pumps (customer)', authorName: 'Ravi Sourcing', findingCount: 1 });
      expect(item['context']).toMatchObject({ type: 'enquiry', id: enquiryId, label: 'ENQ-2026-7001' });

      const detail = await support.get(`/api/v1/leakage-reviews/${reviewId}`);
      expect(detail.body).toMatchObject({ canDecide: true, suggestedRedaction: 'The bracket was machined by [removed] last month.' });
      expect((detail.body['findings'] as Body[])[0]).toMatchObject({ kind: 'party_identity', text: 'Anand Engineering' });

      // The operations summary counts it for reviewers.
      const summary = await support.get('/api/v1/operations/summary');
      expect((summary.body['queues'] as Body[]).find((q) => q['key'] === 'leakage_reviews_open')).toMatchObject({ href: '/leakage-reviews' });
    });

    it('never lets the author review their own message', async () => {
      const { reviewId } = await seedHeld('Anand Engineering confirmed the date.');
      const detail = await sourcing.get(`/api/v1/leakage-reviews/${reviewId}`);
      expect(detail.body).toMatchObject({ canDecide: false, cannotDecideReason: 'You wrote this message; another reviewer must decide.' });
      const attempt = await sourcing.post(`/api/v1/leakage-reviews/${reviewId}/decide`, { decision: 'release', reason: 'Looks fine to me', expectedVersion: detail.body['aggregateVersion'] });
      expect(attempt.status).toBe(403);
      expect(attempt.body['code']).toBe('SELF_REVIEW');
    });

    it('releases a message as written, audited, with an outbox event for the readers', async () => {
      const { reviewId, messageId } = await seedHeld('Anand Engineering is the name on the old drawing title block, which you supplied.');
      const detail = await support.get(`/api/v1/leakage-reviews/${reviewId}`);
      const released = await support.post(`/api/v1/leakage-reviews/${reviewId}/decide`, {
        decision: 'release', reason: 'The customer supplied this name on their own drawing.', expectedVersion: detail.body['aggregateVersion'],
      });
      expect(released.status).toBe(201);
      expect(released.body).toMatchObject({ status: 'released', decidedByName: 'Meena Support', canDecide: false });
      expect((await one<{ status: string }>(`SELECT status FROM communication.message WHERE id = $1`, [messageId])).status).toBe('visible');
      const audit = await one<{ reason: string; data: Body }>(`SELECT reason, data FROM platform.audit_event WHERE action = 'communication.leakage_review.decided' AND subject_id = $1`, [reviewId]);
      expect(audit).toMatchObject({ reason: 'The customer supplied this name on their own drawing.', data: { decision: 'release', messageId } });
      expect(await one(`SELECT event_type FROM platform.outbox_event WHERE aggregate_id = $1`, [messageId])).toMatchObject({ event_type: 'communication.message_released.v1' });

      // Decided is decided.
      const again = await support.post(`/api/v1/leakage-reviews/${reviewId}/decide`, { decision: 'reject', reason: 'Changed my mind', expectedVersion: (released.body['aggregateVersion'] as number) });
      expect(again.status).toBe(409);
      expect(again.body['code']).toBe('REVIEW_ALREADY_DECIDED');
    });

    it('releases a redacted copy with lineage and keeps the original untouched', async () => {
      const body = 'Anand Engineering will deliver the castings on Friday.';
      const { reviewId, messageId } = await seedHeld(body);
      const detail = await support.get(`/api/v1/leakage-reviews/${reviewId}`);
      const version = detail.body['aggregateVersion'];

      // A rewrite that still names the supplier is refused.
      const leaky = await support.post(`/api/v1/leakage-reviews/${reviewId}/decide`, {
        decision: 'release_redacted', reason: 'Removed the name', redactedBody: 'Anand-Engineering will deliver on Friday.', expectedVersion: version,
      });
      expect(leaky.status).toBe(422);
      expect(leaky.body['code']).toBe('REDACTION_STILL_FLAGGED');

      const redacted = await support.post(`/api/v1/leakage-reviews/${reviewId}/decide`, {
        decision: 'release_redacted', reason: 'Removed the supplier name.', redactedBody: 'The castings will be delivered on Friday.', expectedVersion: version,
      });
      expect(redacted.status).toBe(201);
      const derivedId = redacted.body['derivedMessageId'] as string;
      const original = await one<{ status: string; body: string }>(`SELECT status, body FROM communication.message WHERE id = $1`, [messageId]);
      expect(original).toEqual({ status: 'superseded', body });
      const derived = await one<Body>(`SELECT status, body, derived_from_message_id, derivation, author_party FROM communication.message WHERE id = $1`, [derivedId]);
      expect(derived).toEqual({ status: 'visible', body: 'The castings will be delivered on Friday.', derived_from_message_id: messageId, derivation: 'redacted', author_party: 'internal' });
    });

    it('rejects a message, which then never becomes visible', async () => {
      const { reviewId, messageId } = await seedHeld('Call Anand Engineering directly on their number.');
      const detail = await support.get(`/api/v1/leakage-reviews/${reviewId}`);
      const stale = await support.post(`/api/v1/leakage-reviews/${reviewId}/decide`, { decision: 'reject', reason: 'Would disintermediate the order.', expectedVersion: 99 });
      expect(stale.status).toBe(409);
      expect(stale.body['code']).toBe('VERSION_CONFLICT');
      const rejected = await support.post(`/api/v1/leakage-reviews/${reviewId}/decide`, { decision: 'reject', reason: 'Would disintermediate the order.', expectedVersion: detail.body['aggregateVersion'] });
      expect(rejected.status).toBe(201);
      expect((await one<{ status: string }>(`SELECT status FROM communication.message WHERE id = $1`, [messageId])).status).toBe('rejected');
      const decided = await support.get('/api/v1/leakage-reviews?status=decided');
      expect((decided.body['reviews'] as Body[]).some((r) => r['reviewId'] === reviewId && r['status'] === 'rejected')).toBe(true);
    });
  });
});
