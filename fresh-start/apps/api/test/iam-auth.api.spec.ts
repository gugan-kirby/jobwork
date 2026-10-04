import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'admin-test-password-1';
const SESSION_COOKIE = 'jw_session';

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

describe('IAM authentication and authorization (doc 20 §13)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_iam');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SESSION_COOKIE_NAME'] = SESSION_COOKIE;
    process.env['NODE_ENV'] = 'test';

    pg = new Client({ connectionString: db.url });
    await pg.connect();

    // Fixture: internal org + admin (the protected bootstrap path, as in the dev seed).
    const org = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ('internal', 'JobWork', 'JobWork Operations') RETURNING id`,
    );
    const user = await pg.query<{ id: string }>(
      `INSERT INTO iam.user_account (email, password_hash, password_params_version, display_name, status, email_verified_at)
       VALUES ($1, $2, 1, 'Admin', 'active', now()) RETURNING id`,
      [ADMIN_EMAIL, await hashPassword(ADMIN_PASSWORD)],
    );
    const membership = await pg.query<{ id: string }>(
      `INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`,
      [user.rows[0]?.id, org.rows[0]?.id],
    );
    for (const role of ['platform_admin', 'security_admin', 'org_admin']) {
      await pg.query(
        `INSERT INTO iam.membership_role (membership_id, role_id)
         SELECT $1, id FROM iam.role WHERE key = $2`,
        [membership.rows[0]?.id, role],
      );
    }

    ({ app, baseUrl } = await createTestApp());
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  // ---- enumeration and lockout ----

  it('returns byte-identical problems for unknown email and wrong password (AUTH-11)', async () => {
    const client = new TestClient(baseUrl);
    const unknown = await client.post('/api/v1/auth/login', {
      email: 'nobody@test.local',
      password: 'whatever-password-1',
    });
    const wrongPassword = await client.post('/api/v1/auth/login', {
      email: ADMIN_EMAIL,
      password: 'wrong-password-123',
    });
    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    const strip = (b: Record<string, unknown>) => {
      const { correlationId: _c, ...rest } = b;
      return rest;
    };
    expect(strip(unknown.body)).toEqual(strip(wrongPassword.body));
    expect(unknown.body['code']).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after repeated failures (AUTH-12)', async () => {
    await pg.query(
      `INSERT INTO iam.user_account (email, password_hash, password_params_version, display_name, status, email_verified_at)
       VALUES ('lockme@test.local', $1, 1, 'Lock', 'active', now())`,
      [await hashPassword('correct-password-12')],
    );
    const client = new TestClient(baseUrl);
    for (let i = 0; i < 5; i += 1) {
      await client.post('/api/v1/auth/login', {
        email: 'lockme@test.local',
        password: 'wrong-password-123',
      });
    }
    const locked = await client.post('/api/v1/auth/login', {
      email: 'lockme@test.local',
      password: 'correct-password-12',
    });
    expect(locked.status).toBe(423);
    expect(locked.body['code']).toBe('ACCOUNT_LOCKED');
  });

  // ---- the full admin journey: login, AUTH-15 gate, MFA, invite, accept ----

  const admin = () => adminClient;
  let adminClient: TestClient;
  let customerOrgId: string;
  let acceptUrl: string;

  it('logs in the internal admin with organization context', async () => {
    adminClient = new TestClient(baseUrl);
    const res = await admin().post('/api/v1/auth/login', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(res.status).toBe(201);
    expect(res.body['mfaRequired']).toBe(false); // not enrolled yet
    expect(admin().cookie(SESSION_COOKIE)).toBeTruthy();

    const me = await admin().get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body['organizationType']).toBe('internal');
    expect(me.body['roles']).toContain('platform_admin');
  });

  it('rejects state changes without the CSRF header (doc 20 §6)', async () => {
    const res = await admin().post(
      '/api/v1/admin/organizations',
      { type: 'customer', legalName: 'ACME Industries', displayName: 'ACME' },
      { csrf: false },
    );
    expect(res.status).toBe(403);
    expect(res.body['code']).toBe('CSRF_REJECTED');
  });

  it('rejects cross-site origins', async () => {
    const res = await admin().post(
      '/api/v1/admin/organizations',
      { type: 'customer', legalName: 'ACME Industries', displayName: 'ACME' },
      { origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
  });

  it('blocks internal transactional commands before MFA enrollment (AUTH-15)', async () => {
    const res = await admin().post('/api/v1/admin/organizations', {
      type: 'customer',
      legalName: 'ACME Industries',
      displayName: 'ACME',
    });
    expect(res.status).toBe(403);
    expect(res.body['code']).toBe('MFA_ENROLLMENT_REQUIRED');
  });

  it('enrolls TOTP, receives recovery codes, and upgrades strength', async () => {
    const enroll = await admin().post('/api/v1/account/mfa/enroll');
    expect(enroll.status).toBe(201);
    const secret = enroll.body['secret'] as string;
    const activate = await admin().post('/api/v1/account/mfa/activate', {
      code: totpCode(secret, ADMIN_EMAIL),
    });
    expect(activate.status).toBe(201);
    expect((activate.body['recoveryCodes'] as string[]).length).toBe(10);

    const me = await admin().get('/api/v1/auth/me');
    expect(me.body['mfaEnrolled']).toBe(true);
    expect(me.body['authStrength']).toBe('password+totp');
  });

  it('challenges MFA on next login and rotates the session token on success', async () => {
    const fresh = new TestClient(baseUrl);
    const login = await fresh.post('/api/v1/auth/login', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(login.body['mfaRequired']).toBe(true);
    const pendingToken = fresh.cookie(SESSION_COOKIE);

    // pending session cannot reach normal routes
    const blocked = await fresh.get('/api/v1/auth/me');
    expect(blocked.status).toBe(401);
    expect(blocked.body['code']).toBe('MFA_CHALLENGE_REQUIRED');

    const secretRow = await pg.query<{ mfa_totp_secret: string }>(
      `SELECT mfa_totp_secret FROM iam.user_account WHERE email = $1`,
      [ADMIN_EMAIL],
    );
    const verify = await fresh.post('/api/v1/auth/mfa', {
      code: totpCode(secretRow.rows[0]?.mfa_totp_secret ?? '', ADMIN_EMAIL),
    });
    expect(verify.status).toBe(201);
    expect(fresh.cookie(SESSION_COOKIE)).not.toBe(pendingToken); // rotation

    // rotated-out token is dead
    const stale = new TestClient(baseUrl);
    stale.setCookie(SESSION_COOKIE, pendingToken ?? '');
    const staleRes = await stale.get('/api/v1/auth/me');
    expect(staleRes.status).toBe(401);

    const ok = await fresh.get('/api/v1/auth/me');
    expect(ok.status).toBe(200);
    adminClient = fresh;
  });

  it('creates a customer organization and issues an invitation', async () => {
    const org = await admin().post('/api/v1/admin/organizations', {
      type: 'customer',
      legalName: 'ACME Industries Pvt Ltd',
      displayName: 'ACME',
    });
    expect(org.status).toBe(201);
    customerOrgId = org.body['organizationId'] as string;

    const invite = await admin().post(`/api/v1/organizations/${customerOrgId}/invitations`, {
      email: 'buyer@acme.example',
      roleKeys: ['org_admin', 'customer_requester'],
    });
    expect(invite.status).toBe(201);
    acceptUrl = invite.body['acceptUrl'] as string;
    expect(acceptUrl).toContain('token=');
  });

  it('invite-member with the same Idempotency-Key returns the same invitation once (BR-SYS-04)', async () => {
    const key = 'invite-key-1';
    const first = await admin().request('POST', `/api/v1/organizations/${customerOrgId}/invitations`, {
      email: 'idem@acme.example',
      roleKeys: ['customer_requester'],
    });
    // manual header path: reuse request() with explicit header not supported — use fetch shape below
    expect(first.status).toBe(201);

    const doInvite = async () => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'idempotency-key': key,
        cookie: `jw_session=${admin().cookie('jw_session')}; jw_csrf=${admin().cookie('jw_csrf')}`,
        'x-csrf-token': admin().cookie('jw_csrf') ?? '',
      };
      const res = await fetch(`${baseUrl}/api/v1/organizations/${customerOrgId}/invitations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'idem2@acme.example', roleKeys: ['customer_requester'] }),
      });
      return (await res.json()) as { invitationId: string };
    };
    const a = await doInvite();
    const b = await doInvite();
    expect(b.invitationId).toBe(a.invitationId);

    const outbox = await pg.query(
      `SELECT count(*)::int AS n FROM platform.outbox_event
        WHERE event_type = 'iam.invitation.issued.v1' AND data->>'email' = 'idem2@acme.example'`,
    );
    expect(outbox.rows[0]?.n).toBe(1);

    const audit = await pg.query(
      `SELECT count(*)::int AS n FROM platform.audit_event
        WHERE action = 'iam.invitation_issued' AND subject_id = $1`,
      [a.invitationId],
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('rejects invitations proposing roles outside the organization type', async () => {
    const res = await admin().post(`/api/v1/organizations/${customerOrgId}/invitations`, {
      email: 'buyer2@acme.example',
      roleKeys: ['jobwork_finance'],
    });
    expect(res.status).toBe(400);
    expect(res.body['code']).toBe('VALIDATION_FAILED');
  });

  let memberClient: TestClient;

  it('accepts the invitation, creating account and membership atomically (AUTH-08)', async () => {
    const token = new URL(acceptUrl).searchParams.get('token') ?? '';
    const anon = new TestClient(baseUrl);

    const preview = await anon.get(`/api/v1/invitations/preview?token=${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body['organizationName']).toBe('ACME');

    const accept = await anon.post('/api/v1/invitations/accept', {
      token,
      password: 'buyer-strong-pass-1',
      displayName: 'Buyer One',
    });
    expect(accept.status).toBe(201);

    // single-use: second accept fails closed
    const again = await anon.post('/api/v1/invitations/accept', {
      token,
      password: 'buyer-strong-pass-1',
    });
    expect(again.status).toBe(410);
    expect(again.body['code']).toBe('INVITATION_INVALID');

    memberClient = new TestClient(baseUrl);
    const login = await memberClient.post('/api/v1/auth/login', {
      email: 'buyer@acme.example',
      password: 'buyer-strong-pass-1',
    });
    expect(login.status).toBe(201);
    const me = await memberClient.get('/api/v1/auth/me');
    expect(me.body['organizationId']).toBe(customerOrgId); // single membership auto-context
    expect(me.body['organizationType']).toBe('customer');
  });

  it('denies switching to an organization without membership (AUTH-04)', async () => {
    const internalOrg = await pg.query<{ id: string }>(
      `SELECT id FROM iam.organization WHERE type = 'internal'`,
    );
    const res = await memberClient.post('/api/v1/account/organization/switch', {
      organizationId: internalOrg.rows[0]?.id,
    });
    expect(res.status).toBe(403);
    expect(res.body['code']).toBe('MEMBERSHIP_NOT_FOUND');
  });

  it('external customer cannot invoke internal admin commands', async () => {
    const res = await memberClient.post('/api/v1/admin/organizations', {
      type: 'supplier',
      legalName: 'Sneaky Supplier',
      displayName: 'Sneaky',
    });
    expect(res.status).toBe(403);
  });

  it('suspending the membership revokes org sessions immediately (AUTH-06, FR-104)', async () => {
    const membership = await pg.query<{ id: string }>(
      `SELECT m.id FROM iam.membership m
        JOIN iam.user_account u ON u.id = m.user_id
       WHERE u.email = 'buyer@acme.example' AND m.organization_id = $1`,
      [customerOrgId],
    );
    const res = await admin().post(`/api/v1/admin/memberships/${membership.rows[0]?.id}/suspend`);
    expect(res.status).toBe(201);

    const afterSuspend = await memberClient.get('/api/v1/auth/me');
    expect(afterSuspend.status).toBe(401); // session revoked, not merely descoped
  });

  it('logout-all revokes every session for the user', async () => {
    const a = new TestClient(baseUrl);
    await a.post('/api/v1/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const secretRow = await pg.query<{ mfa_totp_secret: string }>(
      `SELECT mfa_totp_secret FROM iam.user_account WHERE email = $1`,
      [ADMIN_EMAIL],
    );
    await a.post('/api/v1/auth/mfa', {
      code: totpCode(secretRow.rows[0]?.mfa_totp_secret ?? '', ADMIN_EMAIL),
    });

    const sessions = await a.get('/api/v1/account/sessions');
    expect((sessions.body['sessions'] as unknown[]).length).toBeGreaterThanOrEqual(2);

    const out = await a.post('/api/v1/auth/logout-all');
    expect(out.status).toBe(201);

    const dead = await admin().get('/api/v1/auth/me');
    expect(dead.status).toBe(401);
  });
});
