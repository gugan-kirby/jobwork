import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'sourcing-negative-password-1';
const SESSION_COOKIE = 'jw_session';

/**
 * The doc 03 §7 isolation rules, executable now that there is something to leak.
 *
 * These are the tests JobWork's whole proposition rests on: the customer never learns
 * who quoted, the suppliers never learn who the customer is or what anyone else bid, and
 * asking about somebody else's record returns the same answer as asking about a record
 * that does not exist — because a 403 confirms existence and a 404 does not.
 */
describe('Sourcing cross-party isolation (F-06.7, doc 03 §7)', () => {
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
    db = await createTestDatabase('jobwork_negative');
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

  it('keeps supplier A away from supplier B\'s bid, by every route there is', async () => {
    const { rfqId, itemId } = await openRound();
    const bidB = await supplierB.post(
      `/api/v1/supplier/rfqs/${rfqId}/bid/submit`,
      bidBody(itemId, 41000),
    );
    expect(bidB.status).toBe(201);
    const bidVersionId = bidB.body['bidVersionId'] as string;

    // A's own view of the same round carries A's bid and no trace of B's.
    await supplierA.post(`/api/v1/supplier/rfqs/${rfqId}/bid/submit`, bidBody(itemId, 46000));
    const viewA = await supplierA.get(`/api/v1/supplier/rfqs/${rfqId}`);
    const serialized = JSON.stringify(viewA.body);
    expect(serialized).not.toContain('41000');
    expect(serialized).not.toContain(bidVersionId);
    expect(serialized).not.toContain(orgB);
    expect(serialized).not.toContain('Balaji Precision');

    // The internal evaluation view is not reachable by a supplier at all.
    expect((await supplierA.get(`/api/v1/rfqs/${rfqId}`)).status).toBe(403);
    expect((await supplierA.get('/api/v1/rfqs')).status).toBe(403);

    // A's list shows one round with one bid — its own.
    const list = await supplierA.get('/api/v1/supplier/rfqs');
    const row = (list.body['rfqs'] as Array<Record<string, unknown>>).find(
      (item) => item['rfqId'] === rfqId,
    )!;
    expect(row['bidVersionCount']).toBe(1);
  });

  it('never shows a supplier who the customer is', async () => {
    const { rfqId } = await openRound();
    const view = await supplierA.get(`/api/v1/supplier/rfqs/${rfqId}`);
    const serialized = JSON.stringify(view.body);

    for (const forbidden of [
      customerOrgId,
      'Kovai Pumps',
      'ENQ-2026-7001',
      enquiryId,
      'buyer@kovai.test',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Not even as a key: the supplier payload has no customer-shaped field to fill.
    expect(Object.keys(view.body).sort()).toEqual([
      'acknowledgedAt',
      'bid',
      'currency',
      'deadlineAt',
      'documents',
      'instructions',
      'invitationStatus',
      'invitedAt',
      'items',
      'lateBidPolicy',
      'reference',
      'rfqId',
      'roundNo',
      'status',
    ]);
    // The released filename is the supplier's only view of the document, and it is the
    // file's own name — it carries no customer identity either.
    const documents = view.body['documents'] as Array<Record<string, unknown>>;
    expect(documents[0]!['filename']).toBe('bracket.pdf');
  });

  it('keeps every bid away from the customer', async () => {
    const { rfqId, itemId } = await openRound();
    await supplierA.post(`/api/v1/supplier/rfqs/${rfqId}/bid/submit`, bidBody(itemId, 44000));

    // No customer route reaches a round, a bid, or the supplier network behind it.
    expect((await customer.get(`/api/v1/rfqs/${rfqId}`)).status).toBe(403);
    expect((await customer.get('/api/v1/rfqs')).status).toBe(403);
    expect((await customer.get(`/api/v1/supplier/rfqs/${rfqId}`)).status).toBe(403);
    expect((await customer.get('/api/v1/supplier/rfqs')).status).toBe(403);

    // What the customer *can* see about the enquiry says sourcing is under way and
    // nothing about who is quoting or for how much.
    const enquiry = await customer.get(`/api/v1/enquiries/${enquiryId}`);
    const serialized = JSON.stringify(enquiry.body);
    for (const forbidden of ['44000', orgA, orgB, 'Anand Engineering', 'Balaji Precision', 'bid']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('answers enumeration the way it answers a genuine miss', async () => {
    const { rfqId } = await openRound();
    const invisible = await sourcing.post('/api/v1/rfqs', {
      enquiryId,
      deadlineAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      instructions: 'Nobody is invited to this one.',
    });
    const unreleasedId = invisible.body['rfqId'] as string;

    // A round they were not invited to, and a round that does not exist, look identical.
    const notInvited = await supplierB.get(`/api/v1/supplier/rfqs/${unreleasedId}`);
    const nonexistent = await supplierB.get(
      '/api/v1/supplier/rfqs/00000000-0000-4000-8000-000000000000',
    );
    expect(notInvited.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    expect(notInvited.body['code']).toBe(nonexistent.body['code']);

    // The same holds after revocation: the round stops existing for them.
    const detail = await sourcing.get(`/api/v1/rfqs/${rfqId}`);
    const invitation = ((detail.body['rfq'] as Record<string, unknown>)['invitations'] as Array<
      Record<string, unknown>
    >).find((row) => row['organizationId'] === orgB)!;
    await sourcing.post(
      `/api/v1/rfqs/${rfqId}/invitations/${invitation['rfqSupplierId'] as string}/revoke`,
      { reason: 'Withdrawn from this round' },
    );
    const afterRevoke = await supplierB.get(`/api/v1/supplier/rfqs/${rfqId}`);
    expect(afterRevoke.status).toBe(404);
    expect(afterRevoke.body['code']).toBe(nonexistent.body['code']);
  });

  it('refuses a supplier acting on a round it cannot see', async () => {
    const { rfqId, itemId } = await openRound();
    const detail = await sourcing.get(`/api/v1/rfqs/${rfqId}`);
    const invitation = ((detail.body['rfq'] as Record<string, unknown>)['invitations'] as Array<
      Record<string, unknown>
    >).find((row) => row['organizationId'] === orgB)!;
    await sourcing.post(
      `/api/v1/rfqs/${rfqId}/invitations/${invitation['rfqSupplierId'] as string}/revoke`,
      { reason: 'Not for this round' },
    );

    for (const [path, body] of [
      [`/api/v1/supplier/rfqs/${rfqId}/acknowledge`, {}],
      [`/api/v1/supplier/rfqs/${rfqId}/decline`, { declineCode: 'capacity', reason: 'No room' }],
      [`/api/v1/supplier/rfqs/${rfqId}/bid/submit`, bidBody(itemId, 40000)],
      [`/api/v1/supplier/rfqs/${rfqId}/bid/withdraw`, { reason: 'Changed our mind' }],
    ] as const) {
      const res = await supplierB.post(path, body);
      expect(res.status).toBe(404);
    }
  });

  it('keeps internal commands internal', async () => {
    const { rfqId } = await openRound();
    const detail = await sourcing.get(`/api/v1/rfqs/${rfqId}`);
    const version = (detail.body['rfq'] as Record<string, unknown>)['aggregateVersion'];

    for (const client of [supplierA, customer]) {
      expect(
        (await client.post('/api/v1/rfqs', {
          enquiryId,
          deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
        })).status,
      ).toBe(403);
      expect(
        (await client.post(`/api/v1/rfqs/${rfqId}/release`, { expectedVersion: version })).status,
      ).toBe(403);
      expect(
        (await client.post(`/api/v1/rfqs/${rfqId}/close`, { expectedVersion: version })).status,
      ).toBe(403);
      expect(
        (await client.post(`/api/v1/rfqs/${rfqId}/invitations`, { supplierProfileId: profileA }))
          .status,
      ).toBe(403);
    }
  });
});
