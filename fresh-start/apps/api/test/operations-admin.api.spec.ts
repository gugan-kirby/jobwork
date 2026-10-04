import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'operations-admin-password-1';
const SESSION_COOKIE = 'jw_session';

/**
 * F-OPS: the administration surface and the work summary. The cases here are about the
 * two properties an operations console lives or dies by — every action has a mirror, and
 * a number is only shown to somebody who can act on it.
 */
describe('Operations console administration (F-OPS)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let admin: TestClient; // platform_admin
  let security: TestClient; // security_admin
  let sourcing: TestClient; // jobwork_sourcing — a queue worker, not an administrator
  let customer: TestClient;
  let customerOrgId: string;
  let customerUserId: string;
  let customerMembershipId: string;

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

  async function seedUser(
    orgId: string,
    email: string,
    roles: string[],
  ): Promise<{ userId: string; membershipId: string }> {
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
    return { userId: user.rows[0]!.id, membershipId: membership.rows[0]!.id };
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

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_opsadmin');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['SESSION_COOKIE_NAME'] = SESSION_COOKIE;
    process.env['NODE_ENV'] = 'test';

    pg = new Client({ connectionString: db.url });
    await pg.connect();
    const internalOrgId = await seedOrg('internal', 'JobWork Operations');
    customerOrgId = await seedOrg('customer', 'Demo Pumps');
    await seedUser(internalOrgId, 'admin@jobwork.test', ['platform_admin']);
    await seedUser(internalOrgId, 'security@jobwork.test', ['security_admin']);
    await seedUser(internalOrgId, 'sourcing@jobwork.test', ['jobwork_sourcing']);
    const seeded = await seedUser(customerOrgId, 'buyer@customer.test', ['customer_requester']);
    customerUserId = seeded.userId;
    customerMembershipId = seeded.membershipId;

    ({ app, baseUrl } = await createTestApp());
    admin = await signInWithMfa('admin@jobwork.test');
    security = await signInWithMfa('security@jobwork.test');
    sourcing = await signInWithMfa('sourcing@jobwork.test');
    customer = await signIn('buyer@customer.test');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('keeps administration to administrators', async () => {
    for (const client of [customer, sourcing]) {
      expect((await client.get('/api/v1/admin/organizations')).status).toBe(403);
      expect((await client.get(`/api/v1/admin/organizations/${customerOrgId}`)).status).toBe(403);
      expect(
        (await client.post(`/api/v1/admin/users/${customerUserId}/reinstate`, {})).status,
      ).toBe(403);
      expect(
        (await client.post(`/api/v1/admin/organizations/${customerOrgId}/suspend`, {
          reason: 'trying it on',
        })).status,
      ).toBe(403);
    }
    expect((await admin.get('/api/v1/admin/organizations')).status).toBe(200);
    expect((await security.get('/api/v1/admin/organizations')).status).toBe(200);
  });

  it('creates a customer organization with its first invitation in one step', async () => {
    const created = await admin.post('/api/v1/admin/organizations', {
      type: 'customer',
      legalName: 'Kovai Hydraulics Private Limited',
      displayName: 'Kovai Hydraulics',
      firstUserEmail: 'ops@kovai.test',
      firstUserRoleKeys: ['org_admin'],
    });
    expect(created.status).toBe(201);
    const organizationId = created.body['organizationId'] as string;
    expect(created.body['invitationId']).toBeDefined();

    const detail = await admin.get(`/api/v1/admin/organizations/${organizationId}`);
    expect(detail.status).toBe(200);
    expect(detail.body['organization']).toMatchObject({
      displayName: 'Kovai Hydraulics',
      type: 'customer',
      status: 'active',
      memberCount: 0,
      pendingInvitationCount: 1,
    });
    const invitations = detail.body['invitations'] as Array<Record<string, unknown>>;
    expect(invitations).toHaveLength(1);
    expect(invitations[0]).toMatchObject({ email: 'ops@kovai.test', expired: false });

    // A supplier is admitted through its own command, which also builds the profile.
    const asSupplier = await admin.post('/api/v1/admin/organizations', {
      type: 'supplier',
      legalName: 'Wrong Route Works',
      displayName: 'Wrong Route',
    });
    expect(asSupplier.status).toBe(400);
  });

  it('resends an invitation by replacing it, never by running two live links', async () => {
    const created = await admin.post('/api/v1/admin/organizations', {
      type: 'customer',
      legalName: 'Resend Test Private Limited',
      displayName: 'Resend Test',
      firstUserEmail: 'first@resend.test',
    });
    const organizationId = created.body['organizationId'] as string;
    const invitationId = created.body['invitationId'] as string;
    const firstToken = new URL(created.body['acceptUrl'] as string).searchParams.get('token');

    const resent = await admin.post(
      `/api/v1/admin/organizations/${organizationId}/invitations/${invitationId}/resend`,
      {},
    );
    expect(resent.status).toBe(201);
    const secondToken = new URL(resent.body['acceptUrl'] as string).searchParams.get('token');
    expect(secondToken).not.toBe(firstToken);

    const stale = new TestClient(baseUrl);
    const staleAttempt = await stale.post('/api/v1/invitations/accept', {
      token: firstToken,
      displayName: 'Too Late',
      password: PASSWORD,
    });
    expect(staleAttempt.status).toBe(410);

    const fresh = new TestClient(baseUrl);
    const accepted = await fresh.post('/api/v1/invitations/accept', {
      token: secondToken,
      displayName: 'First User',
      password: PASSWORD,
    });
    expect(accepted.status).toBe(201);

    // Exactly one live invitation existed at any point, and it is consumed now.
    const detail = await admin.get(`/api/v1/admin/organizations/${organizationId}`);
    expect(detail.body['invitations']).toHaveLength(0);
    expect((detail.body['organization'] as Record<string, unknown>)['activeMemberCount']).toBe(1);
  });

  it('mirrors every suspension with a reinstatement, and refuses self-suspension', async () => {
    // Nobody loses access without a recorded reason.
    const bare = await admin.post(`/api/v1/admin/memberships/${customerMembershipId}/suspend`, {});
    expect(bare.status).toBe(400);
    // Membership: suspended, sessions revoked, then reinstated.
    const suspended = await admin.post(
      `/api/v1/admin/memberships/${customerMembershipId}/suspend`,
      { reason: 'Shared their login with a contractor' },
    );
    expect(suspended.status).toBe(201);
    const why = await pg.query<{ reason: string }>(
      `SELECT reason FROM platform.audit_event WHERE action = 'iam.membership_suspended' AND subject_id = $1`,
      [customerMembershipId],
    );
    expect(why.rows.map((r) => r.reason)).toEqual(['Shared their login with a contractor']);
    expect((await customer.get('/api/v1/auth/me')).status).toBe(401);

    const reinstated = await admin.post(
      `/api/v1/admin/memberships/${customerMembershipId}/reinstate`,
      { reason: 'Suspended in error' },
    );
    expect(reinstated.status).toBe(201);
    const membership = await pg.query<{ status: string }>(
      `SELECT status FROM iam.membership WHERE id = $1`,
      [customerMembershipId],
    );
    expect(membership.rows[0]!.status).toBe('active');
    // The reinstatement does not resurrect the revoked session; they sign in again.
    const backIn = await signIn('buyer@customer.test');
    expect((await backIn.get('/api/v1/auth/me')).status).toBe(200);

    // User: same shape, and reinstating an active account is refused rather than ignored.
    expect((await admin.post(`/api/v1/admin/users/${customerUserId}/suspend`, {})).status).toBe(400);
    expect((await admin.post(`/api/v1/admin/users/${customerUserId}/suspend`, { reason: 'Account under review' })).status).toBe(201);
    expect((await admin.post(`/api/v1/admin/users/${customerUserId}/reinstate`, {})).status).toBe(
      201,
    );
    const again = await admin.post(`/api/v1/admin/users/${customerUserId}/reinstate`, {});
    expect(again.status).toBe(409);
    expect(again.body['code']).toBe('USER_NOT_SUSPENDED');

    const audit = await pg.query<{ action: string }>(
      `SELECT action FROM platform.audit_event
        WHERE action LIKE 'iam.%reinstated' OR action LIKE 'iam.%suspended'`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'iam.membership_suspended',
        'iam.membership_reinstated',
        'iam.user_suspended',
        'iam.user_reinstated',
      ]),
    );
  });

  it('suspends an organization out of the product and back into it', async () => {
    const created = await admin.post('/api/v1/admin/organizations', {
      type: 'customer',
      legalName: 'Paused Customer Private Limited',
      displayName: 'Paused Customer',
    });
    const organizationId = created.body['organizationId'] as string;
    await seedUser(organizationId, 'user@paused.test', ['customer_requester']);
    const user = await signIn('user@paused.test');
    expect((await user.get('/api/v1/auth/me')).status).toBe(200);

    const reasonless = await admin.post(`/api/v1/admin/organizations/${organizationId}/suspend`, {});
    expect(reasonless.status).toBe(400);

    const suspended = await admin.post(`/api/v1/admin/organizations/${organizationId}/suspend`, {
      reason: 'Contract ended 2026-09-01',
    });
    expect(suspended.status).toBe(201);
    // A suspended organization cannot be worked in: a fresh sign-in has no organization
    // context to command with.
    const afterSuspension = await signIn('user@paused.test');
    const draft = await afterSuspension.post('/api/v1/enquiries/draft', { title: 'Should fail' });
    expect([401, 403]).toContain(draft.status);

    expect(
      (await admin.post(`/api/v1/admin/organizations/${organizationId}/reinstate`, {})).status,
    ).toBe(201);
    const listed = await admin.get('/api/v1/admin/organizations?type=customer');
    const row = (listed.body['organizations'] as Array<Record<string, unknown>>).find(
      (candidate) => candidate['organizationId'] === organizationId,
    );
    expect(row).toMatchObject({ status: 'active' });

    // Nobody suspends the organization they are signed into.
    const internalId = (
      await admin.get('/api/v1/admin/organizations?type=internal')
    ).body['organizations'] as Array<Record<string, unknown>>;
    const self = await admin.post(
      `/api/v1/admin/organizations/${internalId[0]!['organizationId'] as string}/suspend`,
      { reason: 'Should be refused' },
    );
    expect(self.status).toBe(403);
  });

  it('finds an organization\'s history wherever it is filed', async () => {
    const created = await admin.post('/api/v1/admin/organizations', {
      type: 'customer',
      legalName: 'History Works Private Limited',
      displayName: 'History Works',
      firstUserEmail: 'person@history.test',
    });
    const organizationId = created.body['organizationId'] as string;
    const seeded = await seedUser(organizationId, 'member@history.test', ['customer_requester']);
    await admin.post(`/api/v1/admin/memberships/${seeded.membershipId}/suspend`, { reason: 'Left the company' });

    // Filed under the membership, not the organization: a subject-id filter alone would
    // find the creation and miss the suspension, which is the half that matters.
    const narrow = await admin.get(
      `/api/v1/audit-events?subjectType=organization&subjectId=${organizationId}`,
    );
    const narrowActions = (narrow.body['events'] as Array<Record<string, unknown>>).map(
      (event) => event['action'],
    );
    expect(narrowActions).not.toContain('iam.membership_suspended');

    const whole = await admin.get(`/api/v1/audit-events?aboutOrganizationId=${organizationId}`);
    const wholeActions = (whole.body['events'] as Array<Record<string, unknown>>).map(
      (event) => event['action'],
    );
    expect(wholeActions).toEqual(
      expect.arrayContaining([
        'iam.organization_created',
        'iam.invitation_issued',
        'iam.membership_suspended',
      ]),
    );
  });

  it('shows an operator only the queues their roles can act on', async () => {
    const forSourcing = await sourcing.get('/api/v1/operations/summary');
    expect(forSourcing.status).toBe(200);
    const sourcingKeys = (forSourcing.body['queues'] as Array<Record<string, unknown>>).map(
      (queue) => queue['key'],
    );
    expect(sourcingKeys).toContain('supplier_files_awaiting_decision');
    // Invitations are an administration queue; a sourcing reviewer cannot act on them.
    expect(sourcingKeys).not.toContain('invitations_pending');

    const forSecurity = await security.get('/api/v1/operations/summary');
    const securityKeys = (forSecurity.body['queues'] as Array<Record<string, unknown>>).map(
      (queue) => queue['key'],
    );
    expect(securityKeys).toEqual(['invitations_pending']);

    // The count matches the queue it links to, rather than being computed differently.
    const pending = (forSecurity.body['queues'] as Array<Record<string, unknown>>)[0]!;
    const organizations = (await admin.get('/api/v1/admin/organizations')).body[
      'organizations'
    ] as Array<Record<string, unknown>>;
    const fromDirectory = organizations.reduce(
      (total, org) => total + (org['pendingInvitationCount'] as number),
      0,
    );
    expect(pending['count']).toBe(fromDirectory);

    // Signed in afresh: the suspension case above revoked this account's earlier session.
    const externalAgain = await signIn('buyer@customer.test');
    expect((await externalAgain.get('/api/v1/operations/summary')).status).toBe(403);
  });
});
