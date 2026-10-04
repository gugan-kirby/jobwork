import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'registration-test-pw-1';

/**
 * Self-registration and supplier applications (F-MX.4). The shape of the prototype's
 * register screen, with the two corrections the docs require: a customer must prove
 * the email before signing in, and a supplier never gets an account from the form.
 */
describe('Registration and network applications (F-MX.4)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;
  let sourcing: TestClient;
  let admin: TestClient;

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

  async function seedInternal(email: string, roles: string[]): Promise<void> {
    const org = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ('internal', $1, $1) RETURNING id`,
      [`JobWork ${email}`],
    );
    const user = await pg.query<{ id: string }>(
      `INSERT INTO iam.user_account
         (email, password_hash, password_params_version, display_name, status, email_verified_at)
       VALUES ($1, $2, 1, 'Staff', 'active', now()) RETURNING id`,
      [email, await hashPassword(PASSWORD)],
    );
    const membership = await pg.query<{ id: string }>(
      `INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`,
      [user.rows[0]!.id, org.rows[0]!.id],
    );
    await pg.query(
      `INSERT INTO iam.membership_role (membership_id, role_id)
       SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`,
      [membership.rows[0]!.id, roles],
    );
  }

  async function signInWithMfa(email: string): Promise<TestClient> {
    const first = new TestClient(baseUrl);
    await first.post('/api/v1/auth/login', { email, password: PASSWORD });
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
    await fresh.post('/api/v1/auth/mfa', {
      code: totpCode(secret.rows[0]!.mfa_totp_secret, email),
    });
    return fresh;
  }

  function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      fullName: 'Jegadeesh T',
      mobile: '+91 98400 00000',
      email: 'jegadeesh@kovai.test',
      password: 'a-long-enough-password-1',
      organizationName: 'Kovai Pumps',
      acceptTerms: true,
      ...overrides,
    };
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_register');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['NODE_ENV'] = 'test';
    pg = new Client({ connectionString: db.url });
    await pg.connect();
    await seedInternal('sourcing@jobwork.test', ['jobwork_sourcing']);
    await seedInternal('admin@jobwork.test', ['platform_admin']);
    ({ app, baseUrl } = await createTestApp());
    sourcing = await signInWithMfa('sourcing@jobwork.test');
    admin = await signInWithMfa('admin@jobwork.test');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  // ---------------------------------------------------------------- customers

  it('registers a customer who cannot sign in until the email is verified, then owns the organization', async () => {
    const guest = new TestClient(baseUrl);
    const res = await guest.post('/api/v1/auth/register', registration());
    expect(res.status).toBe(201);
    expect(res.body['organizationId']).toBeTruthy();
    const verifyUrl = res.body['verifyUrl'] as string;
    expect(verifyUrl).toContain('/verify-email?token=');

    // Nothing is signed in and the account is not yet usable.
    const early = await new TestClient(baseUrl).post('/api/v1/auth/login', {
      email: 'jegadeesh@kovai.test',
      password: 'a-long-enough-password-1',
    });
    expect(early.status).toBe(401);

    // The mail went out through the outbox, with the token to be stripped after send.
    const outbox = await pg.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM platform.outbox_event WHERE event_type = 'iam.email_verification.issued.v1'`,
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]!.data['email']).toBe('jegadeesh@kovai.test');

    const token = new URL(verifyUrl).searchParams.get('token')!;
    const verified = await guest.post('/api/v1/auth/verify-email', { token });
    expect(verified.status).toBe(201);
    // A second click on the same link is refused, not silently accepted.
    const again = await guest.post('/api/v1/auth/verify-email', { token });
    expect(again.status).toBe(410);
    expect(again.body['code']).toBe('VERIFICATION_INVALID');

    const client = new TestClient(baseUrl);
    const login = await client.post('/api/v1/auth/login', {
      email: 'jegadeesh@kovai.test',
      password: 'a-long-enough-password-1',
    });
    expect(login.status).toBe(201);
    const me = await client.get('/api/v1/auth/me');
    expect(me.body['organizationType']).toBe('customer');
    expect(me.body['phone']).toBe('+91 98400 00000');
    expect((me.body['roles'] as string[]).sort()).toEqual(
      ['customer_approver', 'customer_requester', 'org_admin'].sort(),
    );
    const org = me.body['memberships'] as Array<{ organizationName: string }>;
    expect(org[0]!.organizationName).toBe('Kovai Pumps');

    // And they can do the thing the account exists for.
    const draft = await client.post('/api/v1/enquiries/draft', { title: 'First enquiry' });
    expect(draft.status).toBe(201);

    // Profile edit (F-MX.8) lands on the same record.
    const edit = await client.post('/api/v1/account/profile', {
      displayName: 'Jegadeesh Thangavel',
      phone: '9840000001',
    });
    expect(edit.status).toBe(201);
    const after = await client.get('/api/v1/auth/me');
    expect(after.body['displayName']).toBe('Jegadeesh Thangavel');
    expect(after.body['phone']).toBe('9840000001');
  });

  it('refuses a second registration on the same email with a stable code', async () => {
    const res = await new TestClient(baseUrl).post('/api/v1/auth/register', registration());
    expect(res.status).toBe(409);
    expect(res.body['code']).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('refuses a weak password, unaccepted terms and a bad verification token', async () => {
    const weak = await new TestClient(baseUrl).post(
      '/api/v1/auth/register',
      registration({ email: 'weak@kovai.test', password: 'short' }),
    );
    expect(weak.status).toBe(400);
    expect((weak.body['errors'] as Array<{ path: string }>).map((e) => e.path)).toContain('password');

    const terms = await new TestClient(baseUrl).post(
      '/api/v1/auth/register',
      registration({ email: 'noterms@kovai.test', acceptTerms: false }),
    );
    expect(terms.status).toBe(400);

    const bogus = await new TestClient(baseUrl).post('/api/v1/auth/verify-email', {
      token: 'not-a-real-token-at-all-0000',
    });
    expect(bogus.status).toBe(410);

    // No half-registration survived any of the refusals.
    const users = await pg.query(
      `SELECT 1 FROM iam.user_account WHERE email IN ('weak@kovai.test', 'noterms@kovai.test')`,
    );
    expect(users.rowCount).toBe(0);
  });

  // ---------------------------------------------------------------- suppliers

  it('takes a supplier application anonymously without creating an account', async () => {
    const guest = new TestClient(baseUrl);
    const res = await guest.post('/api/v1/public/supplier-applications', {
      companyName: 'MechPro Engineers',
      contactName: 'R. Kumar',
      email: 'kumar@mechpro.test',
      phone: '9840011111',
      city: 'Chennai',
      processCodes: ['cnc_milling', 'vmc_machining'],
      note: 'Three VMCs, 24-hour shift.',
      acceptTerms: true,
    });
    expect(res.status).toBe(201);
    expect(res.body['applicationId']).toBeTruthy();

    const users = await pg.query(`SELECT 1 FROM iam.user_account WHERE email = 'kumar@mechpro.test'`);
    expect(users.rowCount).toBe(0);
    const orgs = await pg.query(`SELECT 1 FROM iam.organization WHERE type = 'supplier'`);
    expect(orgs.rowCount).toBe(0);

    // A process the taxonomy does not know is refused, not stored as free text.
    const unknown = await guest.post('/api/v1/public/supplier-applications', {
      companyName: 'Mystery Works',
      contactName: 'Xavier',
      email: 'x@mystery.test',
      processCodes: ['quantum_milling'],
      acceptTerms: true,
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body['code']).toBe('CAPABILITY_UNKNOWN');

    // The queue is JobWork's, not the public's.
    expect((await guest.get('/api/v1/supplier-applications')).status).toBe(401);
  });

  it('lets sourcing see and decline applications, and lets admission close one atomically', async () => {
    const list = await sourcing.get('/api/v1/supplier-applications?status=received');
    expect(list.status).toBe(200);
    const apps = list.body['applications'] as Array<Record<string, unknown>>;
    expect(apps).toHaveLength(1);
    const applicationId = apps[0]!['applicationId'] as string;
    expect(apps[0]!['companyName']).toBe('MechPro Engineers');

    // The home-queue count agrees with the list.
    const summary = await sourcing.get('/api/v1/operations/summary');
    const queue = (summary.body['queues'] as Array<{ key: string; count: number }>).find(
      (q) => q.key === 'supplier_applications_received',
    );
    expect(queue?.count).toBe(1);

    // A decline needs a reason.
    const noReason = await sourcing.post(`/api/v1/supplier-applications/${applicationId}/decline`, {
      reason: '',
    });
    expect(noReason.status).toBe(400);

    // Admission by platform admin closes the application with the organization it made.
    const admitted = await admin.post('/api/v1/suppliers', {
      legalName: 'MechPro Engineers Private Limited',
      displayName: 'MechPro Engineers',
      regionClass: 'chennai_metro',
      primaryContactName: 'R. Kumar',
      primaryContactEmail: 'kumar@mechpro.test',
      firstUserEmail: 'kumar@mechpro.test',
      applicationId,
    });
    expect(admitted.status).toBe(201);
    const after = await sourcing.get(`/api/v1/supplier-applications/${applicationId}`);
    expect(after.body['status']).toBe('admitted');
    expect(after.body['admittedOrganizationId']).toBe(admitted.body['organizationId']);

    // Decided once: a second admission or a decline finds nothing to decide.
    const twice = await admin.post('/api/v1/suppliers', {
      legalName: 'MechPro Again',
      displayName: 'MechPro Again',
      regionClass: 'chennai_metro',
      primaryContactName: 'R. Kumar',
      primaryContactEmail: 'kumar2@mechpro.test',
      firstUserEmail: 'kumar2@mechpro.test',
      applicationId,
    });
    expect(twice.status).toBe(409);
    expect(twice.body['code']).toBe('APPLICATION_ALREADY_DECIDED');
    // The refused admission rolled back entirely: one supplier organization, not two.
    const orgs = await pg.query(`SELECT count(*)::int AS n FROM iam.organization WHERE type = 'supplier'`);
    expect(orgs.rows[0]!.n).toBe(1);

    const declined = await sourcing.post(`/api/v1/supplier-applications/${applicationId}/decline`, {
      reason: 'Changed our minds',
    });
    expect(declined.status).toBe(409);
  });

  it('declines with a reason the application keeps', async () => {
    const created = await new TestClient(baseUrl).post('/api/v1/public/supplier-applications', {
      companyName: 'Backyard Lathe',
      contactName: 'Selvam',
      email: 's@backyard.test',
      acceptTerms: true,
    });
    const id = created.body['applicationId'] as string;
    const declined = await sourcing.post(`/api/v1/supplier-applications/${id}/decline`, {
      reason: 'No registered works address and no GST.',
    });
    expect(declined.status).toBe(201);
    expect(declined.body['status']).toBe('declined');
    expect(declined.body['decisionReason']).toBe('No registered works address and no GST.');
  });
});
