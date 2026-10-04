import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'rfq-bids-password-1';
const SESSION_COOKIE = 'jw_session';

/**
 * IN-06: release a round, take bids, revise one, close for evaluation — with the two
 * properties the increment exists for. A submitted bid version is immutable, and neither
 * party can see the other: supplier A cannot reach supplier B's bid, no supplier can
 * reach the customer, and the customer cannot reach any bid.
 */
describe('RFQ release and immutable bids (IN-06)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let sourcing: TestClient;
  let customer: TestClient;
  let supplierA: TestClient;
  let supplierB: TestClient;
  let customerOrgId: string;
  let profileA: string;
  let profileB: string;
  let orgA: string;
  let orgB: string;
  let enquiryId: string;
  let millingId: string;
  let aluminiumId: string;

  function totpCode(secret: string, email: string): string {
    return new OTPAuth.TOTP({
      issuer: 'JobWork',
      label: email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    }).generate();
  }

  async function seedOrg(type: string, name: string): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ($1, $2, $2) RETURNING id`,
      [type, name],
    );
    return res.rows[0]!.id;
  }

  async function seedUser(orgId: string, email: string, roles: string[]): Promise<void> {
    const user = await pg.query<{ id: string }>(
      `INSERT INTO iam.user_account
         (email, password_hash, password_params_version, display_name, status, email_verified_at)
       VALUES ($1, $2, 1, 'Member', 'active', now()) RETURNING id`,
      [email, await hashPassword(PASSWORD)],
    );
    const membership = await pg.query<{ id: string }>(
      `INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`,
      [user.rows[0]!.id, orgId],
    );
    await pg.query(
      `INSERT INTO iam.membership_role (membership_id, role_id)
       SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`,
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
    await first.post('/api/v1/account/mfa/activate', {
      code: totpCode(enroll.body['secret'] as string, email),
    });
    const fresh = new TestClient(baseUrl);
    await fresh.post('/api/v1/auth/login', { email, password: PASSWORD });
    const secret = await pg.query<{ mfa_totp_secret: string }>(
      `SELECT mfa_totp_secret FROM iam.user_account WHERE email = $1`,
      [email],
    );
    await fresh.post('/api/v1/auth/mfa', { code: totpCode(secret.rows[0]!.mfa_totp_secret, email) });
    return fresh;
  }

  /** A clean document version the customer owns, ready to release. */
  async function seedDocument(orgId: string, scanState = 'clean'): Promise<string> {
    const doc = await pg.query<{ id: string }>(
      `INSERT INTO dms.document (owning_organization_id, logical_type, title)
       VALUES ($1, 'drawing_2d', 'Bracket drawing') RETURNING id`,
      [orgId],
    );
    const file = await pg.query<{ id: string }>(
      `INSERT INTO dms.file_object
         (storage_key, byte_size, declared_media_type, sha256, scan_state, owning_organization_id)
       VALUES ($1, 2048, 'application/pdf', $2, $3, $4) RETURNING id`,
      [
        `clean/${randomBytes(8).toString('hex')}`,
        randomBytes(32).toString('hex'),
        scanState,
        orgId,
      ],
    );
    const version = await pg.query<{ id: string }>(
      `INSERT INTO dms.document_version
         (document_id, version_no, file_object_id, original_filename, status, created_by)
       VALUES ($1, 1, $2, 'bracket.pdf', $3, gen_random_uuid()) RETURNING id`,
      [doc.rows[0]!.id, file.rows[0]!.id, scanState === 'clean' ? 'available' : 'processing'],
    );
    return version.rows[0]!.id;
  }

  /** An eligible supplier: verified mandatory evidence, a published capability, active. */
  async function seedEligibleSupplier(
    name: string,
    email: string,
  ): Promise<{ orgId: string; profileId: string }> {
    const orgId = await seedOrg('supplier', name);
    await seedUser(orgId, email, ['org_admin', 'supplier_estimator']);
    const profile = await pg.query<{ id: string }>(
      `INSERT INTO supplier.supplier_profile
         (organization_id, region_class, status, decided_by, decided_at, submitted_by,
          trade_name, primary_contact_name, primary_contact_email, primary_contact_phone, summary)
       VALUES ($1, 'chennai_metro', 'active', gen_random_uuid(), now(), gen_random_uuid(),
               $2, 'Contact', 'contact@example.test', '+91 90000 00000', 'We machine things')
       RETURNING id`,
      [orgId, name],
    );
    const profileId = profile.rows[0]!.id;
    for (const capabilityId of [millingId, aluminiumId]) {
      await pg.query(
        `INSERT INTO supplier.supplier_capability (supplier_profile_id, capability_id, version_no)
         VALUES ($1, $2, 1)`,
        [profileId, capabilityId],
      );
    }
    for (const kind of ['gst', 'pan', 'bank_account']) {
      await pg.query(
        `INSERT INTO supplier.verification_item
           (supplier_profile_id, kind, version_no, status, submitted_by, submitted_at,
            reviewed_by, reviewed_at, expires_at)
         VALUES ($1, $2, 1, 'verified', gen_random_uuid(), now(), gen_random_uuid(), now(),
                 now() + interval '200 days')`,
        [profileId, kind],
      );
    }
    return { orgId, profileId };
  }

  /** An approved enquiry with one line and one clean drawing, ready to source. */
  async function seedApprovedEnquiry(): Promise<string> {
    const enquiry = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.enquiry
         (customer_organization_id, title, application_note, status, reference, submitted_at,
          submitted_by, required_by_date)
       VALUES ($1, 'Pump bracket', 'Motor mount', 'approved_for_sourcing', 'ENQ-2026-7001',
               now(), gen_random_uuid(), current_date + 60)
       RETURNING id`,
      [customerOrgId],
    );
    const id = enquiry.rows[0]!.id;
    await pg.query(
      `INSERT INTO sourcing.enquiry_item
         (enquiry_id, line_no, part_name, description, process_capability_id,
          material_capability_id, material_grade, quantity_breakpoints, tolerance_class,
          inspection_level)
       VALUES ($1, 1, 'Bracket', 'Machined bracket', $2, $3, '6061-T6',
               '[{"quantity":100,"unit":"piece","kind":"production"}]'::jsonb, 'IT8', 'standard')`,
      [id, millingId, aluminiumId],
    );
    const documentVersionId = await seedDocument(customerOrgId);
    await pg.query(
      `INSERT INTO sourcing.enquiry_document (enquiry_id, document_version_id, role)
       VALUES ($1, $2, 'governing')`,
      [id, documentVersionId],
    );
    await pg.query(
      `INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash)
       VALUES ($1, 1, 'reviewed', '{"title":"Pump bracket"}'::jsonb, 'req-hash-1')`,
      [id],
    );
    return id;
  }

  async function openRound(
    deadline = new Date(Date.now() + 7 * 86_400_000),
    latePolicy: 'reject' | 'accept_flagged' = 'reject',
  ): Promise<{ rfqId: string; itemId: string }> {
    const created = await sourcing.post('/api/v1/rfqs', {
      enquiryId,
      deadlineAt: deadline.toISOString(),
      lateBidPolicy: latePolicy,
      instructions: 'Quote per piece at 100 off.',
    });
    expect(created.status).toBe(201);
    const rfqId = created.body['rfqId'] as string;

    for (const profileId of [profileA, profileB]) {
      const invited = await sourcing.post(`/api/v1/rfqs/${rfqId}/invitations`, {
        supplierProfileId: profileId,
      });
      expect(invited.status).toBe(201);
    }
    const detail = await sourcing.get(`/api/v1/rfqs/${rfqId}`);
    const released = await sourcing.post(`/api/v1/rfqs/${rfqId}/release`, {
      expectedVersion: (detail.body['rfq'] as Record<string, unknown>)['aggregateVersion'],
    });
    expect(released.status).toBe(201);

    const items = await supplierA.get(`/api/v1/supplier/rfqs/${rfqId}`);
    const itemId = (items.body['items'] as Array<Record<string, unknown>>)[0]!['rfqItemId'] as string;
    return { rfqId, itemId };
  }

  function bidBody(itemId: string, unitPriceMinor: number, extra: Record<string, unknown> = {}) {
    return {
      currency: 'INR',
      taxTreatment: 'gst_extra',
      lines: [
        {
          rfqItemId: itemId,
          lineNo: 1,
          quantity: 100,
          unit: 'piece',
          unitPriceMinor,
          setupAmountMinor: 500000,
          note: '',
        },
      ],
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

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_rfq');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['SESSION_COOKIE_NAME'] = SESSION_COOKIE;
    process.env['NODE_ENV'] = 'test';

    pg = new Client({ connectionString: db.url });
    await pg.connect();
    const capabilities = await pg.query<{ id: string; code: string }>(
      `SELECT id, code FROM supplier.capability WHERE code IN ('cnc_milling', 'material_aluminium')`,
    );
    millingId = capabilities.rows.find((row) => row.code === 'cnc_milling')!.id;
    aluminiumId = capabilities.rows.find((row) => row.code === 'material_aluminium')!.id;

    customerOrgId = await seedOrg('customer', 'Kovai Pumps');
    const internalOrgId = await seedOrg('internal', 'JobWork Operations');
    await seedUser(customerOrgId, 'buyer@kovai.test', ['customer_requester']);
    await seedUser(internalOrgId, 'sourcing@jobwork.test', ['jobwork_sourcing']);
    ({ orgId: orgA, profileId: profileA } = await seedEligibleSupplier(
      'Anand Engineering',
      'estimator@anand.test',
    ));
    ({ orgId: orgB, profileId: profileB } = await seedEligibleSupplier(
      'Balaji Precision',
      'estimator@balaji.test',
    ));
    enquiryId = await seedApprovedEnquiry();

    ({ app, baseUrl } = await createTestApp());
    sourcing = await signInWithMfa('sourcing@jobwork.test');
    customer = await signIn('buyer@kovai.test');
    supplierA = await signIn('estimator@anand.test');
    supplierB = await signIn('estimator@balaji.test');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('matches on the hard filter and explains every miss', async () => {
    const match = await sourcing.get(`/api/v1/rfqs/match?enquiryId=${enquiryId}`);
    expect(match.status).toBe(200);
    expect(match.body['configVersion']).toBe('hard-filter-v1');
    expect(match.body['requiredCapabilityCodes']).toEqual(
      expect.arrayContaining(['cnc_milling', 'material_aluminium']),
    );
    const candidates = match.body['candidates'] as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    // Every candidate says whether it passed and, if not, why — never a bare absence.
    for (const candidate of candidates) {
      if (!candidate['eligible']) {
        expect((candidate['exclusions'] as string[]).length).toBeGreaterThan(0);
      }
    }
    expect((await customer.get(`/api/v1/rfqs/match?enquiryId=${enquiryId}`)).status).toBe(403);
  });

  it('refuses to release anything a scanner has not cleared', async () => {
    const dirty = await seedDocument(customerOrgId, 'quarantined');
    await pg.query(
      `INSERT INTO sourcing.enquiry_document (enquiry_id, document_version_id, role)
       VALUES ($1, $2, 'reference')`,
      [enquiryId, dirty],
    );

    const created = await sourcing.post('/api/v1/rfqs', {
      enquiryId,
      deadlineAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      instructions: '',
    });
    const rfqId = created.body['rfqId'] as string;
    await sourcing.post(`/api/v1/rfqs/${rfqId}/invitations`, { supplierProfileId: profileA });
    const detail = await sourcing.get(`/api/v1/rfqs/${rfqId}`);
    const blocked = await sourcing.post(`/api/v1/rfqs/${rfqId}/release`, {
      expectedVersion: (detail.body['rfq'] as Record<string, unknown>)['aggregateVersion'],
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body['code']).toBe('RFQ_RELEASE_BLOCKED');
    expect(blocked.body['detail']).toContain('not scanned clean');

    // Nothing was released: no grant, no manifest row, and the supplier sees no round.
    const grants = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM dms.audience_grant WHERE document_version_id = $1`,
      [dirty],
    );
    expect(grants.rows[0]!.n).toBe('0');
    await pg.query(`DELETE FROM sourcing.enquiry_document WHERE document_version_id = $1`, [dirty]);
    await pg.query(`UPDATE sourcing.rfq SET status = 'cancelled' WHERE id = $1`, [rfqId]);
  });

  it('releases a sanitized manifest and grants exactly the invited suppliers', async () => {
    const { rfqId } = await openRound();

    const detail = await sourcing.get(`/api/v1/rfqs/${rfqId}`);
    const rfq = detail.body['rfq'] as Record<string, unknown>;
    expect(rfq['status']).toBe('open');
    expect(rfq['reference']).toMatch(/^RFQ-\d{4}-\d{4}$/);
    expect((rfq['release'] as unknown[]).length).toBe(1);
    expect((rfq['invitations'] as Array<Record<string, unknown>>).every((i) => i['status'] === 'invited')).toBe(
      true,
    );

    // Both invited organizations hold a live grant on the released version; nobody else.
    const grants = await pg.query<{ organization_id: string }>(
      `SELECT organization_id FROM dms.audience_grant
        WHERE revoked_at IS NULL AND audience_type = 'organization'`,
    );
    expect(grants.rows.map((row) => row.organization_id).sort()).toEqual([orgA, orgB].sort());

    // The supplier's own view carries the work and nothing about the customer.
    const asSupplier = await supplierA.get(`/api/v1/supplier/rfqs/${rfqId}`);
    expect(asSupplier.status).toBe(200);
    const serialized = JSON.stringify(asSupplier.body);
    for (const forbidden of [customerOrgId, 'Kovai Pumps', 'ENQ-2026-7001', enquiryId]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(asSupplier.body['items']).toHaveLength(1);
    expect(asSupplier.body['documents']).toHaveLength(1);
  });

  it('takes a bid, a revision, and refuses to let either be rewritten', async () => {
    const { rfqId, itemId } = await openRound();
    await supplierA.post(`/api/v1/supplier/rfqs/${rfqId}/acknowledge`, { note: 'Looking now' });

    const first = await supplierA.post(`/api/v1/supplier/rfqs/${rfqId}/bid/submit`, bidBody(itemId, 45000));
    expect(first.status).toBe(201);
    expect(first.body['versionNo']).toBe(1);
    expect(first.body['late']).toBe(false);
    const firstHash = first.body['contentHash'] as string;

    // A revision must say why, and produces a new version rather than an edit.
    const reasonless = await supplierA.post(
      `/api/v1/supplier/rfqs/${rfqId}/bid/submit`,
      bidBody(itemId, 43000),
    );
    expect(reasonless.status).toBe(422);
    expect(reasonless.body['code']).toBe('BID_REVISION_REASON_REQUIRED');

    const revised = await supplierA.post(
      `/api/v1/supplier/rfqs/${rfqId}/bid/submit`,
      bidBody(itemId, 43000, { revisionReason: 'Material price dropped' }),
    );
    expect(revised.status).toBe(201);
    expect(revised.body['versionNo']).toBe(2);
    expect(revised.body['contentHash']).not.toBe(firstHash);

    const view = await supplierA.get(`/api/v1/supplier/rfqs/${rfqId}`);
    const versions = (view.body['bid'] as Record<string, unknown>)['versions'] as Array<
      Record<string, unknown>
    >;
    expect(versions.map((version) => version['status'])).toEqual(['submitted', 'superseded']);
    // Version 1 still reads exactly as submitted — that is what a diff compares against.
    const original = versions.find((version) => version['versionNo'] === 1)!;
    expect(original['contentHash']).toBe(firstHash);
    expect(original['totalAmountMinor']).toBe(45000 * 100 + 500000 + 250000);

    // And the database refuses a rewrite even with direct SQL.
    await expect(
      pg.query(
        `UPDATE sourcing.supplier_bid_version SET total_amount_minor = 1
          WHERE content_hash = $1`,
        [firstHash],
      ),
    ).rejects.toThrow(/content is immutable/);
  });

  it('validates a bid against the round it is answering', async () => {
    const { rfqId, itemId } = await openRound();

    const wrongCurrency = await supplierA.post(
      `/api/v1/supplier/rfqs/${rfqId}/bid/submit`,
      bidBody(itemId, 45000, { currency: 'USD' }),
    );
    expect(wrongCurrency.status).toBe(422);
    expect(wrongCurrency.body['code']).toBe('BID_CURRENCY_MISMATCH');

    const wrongQuantity = await supplierA.post(`/api/v1/supplier/rfqs/${rfqId}/bid/submit`, {
      ...bidBody(itemId, 45000),
      lines: [
        {
          rfqItemId: itemId,
          lineNo: 1,
          quantity: 250,
          unit: 'piece',
          unitPriceMinor: 40000,
          setupAmountMinor: 0,
          note: '',
        },
      ],
    });
    expect(wrongQuantity.status).toBe(422);
    expect(wrongQuantity.body['code']).toBe('BID_QUANTITY_MISMATCH');

    const stale = await supplierA.post(
      `/api/v1/supplier/rfqs/${rfqId}/bid/submit`,
      bidBody(itemId, 45000, { validityUntil: '2020-01-01' }),
    );
    expect(stale.status).toBe(422);
    expect(stale.body['code']).toBe('BID_VALIDITY_PASSED');
  });

  it('applies the late-bid policy the round declared', async () => {
    const past = new Date(Date.now() - 60_000);
    const strict = await openRound(new Date(Date.now() + 60_000));
    await pg.query(`UPDATE sourcing.rfq SET deadline_at = $2 WHERE id = $1`, [strict.rfqId, past]);

    const refused = await supplierA.post(
      `/api/v1/supplier/rfqs/${strict.rfqId}/bid/submit`,
      bidBody(strict.itemId, 45000),
    );
    expect(refused.status).toBe(409);
    expect(refused.body['code']).toBe('BID_DEADLINE_PASSED');

    const lenient = await openRound(new Date(Date.now() + 60_000), 'accept_flagged');
    await pg.query(`UPDATE sourcing.rfq SET deadline_at = $2 WHERE id = $1`, [lenient.rfqId, past]);
    const accepted = await supplierA.post(
      `/api/v1/supplier/rfqs/${lenient.rfqId}/bid/submit`,
      bidBody(lenient.itemId, 45000),
    );
    expect(accepted.status).toBe(201);
    // Kept, and kept honest: the flag and the receipt time both survive.
    expect(accepted.body['late']).toBe(true);
    const stored = await pg.query<{ late: boolean; received_at: Date }>(
      `SELECT late, received_at FROM sourcing.supplier_bid_version WHERE id = $1`,
      [accepted.body['bidVersionId']],
    );
    expect(stored.rows[0]!.late).toBe(true);
    expect(stored.rows[0]!.received_at.getTime()).toBeGreaterThan(past.getTime());
  });

  it('revokes an invitation and the document access that came with it', async () => {
    const { rfqId } = await openRound();
    const detail = await sourcing.get(`/api/v1/rfqs/${rfqId}`);
    const invitation = (detail.body['rfq'] as Record<string, unknown>)['invitations'] as Array<
      Record<string, unknown>
    >;
    const target = invitation.find((row) => row['organizationId'] === orgB)!;

    const revoked = await sourcing.post(
      `/api/v1/rfqs/${rfqId}/invitations/${target['rfqSupplierId'] as string}/revoke`,
      { reason: 'Conflict of interest with this customer' },
    );
    expect(revoked.status).toBe(201);
    expect(revoked.body['grantsRevoked']).toBeGreaterThan(0);

    // The round disappears for them, and the grants are gone.
    expect((await supplierB.get(`/api/v1/supplier/rfqs/${rfqId}`)).status).toBe(404);
    const live = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM dms.audience_grant
        WHERE organization_id = $1 AND revoked_at IS NULL`,
      [orgB],
    );
    expect(live.rows[0]!.n).toBe('0');
    // What they downloaded before is a fact that happened; revocation is forward-looking
    // and the access log still holds it.
    expect((await supplierA.get(`/api/v1/supplier/rfqs/${rfqId}`)).status).toBe(200);
  });

  it('closes for evaluation, and closes an unanswered round as no_bid', async () => {
    const answered = await openRound();
    const bid = await supplierA.post(
      `/api/v1/supplier/rfqs/${answered.rfqId}/bid/submit`,
      bidBody(answered.itemId, 44000),
    );
    // Bidding without a separate acknowledgement is normal and allowed.
    expect(bid.status).toBe(201);
    await supplierB.post(`/api/v1/supplier/rfqs/${answered.rfqId}/decline`, {
      declineCode: 'capacity',
      reason: 'Full until March',
    });

    const detail = await sourcing.get(`/api/v1/rfqs/${answered.rfqId}`);
    const closed = await sourcing.post(`/api/v1/rfqs/${answered.rfqId}/close`, {
      expectedVersion: (detail.body['rfq'] as Record<string, unknown>)['aggregateVersion'],
    });
    expect(closed.status).toBe(201);
    expect(closed.body).toMatchObject({ status: 'evaluation', responded: 1 });

    // One response out of two invitations is a single-source risk the control room flags.
    const afterClose = await sourcing.get(`/api/v1/rfqs/${answered.rfqId}`);
    expect(afterClose.body['singleSourceRisk']).toBe(true);
    const bids = afterClose.body['bids'] as Array<Record<string, unknown>>;
    expect(bids.filter((bid) => bid['version'] !== null)).toHaveLength(1);

    // A round nobody answered closes as `no_bid`, explicitly.
    const silent = await openRound(new Date(Date.now() + 60_000));
    await pg.query(`UPDATE sourcing.rfq SET deadline_at = now() - interval '1 minute' WHERE id = $1`, [
      silent.rfqId,
    ]);
    const silentDetail = await sourcing.get(`/api/v1/rfqs/${silent.rfqId}`);
    const noBid = await sourcing.post(`/api/v1/rfqs/${silent.rfqId}/close`, {
      expectedVersion: (silentDetail.body['rfq'] as Record<string, unknown>)['aggregateVersion'],
    });
    expect(noBid.body).toMatchObject({ status: 'no_bid', responded: 0 });
    const dispositions = await pg.query<{ status: string }>(
      `SELECT status FROM sourcing.rfq_supplier WHERE rfq_id = $1`,
      [silent.rfqId],
    );
    // Nobody is left ambiguous: silence is recorded as `no_response`.
    expect(dispositions.rows.every((row) => row.status === 'no_response')).toBe(true);
  });

  it('refuses to close while suppliers are still inside the deadline', async () => {
    const { rfqId } = await openRound();
    const detail = await sourcing.get(`/api/v1/rfqs/${rfqId}`);
    const early = await sourcing.post(`/api/v1/rfqs/${rfqId}/close`, {
      expectedVersion: (detail.body['rfq'] as Record<string, unknown>)['aggregateVersion'],
    });
    expect(early.status).toBe(422);
    expect(early.body['detail']).toContain('still within the deadline');
  });

  it('will not release to a supplier whose evidence lapsed since shortlisting', async () => {
    const created = await sourcing.post('/api/v1/rfqs', {
      enquiryId,
      deadlineAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      instructions: '',
    });
    const rfqId = created.body['rfqId'] as string;
    await sourcing.post(`/api/v1/rfqs/${rfqId}/invitations`, { supplierProfileId: profileA });

    await pg.query(
      `UPDATE supplier.verification_item SET expires_at = now() - interval '1 day'
        WHERE supplier_profile_id = $1 AND kind = 'gst'`,
      [profileA],
    );
    const detail = await sourcing.get(`/api/v1/rfqs/${rfqId}`);
    const blocked = await sourcing.post(`/api/v1/rfqs/${rfqId}/release`, {
      expectedVersion: (detail.body['rfq'] as Record<string, unknown>)['aggregateVersion'],
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body['detail']).toContain('no longer eligible');

    await pg.query(
      `UPDATE supplier.verification_item SET expires_at = now() + interval '200 days'
        WHERE supplier_profile_id = $1 AND kind = 'gst'`,
      [profileA],
    );
    await pg.query(`UPDATE sourcing.rfq SET status = 'cancelled' WHERE id = $1`, [rfqId]);
  });
});
