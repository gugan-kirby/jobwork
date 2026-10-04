import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'commercial-password-1';

/**
 * IN-07 end to end (doc 19 §10 scenario 1): two bids → normalized comparison → award
 * with separation of duties → cost sheet with a margin exception → approved quotation →
 * sent → the customer sees a sell-side projection with nothing of the buy side in it →
 * a revision → a replacement → a rejection. Plus the negatives the increment owns.
 */
describe('Evaluation, award, cost sheet, customer quote (IN-07)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let sourcing: TestClient;
  let sales: TestClient;
  let finance: TestClient;
  let admin: TestClient;
  let customer: TestClient;
  let approver: TestClient;
  let supplierA: TestClient;
  let supplierB: TestClient;
  let customerOrgId: string;
  let profileA: string;
  let profileB: string;
  let enquiryId: string;
  let millingId: string;
  let aluminiumId: string;

  let rfqId: string;
  let itemId: string;
  let bidA: string;
  let bidB: string;
  let evaluationId: string;
  let awardId: string;
  let awardApprovalId: string;
  let costSheetId: string;
  let quoteId: string;

  function totpCode(secret: string, email: string): string {
    return new OTPAuth.TOTP({ issuer: 'JobWork', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  }

  async function seedOrg(type: string, name: string): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name) VALUES ($1, $2, $2) RETURNING id`,
      [type, name],
    );
    return res.rows[0]!.id;
  }

  async function seedUser(orgId: string, email: string, roles: string[]): Promise<void> {
    const user = await pg.query<{ id: string }>(
      `INSERT INTO iam.user_account (email, password_hash, password_params_version, display_name, status, email_verified_at)
       VALUES ($1, $2, 1, $3, 'active', now()) RETURNING id`,
      [email, await hashPassword(PASSWORD), email.split('@')[0]],
    );
    const membership = await pg.query<{ id: string }>(
      `INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`,
      [user.rows[0]!.id, orgId],
    );
    await pg.query(
      `INSERT INTO iam.membership_role (membership_id, role_id) SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`,
      [membership.rows[0]!.id, roles],
    );
  }

  async function signIn(email: string): Promise<TestClient> {
    const client = new TestClient(baseUrl);
    const res = await client.post('/api/v1/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(201);
    return client;
  }

  async function signInWithMfa(email: string): Promise<TestClient> {
    const first = await signIn(email);
    const enroll = await first.post('/api/v1/account/mfa/enroll');
    await first.post('/api/v1/account/mfa/activate', { code: totpCode(enroll.body['secret'] as string, email) });
    const fresh = new TestClient(baseUrl);
    await fresh.post('/api/v1/auth/login', { email, password: PASSWORD });
    const secret = await pg.query<{ mfa_totp_secret: string }>(`SELECT mfa_totp_secret FROM iam.user_account WHERE email = $1`, [email]);
    await fresh.post('/api/v1/auth/mfa', { code: totpCode(secret.rows[0]!.mfa_totp_secret, email) });
    return fresh;
  }

  async function seedDocument(orgId: string): Promise<string> {
    const doc = await pg.query<{ id: string }>(
      `INSERT INTO dms.document (owning_organization_id, logical_type, title) VALUES ($1, 'drawing_2d', 'Bracket drawing') RETURNING id`,
      [orgId],
    );
    const file = await pg.query<{ id: string }>(
      `INSERT INTO dms.file_object (storage_key, byte_size, declared_media_type, sha256, scan_state, owning_organization_id)
       VALUES ($1, 2048, 'application/pdf', $2, 'clean', $3) RETURNING id`,
      [`clean/${randomBytes(8).toString('hex')}`, randomBytes(32).toString('hex'), orgId],
    );
    const version = await pg.query<{ id: string }>(
      `INSERT INTO dms.document_version (document_id, version_no, file_object_id, original_filename, status, created_by)
       VALUES ($1, 1, $2, 'bracket.pdf', 'available', gen_random_uuid()) RETURNING id`,
      [doc.rows[0]!.id, file.rows[0]!.id],
    );
    return version.rows[0]!.id;
  }

  async function seedEligibleSupplier(name: string, email: string): Promise<{ orgId: string; profileId: string }> {
    const orgId = await seedOrg('supplier', name);
    await seedUser(orgId, email, ['org_admin', 'supplier_estimator']);
    const profile = await pg.query<{ id: string }>(
      `INSERT INTO supplier.supplier_profile
         (organization_id, region_class, status, decided_by, decided_at, submitted_by, trade_name,
          primary_contact_name, primary_contact_email, primary_contact_phone, summary)
       VALUES ($1, 'chennai_metro', 'active', gen_random_uuid(), now(), gen_random_uuid(), $2, 'Contact',
               'contact@example.test', '+91 90000 00000', 'We machine things') RETURNING id`,
      [orgId, name],
    );
    const profileId = profile.rows[0]!.id;
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

  async function seedApprovedEnquiry(): Promise<string> {
    const enquiry = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.enquiry (customer_organization_id, title, application_note, status, reference, submitted_at, submitted_by, required_by_date)
       VALUES ($1, 'Bracket support', 'Motor mount', 'approved_for_sourcing', 'ENQ-2026-7101', now(), gen_random_uuid(), current_date + 60) RETURNING id`,
      [customerOrgId],
    );
    const id = enquiry.rows[0]!.id;
    await pg.query(
      `INSERT INTO sourcing.enquiry_item (enquiry_id, line_no, part_name, description, process_capability_id, material_capability_id, material_grade, quantity_breakpoints, tolerance_class, inspection_level)
       VALUES ($1, 1, 'Bracket support', 'Machined bracket', $2, $3, '6061-T6', '[{"quantity":100,"unit":"piece","kind":"production"}]'::jsonb, 'IT8', 'standard')`,
      [id, millingId, aluminiumId],
    );
    await pg.query(`INSERT INTO sourcing.enquiry_document (enquiry_id, document_version_id, role) VALUES ($1, $2, 'governing')`, [id, await seedDocument(customerOrgId)]);
    await pg.query(`INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash) VALUES ($1, 1, 'reviewed', '{"title":"Bracket support"}'::jsonb, 'req-hash-1')`, [id]);
    return id;
  }

  function bidBody(unitPriceMinor: number, extra: Record<string, unknown> = {}) {
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
      ...extra,
    };
  }

  /** Walks the serialized payload and returns every key, so a leak is a failing assertion. */
  function keysOf(value: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        out.add(k);
        keysOf(v, out);
      }
    }
    return out;
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_commercial');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['NODE_ENV'] = 'test';

    pg = new Client({ connectionString: db.url });
    await pg.connect();
    const capabilities = await pg.query<{ id: string; code: string }>(`SELECT id, code FROM supplier.capability WHERE code IN ('cnc_milling', 'material_aluminium')`);
    millingId = capabilities.rows.find((row) => row.code === 'cnc_milling')!.id;
    aluminiumId = capabilities.rows.find((row) => row.code === 'material_aluminium')!.id;

    customerOrgId = await seedOrg('customer', 'Kovai Pumps');
    const internalOrgId = await seedOrg('internal', 'JobWork Operations');
    await seedUser(customerOrgId, 'buyer@kovai.test', ['customer_requester']);
    await seedUser(customerOrgId, 'approver@kovai.test', ['customer_approver']);
    await seedUser(internalOrgId, 'sourcing@jobwork.test', ['jobwork_sourcing']);
    await seedUser(internalOrgId, 'sales@jobwork.test', ['jobwork_sales']);
    await seedUser(internalOrgId, 'finance@jobwork.test', ['jobwork_finance']);
    await seedUser(internalOrgId, 'admin@jobwork.test', ['platform_admin']);
    ({ profileId: profileA } = await seedEligibleSupplier('Anand Engineering', 'estimator@anand.test'));
    ({ profileId: profileB } = await seedEligibleSupplier('Balaji Precision', 'estimator@balaji.test'));
    enquiryId = await seedApprovedEnquiry();

    ({ app, baseUrl } = await createTestApp());
    sourcing = await signInWithMfa('sourcing@jobwork.test');
    sales = await signInWithMfa('sales@jobwork.test');
    finance = await signInWithMfa('finance@jobwork.test');
    admin = await signInWithMfa('admin@jobwork.test');
    customer = await signIn('buyer@kovai.test');
    approver = await signIn('approver@kovai.test');
    supplierA = await signIn('estimator@anand.test');
    supplierB = await signIn('estimator@balaji.test');

    // A round with two bids, closed for evaluation (IN-06 behaviour, reused as fixture).
    const created = await sourcing.post('/api/v1/rfqs', {
      enquiryId,
      deadlineAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      lateBidPolicy: 'reject',
      instructions: 'Quote per piece at 100 off.',
    });
    rfqId = created.body['rfqId'] as string;
    for (const profileId of [profileA, profileB]) {
      await sourcing.post(`/api/v1/rfqs/${rfqId}/invitations`, { supplierProfileId: profileId });
    }
    const detail = await sourcing.get(`/api/v1/rfqs/${rfqId}`);
    await sourcing.post(`/api/v1/rfqs/${rfqId}/release`, { expectedVersion: (detail.body['rfq'] as Record<string, unknown>)['aggregateVersion'] });
    const items = await supplierA.get(`/api/v1/supplier/rfqs/${rfqId}`);
    itemId = (items.body['items'] as Array<Record<string, unknown>>)[0]!['rfqItemId'] as string;
    const a = await supplierA.post(`/api/v1/supplier/rfqs/${rfqId}/bid/submit`, bidBody(4850));
    expect(a.status).toBe(201);
    bidA = a.body['bidVersionId'] as string;
    const b = await supplierB.post(`/api/v1/supplier/rfqs/${rfqId}/bid/submit`, bidBody(5250, { nreAmountMinor: 200000, taxTreatment: 'gst_inclusive' }));
    expect(b.status).toBe(201);
    bidB = b.body['bidVersionId'] as string;
    const after = await sourcing.get(`/api/v1/rfqs/${rfqId}`);
    const closed = await sourcing.post(`/api/v1/rfqs/${rfqId}/close`, { expectedVersion: (after.body['rfq'] as Record<string, unknown>)['aggregateVersion'] });
    expect(closed.body['status']).toBe('evaluation');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  // ---------------------------------------------------------------- F-07.2

  it('normalizes both bids under one scenario without touching the originals', async () => {
    const res = await sourcing.post(`/api/v1/rfqs/${rfqId}/evaluations`, {
      scenario: { inspectionPackagingMinor: 100000, financingRiskBp: 100, nreAllocation: 'value' },
    });
    expect(res.status).toBe(201);
    evaluationId = res.body['evaluationId'] as string;
    const rows = res.body['rows'] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!['rank']).toBe(1);
    // Anand: 4850×100 + 5,00,000 setup + 2,50,000 freight = original 12,35,000; normalized adds the scenario components.
    const anand = rows.find((r) => r['supplierDisplayName'] === 'Anand Engineering')!;
    expect(anand['originalTotalMinor']).toBe(1235000);
    const components = anand['components'] as Record<string, number>;
    expect(components['itemCostMinor']).toBe(985000);
    expect(components['inspectionPackagingMinor']).toBe(100000);
    expect(components['financingRiskMinor']).toBe(9850);
    expect(anand['normalizedLandedMinor']).toBe(985000 + 250000 + 100000 + 9850);
    // Balaji quoted GST-inclusive with NRE: compared ex-tax, NRE allocated, original kept.
    const balaji = rows.find((r) => r['supplierDisplayName'] === 'Balaji Precision')!;
    expect((balaji['components'] as Record<string, number>)['itemCostExTaxMinor']).toBeLessThan((balaji['components'] as Record<string, number>)['itemCostMinor']!);
    expect((balaji['components'] as Record<string, number>)['nreMinor']).toBe(200000);
    // The bid versions themselves are untouched.
    const stored = await pg.query<{ total_amount_minor: string }>(`SELECT total_amount_minor FROM sourcing.supplier_bid_version WHERE id = $1`, [bidA]);
    expect(Number(stored.rows[0]!.total_amount_minor)).toBe(1235000);
    // Same inputs, same hash.
    const again = await sourcing.post(`/api/v1/rfqs/${rfqId}/evaluations`, { scenario: { inspectionPackagingMinor: 100000, financingRiskBp: 100, nreAllocation: 'value' } });
    expect(again.body['scenarioHash']).toBe(res.body['scenarioHash']);
    expect((again.body['rows'] as Array<Record<string, unknown>>)[0]!['normalizedLandedMinor']).toBe(rows[0]!['normalizedLandedMinor']);
  });

  // ---------------------------------------------------------------- F-07.3

  it('refuses an award that does not conserve quantity, cites a stale version, or skips a line', async () => {
    const short = await sourcing.post('/api/v1/awards', {
      rfqId,
      evaluationId,
      items: [{ rfqItemId: itemId, targetQuantity: 100, lines: [{ bidVersionId: bidA, bidQuantity: 100, quantity: 60 }] }],
      rationale: 'Cheapest normalized.',
    });
    expect(short.status).toBe(422);
    expect(short.body['code']).toBe('AWARD_QUANTITY_MISMATCH');

    // A revision supersedes v1 of Anand's bid; citing v1 afterwards is refused.
    const revised = await supplierA.post(`/api/v1/supplier/rfqs/${rfqId}/bid/submit`, bidBody(4800, { revisionReason: 'Sharpened on review' }));
    // Submission after close may be refused by IN-06 rules; either way v1 remains the live one or is superseded.
    const live = await sourcing.get(`/api/v1/rfqs/${rfqId}`);
    const anand = (live.body['bids'] as Array<Record<string, unknown>>).find((b) => b['displayName'] === 'Anand Engineering')!;
    const liveVersionId = (anand['version'] as Record<string, unknown>)['bidVersionId'] as string;
    if (revised.status === 201) {
      const stale = await sourcing.post('/api/v1/awards', {
        rfqId,
        items: [{ rfqItemId: itemId, targetQuantity: 100, lines: [{ bidVersionId: bidA, bidQuantity: 100, quantity: 100 }] }],
        rationale: 'Citing the old version by mistake.',
      });
      expect(stale.status).toBe(422);
      expect(stale.body['code']).toBe('AWARD_BID_VERSION_NOT_LIVE');
    }
    bidA = liveVersionId;

    const wrongQty = await sourcing.post('/api/v1/awards', {
      rfqId,
      items: [{ rfqItemId: itemId, targetQuantity: 50, lines: [{ bidVersionId: bidA, bidQuantity: 50, quantity: 50 }] }],
      rationale: 'Nobody quoted fifty.',
    });
    expect(wrongQty.status).toBe(422);
    expect(wrongQty.body['code']).toBe('AWARD_LINE_MISMATCH');
  });

  it('proposes a split award and routes it to an approver who is not the proposer', async () => {
    const proposed = await sourcing.post('/api/v1/awards', {
      rfqId,
      evaluationId,
      items: [
        {
          rfqItemId: itemId,
          targetQuantity: 100,
          lines: [
            { bidVersionId: bidA, bidQuantity: 100, quantity: 60 },
            { bidVersionId: bidB, bidQuantity: 100, quantity: 40 },
          ],
        },
      ],
      rationale: 'Split to de-risk a first order with a new supplier.',
    });
    expect(proposed.status).toBe(201);
    awardId = proposed.body['awardId'] as string;
    awardApprovalId = proposed.body['approvalRequestId'] as string;
    expect(proposed.body['status']).toBe('proposed');
    expect(proposed.body['singleSource']).toBe(false);
    expect(proposed.body['approvalStatus']).toBe('pending');
    const lines = proposed.body['lines'] as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect(lines.reduce((s, l) => s + (l['quantity'] as number), 0)).toBe(100);
    // The buy cost is what each supplier quoted: its own setup, and its bid's freight to
    // JobWork and tooling/NRE in full (doc 10 §2) — not just unit price × quantity.
    const anand = lines.find((l) => l['bidVersionId'] === bidA)!;
    const balaji = lines.find((l) => l['bidVersionId'] === bidB)!;
    expect(anand).toMatchObject({ setupAmountMinor: 500000, freightAmountMinor: 250000, nreAmountMinor: 0, lineTotalMinor: 4850 * 60 + 500000 + 250000 });
    expect(balaji).toMatchObject({ setupAmountMinor: 500000, freightAmountMinor: 250000, nreAmountMinor: 200000, lineTotalMinor: 5250 * 40 + 500000 + 250000 + 200000 });
    expect(proposed.body['buyTotalMinor']).toBe((anand['lineTotalMinor'] as number) + (balaji['lineTotalMinor'] as number));

    // Separation of duties: the proposer cannot approve their own award.
    const self = await sourcing.post(`/api/v1/approvals/${awardApprovalId}/decide`, { decision: 'approved' });
    expect(self.status).toBe(409);
    expect(self.body['code']).toBe('APPROVAL_SEPARATION');
    // And finance is not an award approver under the launch policy.
    const wrongRole = await finance.post(`/api/v1/approvals/${awardApprovalId}/decide`, { decision: 'approved' });
    expect(wrongRole.status).toBe(403);
    expect(wrongRole.body['code']).toBe('APPROVAL_AUTHORITY_MISSING');

    const approved = await sales.post(`/api/v1/approvals/${awardApprovalId}/decide`, { decision: 'approved' });
    expect(approved.status).toBe(201);
    expect(approved.body['status']).toBe('approved');
    const decision = (approved.body['decisions'] as Array<Record<string, unknown>>)[0]!;
    expect(decision['authoritySnapshot']).toEqual({ roles: ['jobwork_sales'], organizationId: expect.any(String) });
    expect(approved.body['policyVersionNo']).toBe(1);

    // The effect: both cited versions selected, the round awarded, nothing left dangling.
    const award = await sourcing.get(`/api/v1/awards/${awardId}`);
    expect(award.body['status']).toBe('approved');
    const versions = await pg.query<{ id: string; status: string }>(`SELECT id, status FROM sourcing.supplier_bid_version WHERE id = ANY($1::uuid[])`, [[bidA, bidB]]);
    expect(versions.rows.every((v) => v.status === 'selected')).toBe(true);
    const rfq = await sourcing.get(`/api/v1/rfqs/${rfqId}`);
    expect((rfq.body['rfq'] as Record<string, unknown>)['status']).toBe('awarded');
    // Decided once: a second decision finds nothing pending.
    const twice = await sales.post(`/api/v1/approvals/${awardApprovalId}/decide`, { decision: 'rejected', reason: 'changed my mind' });
    expect(twice.status).toBe(409);
    expect(twice.body['code']).toBe('APPROVAL_NOT_PENDING');
  });

  // ---------------------------------------------------------------- F-07.4

  it('builds a cost sheet from the award, blocks a negative margin behind a finance exception, and hides it from platform admin', async () => {
    const negative = await sales.post(`/api/v1/awards/${awardId}/cost-sheet`, {
      components: [{ code: 'freight_outbound', label: 'Freight to customer', amountMinor: 30000, basis: 'courier estimate' }],
      targetMarginBp: -500,
      note: 'Loss leader?',
    });
    expect(negative.status).toBe(201);
    costSheetId = negative.body['costSheetId'] as string;
    const v1 = (negative.body['versions'] as Array<Record<string, unknown>>)[0]!;
    expect(v1['status']).toBe('draft');
    expect(v1['marginMinor']).toBeLessThan(0);
    // Buy total is the award's lines; landed adds the component; sell lines conserve the total.
    const award = await sales.get(`/api/v1/awards/${awardId}`);
    expect(v1['buyTotalMinor']).toBe(award.body['buyTotalMinor']);
    expect(v1['landedTotalMinor']).toBe((award.body['buyTotalMinor'] as number) + 30000);
    const sellLines = v1['sellLines'] as Array<Record<string, number>>;
    expect(sellLines.reduce((s, l) => s + l['amountMinor']!, 0)).toBe(v1['sellTotalMinor']);

    // Platform admin has no ambient business-data access (BR-AUTH-03).
    const peek = await admin.get(`/api/v1/cost-sheets/${costSheetId}`);
    expect(peek.status).toBe(403);

    // Asking for approval of a negative margin routes to finance, not sales.
    const requested = await sales.post(`/api/v1/cost-sheets/${costSheetId}/request-approval`, {});
    expect(requested.status).toBe(201);
    const pending = (requested.body['versions'] as Array<Record<string, unknown>>)[0]!;
    expect(pending['status']).toBe('pending_approval');
    const requestId = pending['approvalRequestId'] as string;
    const request = await finance.get(`/api/v1/approvals/${requestId}`);
    expect(request.body['requiredRoles']).toEqual(['jobwork_finance']);
    expect((request.body['context'] as Record<string, unknown>)['exception']).toBe('negative_margin');

    // A quote cannot be drafted from an unapproved cost sheet.
    const premature = await sales.post('/api/v1/quotes', {
      costSheetVersionId: pending['costSheetVersionId'],
      content: { deliveryLeadDays: 7, paymentTerms: '50% advance', validityUntil: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10) },
    });
    expect(premature.status).toBe(409);
    expect(premature.body['code']).toBe('COST_SHEET_NOT_APPROVED');

    // Finance returns it; sales fixes the margin; this time the floor is met and sales/finance may approve.
    const returned = await finance.post(`/api/v1/approvals/${requestId}/decide`, { decision: 'returned', reason: 'We do not sell below cost on a first order.' });
    expect(returned.status).toBe(201);
    const fixed = await sales.post(`/api/v1/awards/${awardId}/cost-sheet`, {
      components: [{ code: 'freight_outbound', label: 'Freight to customer', amountMinor: 30000, basis: 'courier estimate' }],
      targetMarginBp: 1500,
      note: 'Fifteen percent on sell.',
    });
    expect(fixed.status).toBe(201);
    const v1b = (fixed.body['versions'] as Array<Record<string, unknown>>)[0]!;
    expect(v1b['versionNo']).toBe(1);
    expect(Math.abs((v1b['marginBp'] as number) - 1500)).toBeLessThanOrEqual(1);
    const requested2 = await sales.post(`/api/v1/cost-sheets/${costSheetId}/request-approval`, {});
    const req2 = (requested2.body['versions'] as Array<Record<string, unknown>>)[0]!['approvalRequestId'] as string;
    const selfAgain = await sales.post(`/api/v1/approvals/${req2}/decide`, { decision: 'approved' });
    expect(selfAgain.status).toBe(409);
    const ok = await finance.post(`/api/v1/approvals/${req2}/decide`, { decision: 'approved' });
    expect(ok.status).toBe(201);
    const sheet = await sales.get(`/api/v1/cost-sheets/${costSheetId}`);
    expect(sheet.body['status']).toBe('approved');
  });

  // ---------------------------------------------------------------- F-07.5 / F-07.6

  it('drafts, approves and sends a quotation the customer sees with nothing of the buy side', async () => {
    const sheet = await sales.get(`/api/v1/cost-sheets/${costSheetId}`);
    const approvedVersion = (sheet.body['versions'] as Array<Record<string, unknown>>).find((v) => v['status'] === 'approved')!;
    const validity = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

    const drafted = await sales.post('/api/v1/quotes', {
      costSheetVersionId: approvedVersion['costSheetVersionId'],
      optionLabel: 'standard',
      content: { deliveryLeadDays: 7, paymentTerms: '50% advance, balance before dispatch', validityUntil: validity, assumptions: 'Material as per drawing.' },
    });
    expect(drafted.status).toBe(201);
    quoteId = drafted.body['quoteId'] as string;
    expect(drafted.body['status']).toBe('draft');
    expect(drafted.body['reference']).toBeNull();
    const dv1 = (drafted.body['versions'] as Array<Record<string, unknown>>)[0]!;
    // The quote's lines are the cost sheet's sell lines; GST on subtotal; total reproducible.
    expect((dv1['lines'] as unknown[]).length).toBe(1);
    // A quotation prices per unit: the subtotal is unit price × quantity, which can sit a
    // few minor units off the cost sheet's sell total (one rounding per line, BR-COM-10).
    expect(Math.abs((dv1['subtotalMinor'] as number) - (approvedVersion['sellTotalMinor'] as number))).toBeLessThanOrEqual(100);
    expect(dv1['taxMinor']).toBe(Math.round(((dv1['subtotalMinor'] as number) + 0) * 0.18));
    expect(dv1['totalMinor']).toBe((dv1['subtotalMinor'] as number) + (dv1['taxMinor'] as number));

    // The customer cannot see a draft.
    expect((await customer.get(`/api/v1/quotations/${quoteId}`)).status).toBe(404);
    expect(((await customer.get('/api/v1/quotations')).body['quotations'] as unknown[]).length).toBe(0);

    // Sending before approval is refused; approval is by someone other than the requester.
    const early = await sales.post(`/api/v1/quotes/${quoteId}/send`, { expectedVersion: drafted.body['aggregateVersion'] });
    expect(early.status).toBe(409);
    const requested = await sales.post(`/api/v1/quotes/${quoteId}/request-approval`, { expectedVersion: drafted.body['aggregateVersion'] });
    expect(requested.status).toBe(201);
    expect(requested.body['status']).toBe('internal_approval');
    const approvalId = (requested.body['versions'] as Array<Record<string, unknown>>)[0]!['approvalRequestId'] as string;
    // Below the first tier, sales approves — but not the sales person who asked.
    const self = await sales.post(`/api/v1/approvals/${approvalId}/decide`, { decision: 'approved' });
    expect(self.status).toBe(409);
    const approved = await sourcing.post(`/api/v1/approvals/${approvalId}/decide`, { decision: 'approved' });
    expect(approved.status).toBe(403); // sourcing is not a quote approver
    // Finance holds the broader tier role set only above the threshold; the launch policy
    // lists sales alone below it, so a second sales user is needed.
    await seedUser((await pg.query<{ id: string }>(`SELECT id FROM iam.organization WHERE type = 'internal'`)).rows[0]!.id, 'sales2@jobwork.test', ['jobwork_sales']);
    const sales2 = await signInWithMfa('sales2@jobwork.test');
    const ok = await sales2.post(`/api/v1/approvals/${approvalId}/decide`, { decision: 'approved' });
    expect(ok.status).toBe(201);

    const beforeSend = await sales.get(`/api/v1/quotes/${quoteId}`);
    const sent = await sales.post(`/api/v1/quotes/${quoteId}/send`, { expectedVersion: beforeSend.body['aggregateVersion'] });
    expect(sent.status).toBe(201);
    expect(sent.body['status']).toBe('sent');
    expect(sent.body['reference']).toMatch(/^QUO-\d{4}-\d{4}$/);
    // Sent content is frozen by the database.
    const versionId = (sent.body['versions'] as Array<Record<string, unknown>>)[0]!['quoteVersionId'] as string;
    await expect(pg.query(`UPDATE commercial.quote_version SET total_minor = 1 WHERE id = $1`, [versionId])).rejects.toThrow(/immutable/);
    // And it went out as an event.
    const outbox = await pg.query(`SELECT 1 FROM platform.outbox_event WHERE event_type = 'commercial.quote_sent.v1' AND aggregate_id = $1`, [quoteId]);
    expect(outbox.rowCount).toBe(1);

    // The customer's view: sell side only, by construction.
    const list = await customer.get('/api/v1/quotations');
    expect(list.status).toBe(200);
    const items = list.body['quotations'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!['status']).toBe('quotation_ready');
    const detail = await customer.get(`/api/v1/quotations/${quoteId}`);
    expect(detail.status).toBe(200);
    expect(detail.body['issuedBy']).toBe('JobWork');
    expect(detail.body['totalMinor']).toBe(sent.body['versions'] && (sent.body['versions'] as Array<Record<string, unknown>>)[0]!['totalMinor']);
    expect((detail.body['actions'] as Record<string, boolean>)['canAccept']).toBe(true);
    const keys = [...keysOf(detail.body)].map((k) => k.toLowerCase());
    for (const forbidden of ['supplier', 'bid', 'cost', 'margin', 'landed', 'award', 'evaluation', 'buy']) {
      expect(keys.filter((k) => k.includes(forbidden)), `leaked key containing "${forbidden}"`).toEqual([]);
    }
    const serialized = JSON.stringify(detail.body);
    expect(serialized).not.toContain('Anand');
    expect(serialized).not.toContain('Balaji');
    expect(serialized).not.toContain(bidA);
    expect(serialized).not.toContain(costSheetId);

    // The document renders from the frozen version and carries the hash.
    const doc = await customer.get(`/api/v1/quotations/${quoteId}/document`);
    expect(doc.status).toBe(200);
    expect(doc.body['contentHash']).toBe(detail.body['contentHash']);
    expect(doc.body['html']).toContain(detail.body['reference']);
    expect(doc.body['html']).not.toContain('Anand');

    // Another customer organization sees nothing.
    const strangerOrg = await seedOrg('customer', 'Rival Machines');
    await seedUser(strangerOrg, 'buyer@rival.test', ['customer_requester']);
    const stranger = await signIn('buyer@rival.test');
    expect((await stranger.get(`/api/v1/quotations/${quoteId}`)).status).toBe(404);
    // Suppliers cannot reach the customer surface at all.
    expect((await supplierA.get('/api/v1/quotations')).status).toBe(403);
  });

  it('takes a revision request, issues a replacement with a diff, and records a rejection', async () => {
    const before = await customer.get(`/api/v1/quotations/${quoteId}`);
    // A requester may ask for a revision; the request carries the version it was looking at.
    const stale = await customer.post(`/api/v1/quotations/${quoteId}/request-revision`, { expectedVersion: 1, reason: 'Can you do 5 days?' });
    expect(stale.status).toBe(409);
    expect(stale.body['code']).toBe('VERSION_CONFLICT');
    const revision = await customer.post(`/api/v1/quotations/${quoteId}/request-revision`, {
      expectedVersion: before.body['aggregateVersion'],
      reason: 'Can you do 5 days delivery?',
    });
    expect(revision.status).toBe(201);
    expect(revision.body['status']).toBe('revision_requested');
    expect((revision.body['actions'] as Record<string, boolean>)['canAccept']).toBe(false);

    // Sales replaces it: a new version, the old one still readable as sent.
    const internal = await sales.get(`/api/v1/quotes/${quoteId}`);
    expect(internal.body['decisionReason']).toBe('Can you do 5 days delivery?');
    const v1 = (internal.body['versions'] as Array<Record<string, unknown>>)[0]!;
    const replaced = await sales.post(`/api/v1/quotes/${quoteId}/replace`, {
      expectedVersion: internal.body['aggregateVersion'],
      revisionReason: 'Faster delivery at a premium.',
      content: {
        lines: (v1['lines'] as Array<Record<string, unknown>>).map((l) => ({ ...l, unitPriceMinor: (l['unitPriceMinor'] as number) + 500 })),
        taxRateBp: 1800,
        freightMinor: 0,
        deliveryLeadDays: 5,
        paymentTerms: v1['paymentTerms'],
        validityUntil: v1['validityUntil'],
        assumptions: v1['assumptions'],
        exclusions: '',
        scopeNote: '',
      },
    });
    expect(replaced.status).toBe(201);
    expect(replaced.body['status']).toBe('draft');
    expect(replaced.body['currentVersionNo']).toBe(2);
    // The customer still sees v1, marked as a revision in progress.
    const during = await customer.get(`/api/v1/quotations/${quoteId}`);
    expect(during.body['versionNo']).toBe(1);
    expect(during.body['status']).toBe('revision_requested');

    // Approve and send v2.
    const req = await sales.post(`/api/v1/quotes/${quoteId}/request-approval`, { expectedVersion: replaced.body['aggregateVersion'] });
    const approvalId = (req.body['versions'] as Array<Record<string, unknown>>)[0]!['approvalRequestId'] as string;
    const sales2 = await signIn('sales2@jobwork.test');
    const secret = await pg.query<{ mfa_totp_secret: string }>(`SELECT mfa_totp_secret FROM iam.user_account WHERE email = 'sales2@jobwork.test'`);
    await sales2.post('/api/v1/auth/mfa', { code: totpCode(secret.rows[0]!.mfa_totp_secret, 'sales2@jobwork.test') });
    expect((await sales2.post(`/api/v1/approvals/${approvalId}/decide`, { decision: 'approved' })).status).toBe(201);
    const approvedQuote = await sales.get(`/api/v1/quotes/${quoteId}`);
    const sent2 = await sales.post(`/api/v1/quotes/${quoteId}/send`, { expectedVersion: approvedQuote.body['aggregateVersion'] });
    expect(sent2.status).toBe(201);
    const statuses = (sent2.body['versions'] as Array<Record<string, unknown>>).map((v) => [v['versionNo'], v['status']]);
    expect(statuses).toEqual([[2, 'sent'], [1, 'superseded']]);
    expect(sent2.body['reference']).toBe(before.body['reference']);

    const after = await customer.get(`/api/v1/quotations/${quoteId}`);
    expect(after.body['versionNo']).toBe(2);
    expect(after.body['status']).toBe('quotation_ready');
    expect(after.body['deliveryLeadDays']).toBe(5);
    const previous = after.body['previousVersions'] as Array<Record<string, unknown>>;
    expect(previous).toHaveLength(1);
    expect(previous[0]!['versionNo']).toBe(1);
    // The diff lives on the *current* version relative to the previous sent one.
    const sibling = after.body['siblingOptions'];
    expect(sibling).toEqual([]);

    // A requester may not reject; an approver may, with a reason.
    const forbidden = await customer.post(`/api/v1/quotations/${quoteId}/reject`, { expectedVersion: after.body['aggregateVersion'], reason: 'Too dear.' });
    expect(forbidden.status).toBe(403);
    const rejected = await approver.post(`/api/v1/quotations/${quoteId}/reject`, { expectedVersion: after.body['aggregateVersion'], reason: 'Too dear for a first order.' });
    expect(rejected.status).toBe(201);
    expect(rejected.body['status']).toBe('rejected');
    const again = await approver.post(`/api/v1/quotations/${quoteId}/request-revision`, { expectedVersion: rejected.body['aggregateVersion'], reason: 'Actually…' });
    expect(again.status).toBe(409);
    expect(again.body['code']).toBe('QUOTE_NOT_OPEN');
    // The customer's home counts it no longer.
    const summary = await customer.get('/api/v1/portal/summary');
    const queue = (summary.body['queues'] as Array<{ key: string; count: number }>).find((q) => q.key === 'quotations_awaiting_decision');
    expect(queue?.count).toBe(0);
  });

  it('expires a sent quotation past its validity through the service sweep', async () => {
    // A second option on the same enquiry, sent with a validity already in the past by DB edit.
    const sheet = await sales.get(`/api/v1/cost-sheets/${costSheetId}`);
    const approvedVersion = (sheet.body['versions'] as Array<Record<string, unknown>>).find((v) => v['status'] === 'approved')!;
    const fast = await sales.post('/api/v1/quotes', {
      costSheetVersionId: approvedVersion['costSheetVersionId'],
      optionLabel: 'fast',
      content: { deliveryLeadDays: 3, paymentTerms: '100% advance', validityUntil: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) },
    });
    expect(fast.status).toBe(201);
    const duplicate = await sales.post('/api/v1/quotes', {
      costSheetVersionId: approvedVersion['costSheetVersionId'],
      optionLabel: 'fast',
      content: { deliveryLeadDays: 3, paymentTerms: '100% advance', validityUntil: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body['code']).toBe('QUOTE_OPTION_EXISTS');

    const fastId = fast.body['quoteId'] as string;
    const req = await sales.post(`/api/v1/quotes/${fastId}/request-approval`, { expectedVersion: fast.body['aggregateVersion'] });
    const approvalId = (req.body['versions'] as Array<Record<string, unknown>>)[0]!['approvalRequestId'] as string;
    const sales2 = await signIn('sales2@jobwork.test');
    const secret = await pg.query<{ mfa_totp_secret: string }>(`SELECT mfa_totp_secret FROM iam.user_account WHERE email = 'sales2@jobwork.test'`);
    await sales2.post('/api/v1/auth/mfa', { code: totpCode(secret.rows[0]!.mfa_totp_secret, 'sales2@jobwork.test') });
    await sales2.post(`/api/v1/approvals/${approvalId}/decide`, { decision: 'approved' });
    const q = await sales.get(`/api/v1/quotes/${fastId}`);
    expect((await sales.post(`/api/v1/quotes/${fastId}/send`, { expectedVersion: q.body['aggregateVersion'] })).status).toBe(201);

    // Validity is frozen content, so the only honest way to age it is to move the clock:
    // the sweep takes `now` from the request, and the DB edit below is on the sweep's
    // read side (validity_until is compared, never rewritten).
    const expiredBefore = await customer.get(`/api/v1/quotations/${fastId}`);
    expect(expiredBefore.body['status']).toBe('quotation_ready');
    await pg.query(`ALTER TABLE commercial.quote_version DISABLE TRIGGER trg_quote_version_immutable`);
    await pg.query(`UPDATE commercial.quote_version SET validity_until = current_date - 1 WHERE customer_quote_id = $1`, [fastId]);
    await pg.query(`ALTER TABLE commercial.quote_version ENABLE TRIGGER trg_quote_version_immutable`);

    // Before the sweep the projection already says expired (server truth by date)...
    const projected = await customer.get(`/api/v1/quotations/${fastId}`);
    expect(projected.body['status']).toBe('expired');
    expect((projected.body['actions'] as Record<string, boolean>)['canAccept']).toBe(false);
    const lateRevision = await customer.post(`/api/v1/quotations/${fastId}/request-revision`, { expectedVersion: projected.body['aggregateVersion'], reason: 'Still valid?' });
    expect(lateRevision.status).toBe(409);
    expect(lateRevision.body['code']).toBe('QUOTE_EXPIRED');

    // ...and the sweep makes it a recorded disposition.
    const { mintServiceToken, SCAN_WORKER_PRINCIPAL, SERVICE_TOKEN_HEADER } = await import('@jobwork/service-auth');
    const token = mintServiceToken('test-service-token-secret', SCAN_WORKER_PRINCIPAL.name);
    const sweep = await fetch(`${baseUrl}/api/v1/internal/quotes/expiry-sweep`, {
      method: 'POST',
      headers: { [SERVICE_TOKEN_HEADER]: token, origin: 'http://localhost:3000' },
    });
    const sweepBody = (await sweep.json()) as { expired?: number };
    expect(sweep.status).toBe(201);
    expect(sweepBody.expired).toBe(1);
    // The IN-06 deadline sweep rides the same service path; it must answer the worker too
    // (regression: a service-only route used to have no actor and answered 401).
    const deadlines = await fetch(`${baseUrl}/api/v1/internal/rfqs/deadline-sweep`, {
      method: 'POST',
      headers: { [SERVICE_TOKEN_HEADER]: mintServiceToken('test-service-token-secret', SCAN_WORKER_PRINCIPAL.name), origin: 'http://localhost:3000' },
    });
    expect(deadlines.status).toBe(201);
    const row = await pg.query<{ status: string }>(`SELECT status FROM commercial.customer_quote WHERE id = $1`, [fastId]);
    expect(row.rows[0]!.status).toBe('expired');
  });

  it('re-quotes in a fresh offer set once every option in the last one closed without an acceptance', async () => {
    // Standard was rejected and fast expired above: nothing in the set can be decided any more.
    const sheet = await sales.get(`/api/v1/cost-sheets/${costSheetId}`);
    const approvedVersion = (sheet.body['versions'] as Array<Record<string, unknown>>).find((v) => v['status'] === 'approved')!;
    const content = { deliveryLeadDays: 7, paymentTerms: '50% advance, balance before dispatch', validityUntil: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10) };
    const requote = await sales.post('/api/v1/quotes', { costSheetVersionId: approvedVersion['costSheetVersionId'], optionLabel: 'standard', content });
    expect(requote.status).toBe(201);
    const sets = await pg.query<{ offer_set_id: string; status: string }>(
      `SELECT offer_set_id, status FROM commercial.customer_quote WHERE enquiry_id = (SELECT enquiry_id FROM commercial.customer_quote WHERE id = $1) ORDER BY created_at`,
      [requote.body['quoteId']],
    );
    expect(sets.rows.map((r) => r.status)).toEqual(['rejected', 'expired', 'draft']);
    // Fast was itself offered after standard's rejection closed the first set, so each
    // offer is its own set: three offers, three sets, and the closed ones untouched.
    expect(new Set(sets.rows.map((r) => r.offer_set_id)).size).toBe(3);
    // The new set is open again, so a second standard option in it is still refused.
    const twice = await sales.post('/api/v1/quotes', { costSheetVersionId: approvedVersion['costSheetVersionId'], optionLabel: 'standard', content });
    expect(twice.status).toBe(409);
    expect(twice.body['code']).toBe('QUOTE_OPTION_EXISTS');
  });
});
