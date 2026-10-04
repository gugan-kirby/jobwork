import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'supplier-onboarding-password-1';
const SESSION_COOKIE = 'jw_session';

/**
 * F-SO: the two admissions journeys. JobWork admits a supplier; the supplier describes
 * itself; a different person decides. The tests care most about the seams between those
 * three — the places where a shortcut would let a supplier admit itself, or let JobWork
 * call a supplier active while its evidence says otherwise.
 */
describe('Supplier onboarding and admission (F-SO)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let admin: TestClient; // internal platform_admin — admits
  let sourcing: TestClient; // internal jobwork_sourcing — decides
  let sourcingTwo: TestClient; // a second reviewer
  let customer: TestClient;
  let otherSupplier: TestClient;

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

  async function seedOrg(type: 'supplier' | 'internal' | 'customer', name: string): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ($1, $2, $2) RETURNING id`,
      [type, name],
    );
    return res.rows[0]!.id;
  }

  async function seedUser(orgId: string, email: string, roles: string[]): Promise<string> {
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
    return user.rows[0]!.id;
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

  /** Admits a supplier and signs its first user in through the invitation it was sent. */
  async function admitSupplier(
    overrides: Record<string, unknown> = {},
  ): Promise<{ profileId: string; organizationId: string; client: TestClient; email: string }> {
    const suffix = Math.random().toString(36).slice(2, 8);
    const email = `owner+${suffix}@supplier.test`;
    const res = await admin.post('/api/v1/suppliers', {
      legalName: `Anand Engineering ${suffix} Private Limited`,
      displayName: `Anand Engineering ${suffix}`,
      regionClass: 'chennai_metro',
      primaryContactName: 'V. Anand',
      primaryContactEmail: email,
      primaryContactPhone: '+91 90000 11111',
      firstUserEmail: email,
      firstUserRoleKeys: ['org_admin'],
      ...overrides,
    });
    expect(res.status).toBe(201);

    const token = new URL(res.body['acceptUrl'] as string).searchParams.get('token');
    const client = new TestClient(baseUrl);
    const accepted = await client.post('/api/v1/invitations/accept', {
      token,
      displayName: 'V. Anand',
      password: PASSWORD,
    });
    expect(accepted.status).toBe(201);
    await client.post('/api/v1/auth/login', { email, password: PASSWORD });

    return {
      profileId: res.body['supplierProfileId'] as string,
      organizationId: res.body['organizationId'] as string,
      client,
      email,
    };
  }

  /** Everything the checklist asks of the supplier, short of evidence. */
  async function describeSelf(client: TestClient): Promise<void> {
    const current = await client.get('/api/v1/suppliers/me');
    const profile = current.body['profile'] as Record<string, unknown>;
    const updated = await client.post('/api/v1/suppliers/me/profile', {
      expectedVersion: profile['aggregateVersion'],
      tradeName: 'Anand Engineering',
      website: 'https://example.invalid',
      summary: 'Turned and milled components for pump assemblies.',
      regionClass: 'chennai_metro',
      yearEstablished: 2011,
      employeeBand: '11-50',
      primaryContactName: 'V. Anand',
      primaryContactEmail: 'contact@supplier.test',
      primaryContactPhone: '+91 90000 11111',
    });
    expect(updated.status).toBe(201);
    const site = await client.post('/api/v1/suppliers/me/site', {
      label: 'Ambattur unit',
      addressLine1: '18 Ambattur Industrial Estate',
      city: 'Chennai',
      state: 'Tamil Nadu',
      postalCode: '600058',
    });
    expect(site.status).toBe(201);
    await client.post('/api/v1/suppliers/me/capabilities', {
      capabilityCode: 'cnc_turning',
      attributes: { toleranceClass: 'IT7' },
    });
  }

  /** Submits and verifies the mandatory evidence set through the real review path. */
  async function proveEvidence(client: TestClient, reviewer: TestClient = sourcing): Promise<void> {
    for (const kind of ['gst', 'pan', 'bank_account']) {
      const submitted = await client.post('/api/v1/suppliers/me/verification', { kind });
      expect(submitted.status).toBe(201);
      const review = await reviewer.post(
        `/api/v1/suppliers/verification/${submitted.body['verificationItemId'] as string}/review`,
        {
          decision: 'verify',
          expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
        },
      );
      expect(review.status).toBe(201);
    }
  }

  async function submitFile(client: TestClient): Promise<Record<string, unknown>> {
    const ready = await client.get('/api/v1/suppliers/me');
    const profile = ready.body['profile'] as Record<string, unknown>;
    const submitted = await client.post('/api/v1/suppliers/me/submit', {
      expectedVersion: profile['aggregateVersion'],
    });
    return submitted.body as Record<string, unknown>;
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_sonboard');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['SESSION_COOKIE_NAME'] = SESSION_COOKIE;
    process.env['NODE_ENV'] = 'test';

    pg = new Client({ connectionString: db.url });
    await pg.connect();
    const internalOrgId = await seedOrg('internal', 'JobWork Operations');
    const customerOrgId = await seedOrg('customer', 'Demo Pumps');
    const otherSupplierOrgId = await seedOrg('supplier', 'Someone Else Works');
    await seedUser(internalOrgId, 'admin@jobwork.test', ['platform_admin']);
    await seedUser(internalOrgId, 'sourcing@jobwork.test', ['jobwork_sourcing']);
    await seedUser(internalOrgId, 'sourcing2@jobwork.test', ['jobwork_sourcing']);
    await seedUser(customerOrgId, 'buyer@customer.test', ['customer_requester']);
    await seedUser(otherSupplierOrgId, 'other@supplier.test', ['org_admin']);

    ({ app, baseUrl } = await createTestApp());
    admin = await signInWithMfa('admin@jobwork.test');
    sourcing = await signInWithMfa('sourcing@jobwork.test');
    sourcingTwo = await signInWithMfa('sourcing2@jobwork.test');
    customer = await signIn('buyer@customer.test');
    otherSupplier = await signIn('other@supplier.test');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('admits organization, profile and first invitation in one transaction', async () => {
    const { profileId, organizationId, client } = await admitSupplier();

    const rows = await pg.query<{ status: string; type: string; invitations: string }>(
      `SELECT p.status, o.type,
              (SELECT count(*)::text FROM iam.invitation i WHERE i.organization_id = o.id)
                AS invitations
         FROM supplier.supplier_profile p
         JOIN iam.organization o ON o.id = p.organization_id
        WHERE p.id = $1`,
      [profileId],
    );
    expect(rows.rows[0]).toMatchObject({ status: 'onboarding', type: 'supplier', invitations: '1' });

    // The invited user reaches its own record and nothing else.
    const me = await client.get('/api/v1/suppliers/me');
    expect(me.status).toBe(200);
    expect((me.body['profile'] as Record<string, unknown>)['organizationId']).toBe(organizationId);
    expect(me.body['eligible']).toBe(false);

    const audit = await pg.query<{ action: string }>(
      `SELECT action FROM platform.audit_event WHERE subject_id = $1 OR subject_id = $2`,
      [profileId, organizationId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['supplier.admitted', 'iam.organization_created']),
    );
  });

  it('lets only an internal administrator admit a supplier', async () => {
    const body = {
      legalName: 'Backdoor Works Private Limited',
      displayName: 'Backdoor Works',
      regionClass: 'chennai_metro',
      primaryContactName: 'Nobody',
      primaryContactEmail: 'nobody@supplier.test',
      primaryContactPhone: '+91 90000 00000',
      firstUserEmail: 'nobody@supplier.test',
    };
    expect((await customer.post('/api/v1/suppliers', body)).status).toBe(403);
    expect((await otherSupplier.post('/api/v1/suppliers', body)).status).toBe(403);
    expect((await sourcing.post('/api/v1/suppliers', body)).status).toBe(403);

    const count = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM iam.organization WHERE display_name = 'Backdoor Works'`,
    );
    expect(count.rows[0]!.n).toBe('0');
  });

  it('refuses a second admission of the same legal identity, and writes nothing', async () => {
    const gstin = '33AABCU9603R1ZM';
    const first = await admitSupplier({ gstin });
    const before = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM supplier.supplier_profile`,
    );

    const duplicate = await admin.post('/api/v1/suppliers', {
      legalName: 'Anand Engineering Works Private Limited',
      displayName: 'Anand Engineering Works',
      regionClass: 'chennai_metro',
      primaryContactName: 'V. Anand',
      primaryContactEmail: 'second@supplier.test',
      primaryContactPhone: '+91 90000 22222',
      firstUserEmail: 'second@supplier.test',
      gstin,
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body['code']).toBe('SUPPLIER_IDENTITY_IN_USE');
    // The refusal names where the identity already lives, so the admin can go there.
    expect(duplicate.body['detail']).toContain('Anand Engineering');

    const after = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM supplier.supplier_profile`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(first.profileId).toBeDefined();
  });

  it('refuses submission while a blocking row stands, and names the rows', async () => {
    const { client } = await admitSupplier();

    const early = await client.get('/api/v1/suppliers/me');
    expect(early.body['canSubmit']).toBe(false);
    const refused = await client.post('/api/v1/suppliers/me/submit', {
      expectedVersion: (early.body['profile'] as Record<string, unknown>)['aggregateVersion'],
    });
    expect(refused.status).toBe(422);
    expect(refused.body['code']).toBe('ONBOARDING_INCOMPLETE');
    expect(refused.body['detail']).toContain('Works address');

    await describeSelf(client);
    await proveEvidence(client);

    const ready = await client.get('/api/v1/suppliers/me');
    expect(ready.body['canSubmit']).toBe(true);
    expect((ready.body['checklist'] as Array<Record<string, unknown>>).every((row) => !row['blocking'])).toBe(
      true,
    );
  });

  it('keeps the decision separate from the submission, and re-checks it at decision time', async () => {
    const { profileId, client } = await admitSupplier();
    await describeSelf(client);
    await proveEvidence(client);
    const submitted = await submitFile(client);
    const profile = submitted['profile'] as Record<string, unknown>;
    expect(profile['status']).toBe('submitted');

    // The supplier cannot admit itself, whatever it sends.
    const selfApproval = await client.post(`/api/v1/suppliers/${profileId}/approve`, {
      expectedVersion: profile['aggregateVersion'],
    });
    expect(selfApproval.status).toBe(403);

    // Evidence that lapses between submission and decision stops the decision: what was
    // true on Friday is not what the reviewer is signing on Monday.
    await pg.query(
      `UPDATE supplier.verification_item SET expires_at = now() - interval '1 minute'
        WHERE supplier_profile_id = $1 AND kind = 'gst'`,
      [profileId],
    );
    const stale = await sourcing.post(`/api/v1/suppliers/${profileId}/approve`, {
      expectedVersion: profile['aggregateVersion'],
    });
    expect(stale.status).toBe(422);
    expect(stale.body['code']).toBe('ONBOARDING_INCOMPLETE');

    await pg.query(
      `UPDATE supplier.verification_item SET expires_at = now() + interval '365 days'
        WHERE supplier_profile_id = $1 AND kind = 'gst'`,
      [profileId],
    );
    const approved = await sourcing.post(`/api/v1/suppliers/${profileId}/approve`, {
      expectedVersion: profile['aggregateVersion'],
    });
    expect(approved.status).toBe(201);
    expect((approved.body['profile'] as Record<string, unknown>)['status']).toBe('active');
    expect(approved.body['eligible']).toBe(true);
  });

  it('demands a reason for every negative outcome and keeps the evidence intact', async () => {
    const { profileId, client } = await admitSupplier();
    await describeSelf(client);
    await proveEvidence(client);
    let profile = (await submitFile(client))['profile'] as Record<string, unknown>;

    const reasonless = await sourcing.post(`/api/v1/suppliers/${profileId}/return`, {
      expectedVersion: profile['aggregateVersion'],
    });
    expect(reasonless.status).toBe(400);
    expect(reasonless.body['code']).toBe('VALIDATION_FAILED');

    const returned = await sourcing.post(`/api/v1/suppliers/${profileId}/return`, {
      expectedVersion: profile['aggregateVersion'],
      reason: 'Send a legible bank letter, the scan is cut off',
    });
    expect(returned.status).toBe(201);
    const returnedProfile = returned.body['profile'] as Record<string, unknown>;
    expect(returnedProfile['status']).toBe('onboarding');
    expect(returnedProfile['decisionReason']).toContain('legible');
    // Returning the file does not undo any evidence the supplier already proved.
    expect((returned.body['verification'] as unknown[]).length).toBeGreaterThanOrEqual(3);
    expect(returned.body['canSubmit']).toBe(true);

    profile = (await submitFile(client))['profile'] as Record<string, unknown>;
    const rejected = await sourcingTwo.post(`/api/v1/suppliers/${profileId}/reject`, {
      expectedVersion: profile['aggregateVersion'],
      reason: 'No quality system and no plan to build one',
    });
    expect(rejected.status).toBe(201);
    expect((rejected.body['profile'] as Record<string, unknown>)['status']).toBe('rejected');

    // A rejected supplier is not silently re-approvable: it must come back through
    // submission, which the state machine enforces.
    const sneak = await sourcing.post(`/api/v1/suppliers/${profileId}/approve`, {
      expectedVersion: (rejected.body['profile'] as Record<string, unknown>)['aggregateVersion'],
    });
    expect(sneak.status).toBe(409);
    expect(sneak.body['code']).toBe('SUPPLIER_STATE_INVALID');
  });

  it('suspends out of the cards immediately and reinstates without touching evidence', async () => {
    const { profileId, client } = await admitSupplier();
    await describeSelf(client);
    await proveEvidence(client);
    const submitted = (await submitFile(client))['profile'] as Record<string, unknown>;
    const approved = await sourcing.post(`/api/v1/suppliers/${profileId}/approve`, {
      expectedVersion: submitted['aggregateVersion'],
    });
    const active = approved.body['profile'] as Record<string, unknown>;

    const before = await pg.query<{ id: string; status: string; version_no: number; reviewed_by: string }>(
      `SELECT id, status, version_no, reviewed_by FROM supplier.verification_item
        WHERE supplier_profile_id = $1 ORDER BY kind`,
      [profileId],
    );

    const suspended = await sourcing.post(`/api/v1/suppliers/${profileId}/suspend`, {
      expectedVersion: active['aggregateVersion'],
      reason: 'Two late deliveries under investigation',
    });
    expect(suspended.status).toBe(201);
    expect(suspended.body['eligible']).toBe(false);
    expect(suspended.body['exclusions']).toContain('profile_not_active');

    const cards = await customer.get('/api/v1/capability-cards?capabilityCodes=cnc_turning');
    const serialized = JSON.stringify(cards.body);
    expect(serialized).not.toContain('Anand Engineering');

    const reinstated = await sourcing.post(`/api/v1/suppliers/${profileId}/reinstate`, {
      expectedVersion: (suspended.body['profile'] as Record<string, unknown>)['aggregateVersion'],
    });
    expect(reinstated.status).toBe(201);
    expect(reinstated.body['eligible']).toBe(true);

    const after = await pg.query<{ id: string; status: string; version_no: number; reviewed_by: string }>(
      `SELECT id, status, version_no, reviewed_by FROM supplier.verification_item
        WHERE supplier_profile_id = $1 ORDER BY kind`,
      [profileId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('keeps every supplier surface inside the audience it belongs to', async () => {
    const { profileId, client } = await admitSupplier();
    await describeSelf(client);

    // No supplier reads another supplier's record, or the internal directory.
    expect((await otherSupplier.get(`/api/v1/suppliers/${profileId}`)).status).toBe(403);
    expect((await client.get(`/api/v1/suppliers/${profileId}`)).status).toBe(403);
    expect((await client.get('/api/v1/suppliers')).status).toBe(403);
    expect((await customer.get('/api/v1/suppliers')).status).toBe(403);
    expect((await customer.get(`/api/v1/suppliers/${profileId}`)).status).toBe(403);
    // A customer has no supplier profile of its own to read either.
    expect((await customer.get('/api/v1/suppliers/me')).status).toBe(403);

    // No supplier may decide anything, including about itself.
    expect(
      (await client.post(`/api/v1/suppliers/${profileId}/suspend`, {
        expectedVersion: 1,
        reason: 'Trying it on',
      })).status,
    ).toBe(403);

    const directory = await sourcing.get('/api/v1/suppliers');
    expect(directory.status).toBe(200);
    const row = (directory.body['suppliers'] as Array<Record<string, unknown>>).find(
      (r) => r['supplierProfileId'] === profileId,
    );
    expect(row).toMatchObject({ status: 'onboarding', eligible: false });
    expect(row!['blockingCount']).toBeGreaterThan(0);
  });

  it('computes the same checklist from the same facts, and blocks the instant evidence expires', async () => {
    const { profileId, client } = await admitSupplier();
    await describeSelf(client);
    await proveEvidence(client);

    const first = await client.get('/api/v1/suppliers/me');
    const second = await client.get('/api/v1/suppliers/me');
    expect(first.body['checklist']).toEqual(second.body['checklist']);

    const gstRow = (first.body['checklist'] as Array<Record<string, unknown>>).find(
      (row) => row['key'] === 'verification_gst',
    );
    expect(gstRow).toMatchObject({ state: 'complete', blocking: false });

    // No sweep runs here: the stored date is the truth, and the checklist reads it.
    await pg.query(
      `UPDATE supplier.verification_item SET expires_at = now() - interval '1 second'
        WHERE supplier_profile_id = $1 AND kind = 'gst'`,
      [profileId],
    );
    const after = await client.get('/api/v1/suppliers/me');
    const expired = (after.body['checklist'] as Array<Record<string, unknown>>).find(
      (row) => row['key'] === 'verification_gst',
    );
    expect(expired).toMatchObject({ blocking: true });
    expect(after.body['canSubmit']).toBe(false);
  });
});
