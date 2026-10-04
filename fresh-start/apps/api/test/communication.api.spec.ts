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
  let supplierB: TestClient;
  let otherCustomer: TestClient;
  let salesOrderId: string;
  let purchaseOrderA: string;

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
    await seedUser(await seedOrg('customer', 'Other Castings'), 'buyer@other.test', ['customer_requester'], 'Other Buyer');

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

    // An accepted order with one PO to supplier A, as F-08/F-09 leave them.
    const set = await one<{ id: string }>(`INSERT INTO commercial.quote_offer_set (enquiry_id, customer_organization_id, created_by) VALUES ($1, $2, gen_random_uuid()) RETURNING id`, [enquiryId, customerOrgId]);
    const quote = await one<{ id: string }>(`INSERT INTO commercial.customer_quote (offer_set_id, enquiry_id, customer_organization_id, status, reference, created_by) VALUES ($1, $2, $3, 'accepted', 'QUO-2026-7001', gen_random_uuid()) RETURNING id`, [set.id, enquiryId, customerOrgId]);
    const terms = await one<{ id: string }>(`SELECT id FROM commercial.terms_version LIMIT 1`);
    const qv = await one<{ id: string }>(
      `INSERT INTO commercial.quote_version (customer_quote_id, version_no, currency, subtotal_minor, tax_rate_bp, tax_minor, total_minor, delivery_lead_days, validity_until, terms_version_id, content_hash, status, created_by)
       VALUES ($1, 1, 'INR', 100, 0, 0, 100, 7, current_date + 7, $2, 'h', 'accepted', gen_random_uuid()) RETURNING id`,
      [quote.id, terms.id],
    );
    const acceptance = await one<{ id: string }>(
      `INSERT INTO commercial.acceptance (customer_quote_id, quote_version_id, content_hash, terms_version_id, terms_hash, accepted_by, organization_id, authority_snapshot)
       VALUES ($1, $2, 'h', $3, 't', gen_random_uuid(), $4, '{}'::jsonb) RETURNING id`,
      [quote.id, qv.id, terms.id, customerOrgId],
    );
    const snapshot = await one<{ id: string }>(`INSERT INTO commercial.contract_snapshot (acceptance_id, snapshot, content_hash) VALUES ($1, '{}'::jsonb, 'c') RETURNING id`, [acceptance.id]);
    salesOrderId = (await one<{ id: string }>(
      `INSERT INTO orders.sales_order (number, customer_organization_id, enquiry_id, customer_quote_id, accepted_quote_version_id, acceptance_id, contract_snapshot_id, title, currency, total_minor, delivery_lead_days)
       VALUES ('SO-2026-7001', $1, $2, $3, $4, $5, $6, 'Pump bracket', 'INR', 100, 7) RETURNING id`,
      [customerOrgId, enquiryId, quote.id, qv.id, acceptance.id, snapshot.id],
    )).id;
    const award = await one<{ id: string }>(`INSERT INTO commercial.award (rfq_id, status, proposed_by, currency, buy_total_minor) VALUES ($1, 'approved', gen_random_uuid(), 'INR', 90) RETURNING id`, [rfqId]);
    const profileA = await one<{ id: string }>(`SELECT id FROM supplier.supplier_profile WHERE organization_id = $1`, [supplierOrgA]);
    purchaseOrderA = (await one<{ id: string }>(
      `INSERT INTO orders.purchase_order (number, sales_order_id, award_id, supplier_organization_id, supplier_profile_id, currency, total_minor, lead_time_days, content_hash, issued_by)
       VALUES ('PO-2026-7001', $1, $2, $3, $4, 'INR', 90, 7, 'p', gen_random_uuid()) RETURNING id`,
      [salesOrderId, award.id, supplierOrgA, profileA.id],
    )).id;

    ({ app, baseUrl } = await createTestApp());
    customer = await signIn('buyer@kovai.test');
    sourcing = await signIn('sourcing@jobwork.test', true);
    support = await signIn('support@jobwork.test', true);
    sales = await signIn('sales@jobwork.test', true);
    supplierA = await signIn('estimator@anand.test');
    supplierB = await signIn('estimator@balaji.test');
    otherCustomer = await signIn('buyer@other.test');
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

  // ---------------------------------------------------------------- F-10.2 threads

  describe('threads with explicit audience (F-10.2)', () => {
    const enquiryThread = () => `/api/v1/conversations/enquiry/${enquiryId}`;
    const rfqThread = () => `/api/v1/conversations/rfq/${rfqId}`;
    const bodies = (res: { body: Body }) => (res.body['messages'] as Body[]).map((m) => m['body']);

    it('keeps an internal note out of every external listing, by query', async () => {
      const note = await sourcing.post(`${enquiryThread()}/messages`, { audience: 'internal', body: 'Margin is thin on this one; push for volume.' });
      expect(note.status).toBe(201);
      expect(note.body).toMatchObject({ status: 'visible', action: 'allow' });
      const reply = await sourcing.post(`${enquiryThread()}/messages`, { audience: 'customer', body: 'Could you confirm the anodising colour?' });
      expect(reply.body).toMatchObject({ status: 'visible', action: 'allow' });

      const customerView = await customer.get(enquiryThread());
      expect(customerView.status).toBe(200);
      expect(customerView.body['viewer']).toBe('external');
      expect(bodies(customerView)).toContain('Could you confirm the anodising colour?');
      expect(JSON.stringify(customerView.body)).not.toContain('Margin is thin');
      // Staff appear as JobWork; nobody's name crosses.
      expect((customerView.body['messages'] as Body[]).find((m) => m['body'] === 'Could you confirm the anodising colour?')).toMatchObject({ authorLabel: 'JobWork', mine: false });
      expect(customerView.body['canPost']).toEqual([{ audience: 'customer', label: 'JobWork' }]);

      const internalView = await sales.get(enquiryThread());
      expect(internalView.body['viewer']).toBe('internal');
      expect(bodies(internalView)).toEqual(expect.arrayContaining(['Margin is thin on this one; push for volume.', 'Could you confirm the anodising colour?']));

      // An internal note produces no outbox event; the customer message does.
      expect((await pg.query(`SELECT 1 FROM platform.outbox_event WHERE aggregate_id = $1`, [note.body['messageId']])).rowCount).toBe(0);
      expect(await one(`SELECT event_type FROM platform.outbox_event WHERE aggregate_id = $1`, [reply.body['messageId']])).toMatchObject({ event_type: 'communication.message_posted.v1' });
    });

    it('lets a customer write only to JobWork, and only on its own records', async () => {
      const ok = await customer.post(`${enquiryThread()}/messages`, { audience: 'customer', body: 'Colour is natural, clear anodised.' });
      expect(ok.status).toBe(201);
      for (const audience of ['internal', 'supplier', 'shared_technical']) {
        const refused = await customer.post(`${enquiryThread()}/messages`, { audience, body: 'trying another audience' });
        expect(refused.status, audience).toBe(403);
        expect(refused.body['code']).toBe('AUDIENCE_NOT_ALLOWED');
      }
      // Another customer, a supplier, and a guessed id all get the same not-found.
      expect((await otherCustomer.get(enquiryThread())).status).toBe(404);
      expect((await supplierA.get(enquiryThread())).status).toBe(404);
      expect((await customer.get(`/api/v1/conversations/enquiry/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
      expect((await customer.get(`/api/v1/conversations/invoice/${enquiryId}`)).status).toBe(404);
      expect((await customer.get(rfqThread())).status).toBe(404);
    });

    it('keeps each supplier’s exchange with JobWork private to that supplier', async () => {
      const question = await supplierA.post(`${rfqThread()}/messages`, { audience: 'supplier', body: 'Is the 0.05 mm bore tolerance on both ends?' });
      expect(question.body).toMatchObject({ status: 'visible' });
      const answer = await sourcing.post(`${rfqThread()}/messages`, { audience: 'supplier', supplierOrganizationId: supplierOrgA, body: 'Only on the drive end.' });
      expect(answer.body).toMatchObject({ status: 'visible' });
      await sourcing.post(`${rfqThread()}/messages`, { audience: 'internal', body: 'Supplier A is usually late on tolerancing questions.' });

      const a = await supplierA.get(rfqThread());
      expect(bodies(a)).toEqual(expect.arrayContaining(['Is the 0.05 mm bore tolerance on both ends?', 'Only on the drive end.']));
      expect((a.body['messages'] as Body[]).find((m) => m['body'] === 'Is the 0.05 mm bore tolerance on both ends?')).toMatchObject({ mine: true, authorLabel: 'Kumar' });
      const b = await supplierB.get(rfqThread());
      expect(b.status).toBe(200);
      expect(JSON.stringify(b.body)).not.toContain('bore tolerance');
      expect(JSON.stringify(b.body)).not.toContain('drive end');
      expect(JSON.stringify(a.body) + JSON.stringify(b.body)).not.toContain('usually late');
      // JobWork must say which supplier it is writing to on an RFQ.
      const unaddressed = await sourcing.post(`${rfqThread()}/messages`, { audience: 'supplier', body: 'To whom?' });
      expect(unaddressed.status).toBe(403);
      // A supplier cannot address another supplier.
      const sideways = await supplierA.post(`${rfqThread()}/messages`, { audience: 'supplier', supplierOrganizationId: supplierOrgB, body: 'Hello Balaji' });
      expect(sideways.status).toBe(201);
      expect((await one<{ counterpart_organization_id: string }>(`SELECT counterpart_organization_id FROM communication.message WHERE id = $1`, [sideways.body['messageId']])).counterpart_organization_id).toBe(supplierOrgA);
    });

    it('publishes a supplier question to every invited supplier without naming the asker', async () => {
      const question = await supplierA.post(`${rfqThread()}/messages`, { audience: 'supplier', body: 'Can the surface finish be Ra 1.6 instead of 0.8?' });
      const internalView = await sourcing.get(rfqThread());
      const source = (internalView.body['messages'] as Body[]).find((m) => m['messageId'] === question.body['messageId'])!;
      expect(source).toMatchObject({ shareable: true, authorParty: 'supplier', counterpartName: 'Anand Engineering Pvt Ltd' });

      // Naming the asker in the shared text is held, not published.
      const careless = await sourcing.post(`/api/v1/messages/${question.body['messageId']}/share`, { body: 'Anand Engineering asked whether Ra 1.6 is acceptable. It is.' });
      expect(careless.body).toMatchObject({ status: 'held', action: 'quarantine' });
      expect(JSON.stringify((await supplierB.get(rfqThread())).body)).not.toContain('Anand');

      const shared = await sourcing.post(`/api/v1/messages/${question.body['messageId']}/share`, { body: 'Clarification for all: Ra 1.6 is acceptable on non-sealing faces.' });
      expect(shared.body).toMatchObject({ status: 'visible', action: 'allow' });
      const b = await supplierB.get(rfqThread());
      const published = (b.body['messages'] as Body[]).find((m) => m['messageId'] === shared.body['messageId'])!;
      expect(published).toMatchObject({ audience: 'shared_technical', authorLabel: 'JobWork', body: 'Clarification for all: Ra 1.6 is acceptable on non-sealing faces.' });
      expect(JSON.stringify(b.body)).not.toContain('instead of 0.8');
      expect(JSON.stringify(published)).not.toContain(question.body['messageId'] as string);

      // Only a supplier's visible RFQ question can be shared.
      const note = await sourcing.post(`${enquiryThread()}/messages`, { audience: 'customer', body: 'Thanks for the colour.' });
      expect((await sourcing.post(`/api/v1/messages/${note.body['messageId']}/share`, { body: 'x' })).status).toBe(409);
      expect((await supplierA.post(`/api/v1/messages/${question.body['messageId']}/share`, { body: 'x' })).status).toBe(404);
    });

    it('holds a JobWork message that names a supplier until a reviewer releases it', async () => {
      const held = await sourcing.post(`${enquiryThread()}/messages`, { audience: 'customer', body: 'Anand Engineering can start machining on Monday.' });
      expect(held.body).toMatchObject({ status: 'held', action: 'quarantine' });
      expect((held.body['findings'] as Body[])[0]).toMatchObject({ kind: 'party_identity' });
      // (An earlier review released a message that names the supplier on purpose; this one must not appear.)
      expect(bodies(await customer.get(enquiryThread()))).not.toContain('Anand Engineering can start machining on Monday.');
      expect(await one(`SELECT event_type FROM platform.outbox_event WHERE aggregate_id = $1`, [held.body['messageId']])).toMatchObject({ event_type: 'communication.message_held.v1' });

      // The author sees it waiting in JobWork's view.
      const mine = (await sourcing.get(enquiryThread())).body['messages'] as Body[];
      const review = (mine.find((m) => m['messageId'] === held.body['messageId'])!['review']) as Body;
      expect(review).toMatchObject({ status: 'open', action: 'quarantine' });

      const detail = await support.get(`/api/v1/leakage-reviews/${review['reviewId']}`);
      await support.post(`/api/v1/leakage-reviews/${review['reviewId']}/decide`, {
        decision: 'release_redacted', reason: 'Supplier name removed.', redactedBody: 'Machining can start on Monday.', expectedVersion: detail.body['aggregateVersion'],
      });
      const customerView = await customer.get(enquiryThread());
      expect(bodies(customerView)).toContain('Machining can start on Monday.');
      expect(bodies(customerView)).not.toContain('Anand Engineering can start machining on Monday.');
    });

    it('lets a customer send contact details to JobWork with a warning, never a hold', async () => {
      const check = await customer.post(`${enquiryThread()}/messages/check`, { audience: 'customer', body: 'Call me on 98765 43210. Anand Engineering made the last batch.' });
      expect(check.body['action']).toBe('warn');
      // The customer is not told that a name belongs to one of JobWork's suppliers.
      expect((check.body['findings'] as Body[]).map((f) => f['kind'])).toEqual(['phone']);
      const posted = await customer.post(`${enquiryThread()}/messages`, { audience: 'customer', body: 'Call me on 98765 43210.' });
      expect(posted.body).toMatchObject({ status: 'visible', action: 'warn' });
      expect(await one(`SELECT status FROM communication.leakage_review WHERE message_id = $1`, [posted.body['messageId']])).toMatchObject({ status: 'noted' });
    });

    it('checks without storing anything, and posts once per idempotency key', async () => {
      const before = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM communication.message`)).n;
      expect((await sourcing.post(`${enquiryThread()}/messages/check`, { audience: 'customer', body: 'Call Anand Engineering on 90000 11111' })).body['action']).toBe('quarantine');
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM communication.message`)).n).toBe(before);

      const key = 'post-once-key';
      const send = () => fetch(`${baseUrl}${enquiryThread()}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, cookie: `jw_session=${customer.cookie('jw_session')}; jw_csrf=${customer.cookie('jw_csrf')}`, 'x-csrf-token': customer.cookie('jw_csrf')! },
        body: JSON.stringify({ audience: 'customer', body: 'Sent once, however often I click.' }),
      });
      const [first, second] = [await send(), await send()];
      expect([first.status, second.status]).toEqual([201, 201]);
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM communication.message WHERE body = 'Sent once, however often I click.'`)).n).toBe(1);
    });

    it('binds order and purchase-order threads to their own parties', async () => {
      const soThread = `/api/v1/conversations/sales_order/${salesOrderId}`;
      const poThread = `/api/v1/conversations/purchase_order/${purchaseOrderA}`;
      expect((await customer.get(soThread)).status).toBe(200);
      expect((await otherCustomer.get(soThread)).status).toBe(404);
      expect((await supplierA.get(soThread)).status).toBe(404);
      expect((await supplierA.get(poThread)).status).toBe(200);
      expect((await supplierB.get(poThread)).status).toBe(404);
      expect((await customer.get(poThread)).status).toBe(404);

      const toSupplier = await sourcing.post(`${poThread}/messages`, { audience: 'supplier', body: 'Please send the first-article report with the batch.' });
      expect(toSupplier.body).toMatchObject({ status: 'visible' });
      expect(bodies(await supplierA.get(poThread))).toContain('Please send the first-article report with the batch.');
      // The customer's order thread never shows the supplier exchange.
      expect(JSON.stringify((await customer.get(soThread)).body)).not.toContain('first-article');
      // JobWork naming the customer to the supplier is held.
      const leak = await sourcing.post(`${poThread}/messages`, { audience: 'supplier', body: 'Kovai Pumps needs these by Friday.' });
      expect(leak.body).toMatchObject({ status: 'held' });
    });
  });
});
