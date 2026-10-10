import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';
import { stageSupplierCopy } from './helpers/supplier-copy';

const PASSWORD = 'revision-password-1';
type Body = Record<string, unknown>;

/**
 * F-12.5 (doc 19 §10 scenario 5): engineering revises a requirement after two suppliers
 * have bid on it. The round they bid on is superseded and they are told; their bids are
 * kept byte for byte and can never be awarded; a new round quotes the revised part and
 * can be.
 */
describe('Requirement revision after bids (F-12.5)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;
  let sourcing: TestClient;
  let engineering: TestClient;
  let customer: TestClient;
  let supplierA: TestClient;
  let supplierB: TestClient;
  let customerOrgId: string;
  let profileA: string;
  let profileB: string;
  let orgA: string;
  let orgB: string;
  let enquiryId: string;
  let enquiryItemId: string;
  let millingId: string;
  let aluminiumId: string;
  let round1: { rfqId: string; itemId: string };
  let round1Bids: Array<{ id: string; content_hash: string; total_amount_minor: string; status: string }>;

  const one = async <T = Body>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;
  const totp = (secret: string, email: string): string =>
    new OTPAuth.TOTP({ issuer: 'JobWork', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();

  async function seedOrg(type: string, name: string): Promise<string> {
    return (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ($1, $2, $2) RETURNING id`, [type, name])).id;
  }

  async function seedUser(orgId: string, email: string, roles: string[]): Promise<void> {
    const user = await one<{ id: string }>(
      `INSERT INTO iam.user_account (email, password_hash, password_params_version, display_name, status, email_verified_at) VALUES ($1, $2, 1, 'Member', 'active', now()) RETURNING id`,
      [email, await hashPassword(PASSWORD)],
    );
    const m = await one<{ id: string }>(`INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`, [user.id, orgId]);
    await pg.query(`INSERT INTO iam.membership_role (membership_id, role_id) SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`, [m.id, roles]);
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

  async function seedEligibleSupplier(name: string, email: string): Promise<{ orgId: string; profileId: string }> {
    const orgId = await seedOrg('supplier', name);
    await seedUser(orgId, email, ['org_admin', 'supplier_estimator']);
    const profileId = (await one<{ id: string }>(
      `INSERT INTO supplier.supplier_profile (organization_id, region_class, status, decided_by, decided_at, submitted_by, trade_name, primary_contact_name, primary_contact_email, primary_contact_phone, summary)
       VALUES ($1, 'chennai_metro', 'active', gen_random_uuid(), now(), gen_random_uuid(), $2, 'Contact', 'contact@example.test', '+91 90000 00000', 'We machine things') RETURNING id`,
      [orgId, name],
    )).id;
    for (const capabilityId of [millingId, aluminiumId]) {
      await pg.query(`INSERT INTO supplier.supplier_capability (supplier_profile_id, capability_id, version_no) VALUES ($1, $2, 1)`, [profileId, capabilityId]);
    }
    for (const kind of ['gst', 'pan', 'bank_account']) {
      await pg.query(
        `INSERT INTO supplier.verification_item (supplier_profile_id, kind, version_no, status, submitted_by, submitted_at, reviewed_by, reviewed_at, expires_at)
         VALUES ($1, $2, 1, 'verified', gen_random_uuid(), now(), gen_random_uuid(), now(), now() + interval '200 days')`,
        [profileId, kind],
      );
    }
    return { orgId, profileId };
  }

  async function seedApprovedEnquiry(): Promise<{ enquiryId: string; itemId: string }> {
    const id = (await one<{ id: string }>(
      `INSERT INTO sourcing.enquiry (customer_organization_id, title, application_note, status, reference, submitted_at, submitted_by, required_by_date)
       VALUES ($1, 'Pump bracket', 'Motor mount', 'approved_for_sourcing', 'ENQ-2026-7101', now(), gen_random_uuid(), current_date + 60) RETURNING id`,
      [customerOrgId],
    )).id;
    const item = await one<{ id: string }>(
      `INSERT INTO sourcing.enquiry_item (enquiry_id, line_no, part_name, description, process_capability_id, material_capability_id, material_grade, quantity_breakpoints, tolerance_class, inspection_level)
       VALUES ($1, 1, 'Bracket', 'Machined bracket', $2, $3, '6061-T6', '[{"quantity":100,"unit":"piece","kind":"production"}]'::jsonb, 'IT8', 'standard') RETURNING id`,
      [id, millingId, aluminiumId],
    );
    const doc = await one<{ id: string }>(`INSERT INTO dms.document (owning_organization_id, logical_type, title) VALUES ($1, 'drawing_2d', 'Bracket drawing') RETURNING id`, [customerOrgId]);
    const file = await one<{ id: string }>(
      `INSERT INTO dms.file_object (storage_key, byte_size, declared_media_type, sha256, scan_state, owning_organization_id) VALUES ($1, 2048, 'application/pdf', $2, 'clean', $3) RETURNING id`,
      [`clean/${randomBytes(8).toString('hex')}`, randomBytes(32).toString('hex'), customerOrgId],
    );
    const version = await one<{ id: string }>(
      `INSERT INTO dms.document_version (document_id, version_no, file_object_id, original_filename, status, created_by) VALUES ($1, 1, $2, 'bracket.pdf', 'available', gen_random_uuid()) RETURNING id`,
      [doc.id, file.id],
    );
    await pg.query(`INSERT INTO sourcing.enquiry_document (enquiry_id, document_version_id, role) VALUES ($1, $2, 'governing')`, [id, version.id]);
    // F-FP.5: a clean customer file reaches suppliers only as JobWork's confirmed copy; the stage has one.
    await stageSupplierCopy(pg, version.id);
    await pg.query(`INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash) VALUES ($1, 1, 'reviewed', '{"title":"Pump bracket"}'::jsonb, 'req-hash-1')`, [id]);
    return { enquiryId: id, itemId: item.id };
  }

  async function rfqVersion(rfqId: string): Promise<number> {
    return ((await sourcing.get(`/api/v1/rfqs/${rfqId}`)).body['rfq'] as Body)['aggregateVersion'] as number;
  }

  async function openRound(): Promise<{ rfqId: string; itemId: string }> {
    const created = await sourcing.post('/api/v1/rfqs', { enquiryId, deadlineAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), lateBidPolicy: 'reject', instructions: 'Quote per piece at 100 off.' });
    expect(created.status).toBe(201);
    const rfqId = created.body['rfqId'] as string;
    for (const supplierProfileId of [profileA, profileB]) {
      expect((await sourcing.post(`/api/v1/rfqs/${rfqId}/invitations`, { supplierProfileId })).status).toBe(201);
    }
    expect((await sourcing.post(`/api/v1/rfqs/${rfqId}/release`, { expectedVersion: await rfqVersion(rfqId) })).status).toBe(201);
    const items = await supplierA.get(`/api/v1/supplier/rfqs/${rfqId}`);
    return { rfqId, itemId: ((items.body['items'] as Body[])[0]!['rfqItemId'] as string) };
  }

  function bid(itemId: string, unitPriceMinor: number): Body {
    return {
      currency: 'INR',
      taxTreatment: 'gst_extra',
      lines: [{ rfqItemId: itemId, lineNo: 1, quantity: 100, unit: 'piece', unitPriceMinor, setupAmountMinor: 500000, note: '' }],
      nreAmountMinor: 0,
      freightAmountMinor: 250000,
      leadTimeDays: 21,
      validityUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      feasibility: 'feasible',
      assumptions: 'Material from our stock.',
      exclusions: 'Surface treatment not included.',
      paymentTerms: '30 days from invoice',
      note: '',
    };
  }

  async function enquiryVersion(): Promise<number> {
    return ((await engineering.get(`/api/v1/intake/${enquiryId}`)).body['enquiry'] as Body)['aggregateVersion'] as number;
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_revision');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['NODE_ENV'] = 'test';
    pg = new Client({ connectionString: db.url });
    await pg.connect();
    const caps = await pg.query<{ id: string; code: string }>(`SELECT id, code FROM supplier.capability WHERE code IN ('cnc_milling', 'material_aluminium')`);
    millingId = caps.rows.find((r) => r.code === 'cnc_milling')!.id;
    aluminiumId = caps.rows.find((r) => r.code === 'material_aluminium')!.id;
    customerOrgId = await seedOrg('customer', 'Kovai Pumps');
    const internal = await seedOrg('internal', 'JobWork Operations');
    await seedUser(customerOrgId, 'buyer@kovai.test', ['customer_requester']);
    await seedUser(internal, 'sourcing@jobwork.test', ['jobwork_sourcing']);
    await seedUser(internal, 'engineering@jobwork.test', ['jobwork_engineering']);
    ({ orgId: orgA, profileId: profileA } = await seedEligibleSupplier('Anand Engineering', 'estimator@anand.test'));
    ({ orgId: orgB, profileId: profileB } = await seedEligibleSupplier('Balaji Precision', 'estimator@balaji.test'));
    ({ enquiryId, itemId: enquiryItemId } = await seedApprovedEnquiry());

    ({ app, baseUrl } = await createTestApp());
    sourcing = await signIn('sourcing@jobwork.test', true);
    engineering = await signIn('engineering@jobwork.test', true);
    customer = await signIn('buyer@kovai.test');
    supplierA = await signIn('estimator@anand.test');
    supplierB = await signIn('estimator@balaji.test');

    // Round 1: supplier A bids, supplier B is still working on it.
    round1 = await openRound();
    expect((await supplierA.post(`/api/v1/supplier/rfqs/${round1.rfqId}/bid/submit`, bid(round1.itemId, 4850))).status).toBe(201);
    round1Bids = (await pg.query(`SELECT v.id, v.content_hash, v.total_amount_minor::text, v.status FROM sourcing.supplier_bid_version v JOIN sourcing.supplier_bid b ON b.id = v.supplier_bid_id WHERE b.rfq_id = $1`, [round1.rfqId])).rows;
    expect(round1Bids).toHaveLength(1);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('is engineering’s to make, under version, and must change something', async () => {
    const tighter = { expectedVersion: await enquiryVersion(), reason: 'Bore tolerance tightened after the customer’s fit test', items: [{ enquiryItemId, toleranceClass: 'IT6' }] };
    expect((await sourcing.post(`/api/v1/intake/${enquiryId}/revise`, tighter)).status).toBe(403);
    expect((await customer.post(`/api/v1/intake/${enquiryId}/revise`, tighter)).status).toBe(403);
    const stale = await engineering.post(`/api/v1/intake/${enquiryId}/revise`, { ...tighter, expectedVersion: tighter.expectedVersion + 1 });
    expect(stale.body['code']).toBe('VERSION_CONFLICT');
    const same = await engineering.post(`/api/v1/intake/${enquiryId}/revise`, { ...tighter, items: [{ enquiryItemId, toleranceClass: 'IT8' }] });
    expect(same.status).toBe(422);
    expect(same.body['code']).toBe('REVISION_UNCHANGED');
    const noReason = await engineering.post(`/api/v1/intake/${enquiryId}/revise`, { ...tighter, reason: '' });
    expect(noReason.status).toBe(400);
  });

  it('supersedes the live round, tells its suppliers, and leaves every bid exactly as submitted', async () => {
    const revised = await engineering.post(`/api/v1/intake/${enquiryId}/revise`, {
      expectedVersion: await enquiryVersion(),
      reason: 'Bore tolerance tightened after the customer’s fit test',
      items: [{ enquiryItemId, toleranceClass: 'IT6', qualityNote: 'Bore measured on CMM' }],
    });
    expect(revised.status).toBe(201);
    expect(revised.body['revision']).toMatchObject({ revisionNo: 2, kind: 'reviewed', revisionReason: 'Bore tolerance tightened after the customer’s fit test' });
    expect(revised.body['supersededRounds']).toEqual([{ rfqId: round1.rfqId, reference: expect.any(String), roundNo: 1 }]);

    expect(await one(`SELECT status, superseded_by_requirement_id IS NOT NULL AS named FROM sourcing.rfq WHERE id = $1`, [round1.rfqId])).toEqual({ status: 'superseded', named: true });
    const after = (await pg.query(`SELECT v.id, v.content_hash, v.total_amount_minor::text, v.status FROM sourcing.supplier_bid_version v JOIN sourcing.supplier_bid b ON b.id = v.supplier_bid_id WHERE b.rfq_id = $1`, [round1.rfqId])).rows;
    expect(after).toEqual(round1Bids);

    // The round takes no more bids, from anyone.
    const late = await supplierB.post(`/api/v1/supplier/rfqs/${round1.rfqId}/bid/submit`, bid(round1.itemId, 5100));
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect((await supplierA.get(`/api/v1/supplier/rfqs/${round1.rfqId}`)).body['status']).toBe('superseded');

    // Both invited suppliers are told; the enquiry and the round are audited with the reason.
    const event = await one<{ data: Body }>(`SELECT data FROM platform.outbox_event WHERE event_type = 'sourcing.rfq_superseded.v1' AND aggregate_id = $1`, [round1.rfqId]);
    expect((event.data['supplierOrganizationIds'] as string[]).sort()).toEqual([orgA, orgB].sort());
    const audits = await pg.query<{ action: string; reason: string }>(`SELECT action, reason FROM platform.audit_event WHERE action IN ('sourcing.requirement_revised', 'sourcing.rfq_superseded') ORDER BY occurred_at`);
    expect(audits.rows.map((a) => a.action)).toEqual(['sourcing.requirement_revised', 'sourcing.rfq_superseded']);
    expect(new Set(audits.rows.map((a) => a.reason))).toEqual(new Set(['Bore tolerance tightened after the customer’s fit test']));

    // The customer's view says nothing of rounds or suppliers.
    const view = JSON.stringify((await customer.get(`/api/v1/enquiries/${enquiryId}`)).body);
    expect(view).not.toMatch(/superseded|Anand|Balaji|RFQ-/);
  });

  it('quotes the revised part in a new round, which can be awarded while the old one cannot', async () => {
    const round2 = await openRound();
    const lines = await supplierA.get(`/api/v1/supplier/rfqs/${round2.rfqId}`);
    expect(JSON.stringify(lines.body['items'])).toContain('IT6');
    expect((await supplierA.post(`/api/v1/supplier/rfqs/${round2.rfqId}/bid/submit`, bid(round2.itemId, 5200))).status).toBe(201);
    const b2 = await supplierB.post(`/api/v1/supplier/rfqs/${round2.rfqId}/bid/submit`, bid(round2.itemId, 5400));
    expect(b2.status).toBe(201);
    expect((await sourcing.post(`/api/v1/rfqs/${round2.rfqId}/close`, { expectedVersion: await rfqVersion(round2.rfqId) })).body['status']).toBe('evaluation');
    const evaluation = await sourcing.post(`/api/v1/rfqs/${round2.rfqId}/evaluations`, { scenario: { inspectionPackagingMinor: 0, financingRiskBp: 0, nreAllocation: 'value' } });
    expect(evaluation.status).toBe(201);

    // The old round's bid is not awardable: the round is superseded.
    const old = await sourcing.post('/api/v1/awards', {
      rfqId: round1.rfqId,
      evaluationId: evaluation.body['evaluationId'],
      items: [{ rfqItemId: round1.itemId, targetQuantity: 100, lines: [{ bidVersionId: round1Bids[0]!.id, bidQuantity: 100, quantity: 100 }] }],
      rationale: 'Cheaper, but priced against the old tolerance',
    });
    expect(old.status).toBe(422);
    expect(old.body).toMatchObject({ code: 'AWARD_RFQ_NOT_IN_EVALUATION', detail: 'The round is superseded.' });

    const rows = evaluation.body['rows'] as Body[];
    const winner = rows.find((r) => r['rank'] === 1)!;
    const award = await sourcing.post('/api/v1/awards', {
      rfqId: round2.rfqId,
      evaluationId: evaluation.body['evaluationId'],
      items: [{ rfqItemId: round2.itemId, targetQuantity: 100, lines: [{ bidVersionId: winner['bidVersionId'], bidQuantity: 100, quantity: 100 }] }],
      rationale: 'Lowest normalized landed cost on the revised requirement',
    });
    expect(award.status).toBe(201);

    // With an award waiting for approval, the requirement cannot move underneath it.
    const blocked = await engineering.post(`/api/v1/intake/${enquiryId}/revise`, {
      expectedVersion: await enquiryVersion(),
      reason: 'Another change',
      items: [{ enquiryItemId, toleranceClass: 'IT5' }],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body['code']).toBe('REVISION_AWARD_PENDING');
  });
});
