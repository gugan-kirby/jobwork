import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'supplier-network-password-1';
const SESSION_COOKIE = 'jw_session';

/**
 * F-SN: what happens after admission — renewal, availability, withdrawal and leaving.
 * The cases here guard the difference between "the supplier says it cannot take work"
 * and "JobWork stopped it", and the promise that a warning arrives before eligibility
 * is lost rather than after.
 */
describe('Supplier network life (F-SN)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let admin: TestClient; // internal platform_admin — admits
  let sourcing: TestClient; // internal jobwork_sourcing — decides
  let customer: TestClient;

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
    db = await createTestDatabase('jobwork_snetwork');
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
    customer = await signIn('buyer@customer.test');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  /** Admits a supplier and takes it all the way to active, the F-SO way. */
  async function activeSupplier(): Promise<{ profileId: string; client: TestClient }> {
    const { profileId, client } = await admitSupplier();
    await describeSelf(client);
    await proveEvidence(client);
    const submitted = (await submitFile(client))['profile'] as Record<string, unknown>;
    const approved = await sourcing.post(`/api/v1/suppliers/${profileId}/approve`, {
      expectedVersion: submitted['aggregateVersion'],
    });
    expect(approved.status).toBe(201);
    return { profileId, client };
  }

  it('lets a supplier take itself out of matching, and put itself back', async () => {
    const { profileId, client } = await activeSupplier();

    const paused = await client.post('/api/v1/suppliers/me/availability', {
      acceptingWork: false,
      note: 'Shutdown until Diwali',
      acceptingWorkUntil: '2026-11-15',
    });
    expect(paused.status).toBe(201);
    const profile = paused.body['profile'] as Record<string, unknown>;
    // The network status is untouched: this is the supplier speaking, not a suspension.
    expect(profile['status']).toBe('active');
    expect(profile['acceptingWork']).toBe(false);
    expect(paused.body['eligible']).toBe(false);
    expect(paused.body['exclusions']).toContain('supplier_unavailable');

    const cards = await customer.get('/api/v1/capability-cards?capabilityCodes=cnc_turning');
    expect(JSON.stringify(cards.body)).not.toContain('Anand Engineering');

    const resumed = await client.post('/api/v1/suppliers/me/availability', {
      acceptingWork: true,
      note: '',
    });
    expect(resumed.status).toBe(201);
    expect(resumed.body['eligible']).toBe(true);
    expect((resumed.body['profile'] as Record<string, unknown>)['acceptingWork']).toBe(true);
    expect(profileId).toBeDefined();
  });

  it('tells a supplier-side pause apart from a JobWork suspension', async () => {
    const { profileId, client } = await activeSupplier();
    const active = (await client.get('/api/v1/suppliers/me')).body['profile'] as Record<
      string,
      unknown
    >;

    const suspended = await sourcing.post(`/api/v1/suppliers/${profileId}/suspend`, {
      expectedVersion: active['aggregateVersion'],
      reason: 'Two late deliveries under investigation',
    });
    expect(suspended.status).toBe(201);
    expect(suspended.body['exclusions']).toContain('profile_not_active');
    expect(suspended.body['exclusions']).not.toContain('supplier_unavailable');

    // Availability is the supplier's to set; it is not a way out of a suspension.
    const attempt = await client.post('/api/v1/suppliers/me/availability', {
      acceptingWork: true,
      note: 'Please let us back in',
    });
    expect(attempt.status).toBe(201);
    expect((attempt.body['profile'] as Record<string, unknown>)['status']).toBe('paused');
    expect(attempt.body['eligible']).toBe(false);
  });

  it('withdraws a capability without losing what matching was done against', async () => {
    const { client } = await activeSupplier();
    const before = await client.get('/api/v1/suppliers/me/capabilities');
    const capability = (before.body['capabilities'] as Array<Record<string, unknown>>)[0]!;
    const capabilityId = capability['supplierCapabilityId'] as string;

    const withdrawn = await client.post(
      `/api/v1/suppliers/me/declarations/capability/${capabilityId}/withdraw`,
      { reason: 'Sold the lathe' },
    );
    expect(withdrawn.status).toBe(201);

    const after = await client.get('/api/v1/suppliers/me/capabilities');
    expect(after.body['capabilities']).toEqual([]);
    // Still readable in history, exactly as it was declared.
    const history = await client.get('/api/v1/suppliers/me/capabilities?history=true');
    const row = (history.body['capabilities'] as Array<Record<string, unknown>>).find(
      (item) => item['supplierCapabilityId'] === capabilityId,
    );
    expect(row).toMatchObject({ status: 'withdrawn', versionNo: capability['versionNo'] });

    // Withdrawing twice is refused rather than silently repeated.
    const again = await client.post(
      `/api/v1/suppliers/me/declarations/capability/${capabilityId}/withdraw`,
      { reason: 'Again' },
    );
    expect(again.status).toBe(409);
    expect(again.body['code']).toBe('DECLARATION_NOT_LIVE');

    // And no capability means no matching, which the projection states as a reason.
    const view = await client.get('/api/v1/suppliers/me');
    expect(view.body['exclusions']).toContain('no_published_capability');

    // Re-offering it later works: the version number continues from the highest ever,
    // not from the live row, which does not exist while the capability is withdrawn.
    const again2 = await client.post('/api/v1/suppliers/me/capabilities', {
      capabilityCode: 'cnc_turning',
      attributes: { toleranceClass: 'IT7' },
    });
    expect(again2.status).toBe(201);
    expect(again2.body['versionNo']).toBe((capability['versionNo'] as number) + 1);
    const back = await client.get('/api/v1/suppliers/me');
    expect(back.body['exclusions']).not.toContain('no_published_capability');
  });

  it('warns about evidence before it lapses, and counts it once it has', async () => {
    const { profileId, client } = await activeSupplier();

    // Thirty days out: still valid, and the supplier is told so with the date.
    await pg.query(
      `UPDATE supplier.verification_item SET expires_at = now() + interval '30 days'
        WHERE supplier_profile_id = $1 AND kind = 'gst'`,
      [profileId],
    );
    const warning = await client.get('/api/v1/suppliers/me/summary');
    expect(warning.status).toBe(200);
    const queues = new Map(
      (warning.body['queues'] as Array<Record<string, unknown>>).map((queue) => [
        queue['key'],
        queue,
      ]),
    );
    expect(queues.get('evidence_expiring')!['count']).toBe(1);
    expect(queues.get('evidence_expiring')!['nearestDate']).not.toBeNull();
    expect(queues.get('evidence_expired')!['count']).toBe(0);
    expect(warning.body['matchable']).toBe(true);

    const checklist = (await client.get('/api/v1/suppliers/me')).body['checklist'] as Array<
      Record<string, unknown>
    >;
    const gstRow = checklist.find((row) => row['key'] === 'verification_gst')!;
    // Not "Done": a row that says done while a date runs out is how eligibility is lost
    // silently. It warns, and it still does not block.
    expect(gstRow['state']).toBe('incomplete');
    expect(gstRow['blocking']).toBe(false);
    expect(gstRow['detail']).toContain('Expires');

    // Past the date: counted as lapsed, and out of matching.
    await pg.query(
      `UPDATE supplier.verification_item SET expires_at = now() - interval '1 day'
        WHERE supplier_profile_id = $1 AND kind = 'gst'`,
      [profileId],
    );
    const lapsed = await client.get('/api/v1/suppliers/me/summary');
    const lapsedQueues = new Map(
      (lapsed.body['queues'] as Array<Record<string, unknown>>).map((queue) => [
        queue['key'],
        queue,
      ]),
    );
    expect(lapsedQueues.get('evidence_expired')!['count']).toBe(1);
    expect(lapsed.body['matchable']).toBe(false);
  });

  it('keeps the summary to the supplier it belongs to', async () => {
    const { client } = await activeSupplier();
    expect((await client.get('/api/v1/suppliers/me/summary')).status).toBe(200);
    expect((await customer.get('/api/v1/suppliers/me/summary')).status).toBe(403);
    expect((await sourcing.get('/api/v1/suppliers/me/summary')).status).toBe(403);
  });

  it('makes leaving deliberate, terminal and audited from either side', async () => {
    const { client } = await activeSupplier();
    const profile = (await client.get('/api/v1/suppliers/me')).body['profile'] as Record<
      string,
      unknown
    >;

    // A click is not enough: the organization types its own name.
    const mistyped = await client.post('/api/v1/suppliers/me/exit', {
      confirmation: 'not the right name',
      reason: 'Closing the workshop',
    });
    expect(mistyped.status).toBe(422);
    expect(mistyped.body['code']).toBe('CONFIRMATION_MISMATCH');

    const left = await client.post('/api/v1/suppliers/me/exit', {
      confirmation: profile['displayName'],
      reason: 'Closing the workshop',
    });
    expect(left.status).toBe(201);
    expect((left.body['profile'] as Record<string, unknown>)['status']).toBe('exited');
    expect(left.body['eligible']).toBe(false);

    // Terminal: not a pause somebody can undo by setting availability.
    const undo = await client.post('/api/v1/suppliers/me/availability', {
      acceptingWork: true,
      note: 'Changed our minds',
    });
    expect(undo.status).toBe(409);

    const audit = await pg.query<{ action: string; reason: string | null }>(
      `SELECT action, reason FROM platform.audit_event WHERE action = 'supplier.exited'`,
    );
    expect(audit.rows[0]).toMatchObject({ action: 'supplier.exited' });
    expect(audit.rows[0]!.reason).toContain('Closing');
  });

  it('lets JobWork offboard a supplier, with the same confirmation', async () => {
    const { profileId, client } = await activeSupplier();
    const profile = (await client.get('/api/v1/suppliers/me')).body['profile'] as Record<
      string,
      unknown
    >;

    expect(
      (await sourcing.post(`/api/v1/suppliers/${profileId}/exit`, {
        confirmation: 'wrong',
        reason: 'Contract ended',
      })).status,
    ).toBe(422);

    const offboarded = await sourcing.post(`/api/v1/suppliers/${profileId}/exit`, {
      confirmation: profile['displayName'],
      reason: 'Contract ended 2026-09-01',
    });
    expect(offboarded.status).toBe(201);
    expect((offboarded.body['profile'] as Record<string, unknown>)['status']).toBe('exited');

    // The supplier still sees its own record, and what happened to it.
    const theirView = await client.get('/api/v1/suppliers/me');
    expect((theirView.body['profile'] as Record<string, unknown>)['status']).toBe('exited');
  });
});
