import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { idShapedLabelValues } from '@jobwork/observability';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { ControlsRepository } from '../src/modules/operations/infrastructure/controls.repository';
import { MetricsService } from '../src/platform/metrics/metrics.service';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'metrics-controls-password-1';
const METRICS_PORT = 19_000 + Math.floor(Math.random() * 900);

type Body = Record<string, unknown>;

/** The value of the one series of `name` carrying every given label, in any order. */
function series(text: string, name: string, labels: Record<string, string>): number | null {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`)) continue;
    if (Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) return Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return null;
}

/**
 * F-11.3: what the platform tells its operators — RED and domain metrics on their own
 * port with no identifier in any label, the business-control panel role-filtered like
 * the command center, and the separation-of-duties rules biting at invitation and
 * surfacing combinations that predate them (doc 19 §9).
 */
describe('Metrics, controls panel and separation of duties (F-11.3)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;
  let internalOrg: string;
  let admin: TestClient;
  let sourcing: TestClient;
  let customer: TestClient;

  const one = async <T>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;

  function totp(secret: string, email: string): string {
    return new OTPAuth.TOTP({ issuer: 'JobWork', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  }

  async function seedUser(orgId: string, email: string, name: string, roles: string[]): Promise<string> {
    const user = await one<{ id: string }>(
      `INSERT INTO iam.user_account (email, password_hash, password_params_version, display_name, status, email_verified_at)
       VALUES ($1, $2, 1, $3, 'active', now()) RETURNING id`,
      [email, await hashPassword(PASSWORD), name],
    );
    const membership = await one<{ id: string }>(`INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`, [user.id, orgId]);
    await pg.query(`INSERT INTO iam.membership_role (membership_id, role_id) SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`, [membership.id, roles]);
    return user.id;
  }

  async function signIn(email: string, mfa: boolean): Promise<TestClient> {
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

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_metrics_controls');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['NODE_ENV'] = 'test';
    process.env['METRICS_PORT'] = String(METRICS_PORT);
    pg = new Client({ connectionString: db.url });
    await pg.connect();
    internalOrg = (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('internal', 'JobWork', 'JobWork') RETURNING id`)).id;
    const customerOrg = (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('customer', 'Kovai Pumps', 'Kovai Pumps') RETURNING id`)).id;
    await seedUser(internalOrg, 'admin@jobwork.test', 'Admin', ['platform_admin']);
    await seedUser(internalOrg, 'sourcing@jobwork.test', 'Sourcing', ['jobwork_sourcing']);
    await seedUser(customerOrg, 'buyer@kovai.test', 'Buyer', ['customer_requester']);
    // Combinations that predate the rules: surfaced, not silently tolerated.
    await seedUser(internalOrg, 'both@jobwork.test', 'Sales and Finance', ['jobwork_sales', 'jobwork_finance']);
    await seedUser(internalOrg, 'audit@jobwork.test', 'Auditor', ['auditor', 'jobwork_quality']);
    ({ app, baseUrl } = await createTestApp());
    admin = await signIn('admin@jobwork.test', true);
    sourcing = await signIn('sourcing@jobwork.test', true);
    customer = await signIn('buyer@kovai.test', false);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
    delete process.env['METRICS_PORT'];
  });

  it('serves metrics on their own port, never on the API listener', async () => {
    const scraped = await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`);
    expect(scraped.status).toBe(200);
    expect(await scraped.text()).toContain('http_server_request_duration_seconds');
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/v1/metrics`)).status).toBe(404);
  });

  it('measures requests by route template and caller, with no identifier in any label', async () => {
    const applied = await new TestClient(baseUrl).post('/api/v1/public/supplier-applications', {
      companyName: 'Label Works', contactName: 'Owner', email: 'owner@labelworks.test', processCodes: ['cnc_milling'], acceptTerms: true,
    });
    expect(applied.status).toBe(201);
    await sourcing.get(`/api/v1/supplier-applications/${applied.body['applicationId'] as string}`);
    await customer.get('/api/v1/enquiries/01a107c5-eb3e-7049-9996-e254da3b4004');
    await new TestClient(baseUrl).get('/api/v1/no/such/route/01a107c5-eb3e-7049-9996-e254da3b4004');
    await new TestClient(baseUrl).post('/api/v1/auth/login', { email: 'nobody@kovai.test', password: 'wrong-password-1' });

    // Scrapes share a 10-second snapshot; this one must see the application just made.
    await app.get(ControlsRepository).snapshot({ fresh: true });
    const text = await app.get(MetricsService).registry.metrics();
    expect(series(text, 'http_server_request_duration_seconds_count', { route: '/api/v1/supplier-applications/:applicationId', caller: 'internal' })).toBe(1);
    expect(series(text, 'http_server_request_duration_seconds_count', { route: '/api/v1/enquiries/:enquiryId', caller: 'customer', status_code: '404' })).toBe(1);
    expect(series(text, 'http_server_request_duration_seconds_count', { route: 'unmatched', status_code: '404' })).toBeGreaterThanOrEqual(1);
    expect(series(text, 'jobwork_auth_events_total', { event: 'login_failed' })).toBeGreaterThanOrEqual(1);
    expect(series(text, 'jobwork_queue_items', { queue: 'supplier_applications_received' })).toBe(1);
    expect(series(text, 'jobwork_outbox_events', { status: 'pending' })).not.toBeNull();
    expect(series(text, 'jobwork_db_pool_connections', { state: 'total' })).toBeGreaterThan(0);
    expect(text).toContain('jobwork_rate_limit_store_degraded');
    expect(idShapedLabelValues(text)).toEqual([]);
  });

  it('shows each reader the controls for their own queues, and platform signals to administrators only', async () => {
    expect((await customer.get('/api/v1/operations/controls')).status).toBe(403);

    const mine = await sourcing.get('/api/v1/operations/controls');
    expect(mine.status).toBe(200);
    expect(mine.body['platform']).toBeNull();
    expect(mine.body['separationOfDuties']).toBeNull();
    const queue = (mine.body['queues'] as Body[]).find((q) => q['key'] === 'supplier_applications_received');
    expect(queue).toMatchObject({ count: 1, overdue: 0, targetMinutes: 1620 });
    expect((mine.body['queues'] as Body[]).some((q) => q['key'] === 'payments_unmatched')).toBe(false);

    const all = await admin.get('/api/v1/operations/controls');
    expect(all.body['platform']).toMatchObject({ outbox: { dead: 0 }, scan: { backlog: 0 }, rateLimitStoreDegraded: false });
  });

  it('refuses to grant a forbidden combination, and surfaces the ones that already exist', async () => {
    const refused = await admin.post(`/api/v1/organizations/${internalOrg}/invitations`, { email: 'new.person@jobwork.test', roleKeys: ['jobwork_sales', 'jobwork_finance'] });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'ROLE_CONFLICT', detail: 'Sales may not release its own credit or payment exceptions.' });
    expect((await admin.post(`/api/v1/organizations/${internalOrg}/invitations`, { email: 'new.person@jobwork.test', roleKeys: ['jobwork_sales'] })).status).toBe(201);
    // Adding to what a member already holds is judged on the combination.
    const adding = await admin.post(`/api/v1/organizations/${internalOrg}/invitations`, { email: 'sourcing@jobwork.test', roleKeys: ['auditor'] });
    expect(adding.body['code']).toBe('ROLE_CONFLICT');

    const sod = (await admin.get('/api/v1/operations/controls')).body['separationOfDuties'] as { rules: Body[]; conflicts: Body[] };
    expect(sod.rules.map((r) => r['key'])).toEqual(['sales_with_finance', 'finance_with_quality', 'auditor_with_any']);
    expect(sod.conflicts.map((c) => [c['email'], c['rules']])).toEqual([
      ['audit@jobwork.test', ['auditor_with_any']],
      ['both@jobwork.test', ['sales_with_finance']],
    ]);
  });

  it('replays or dismisses a dead letter with a reason, audited, and never shows its payload (F-11.4)', async () => {
    const dead = async (type: string, error: string): Promise<string> =>
      (await one<{ id: string }>(
        `INSERT INTO platform.outbox_event (event_type, aggregate_type, aggregate_id, correlation_id, data, status, attempts, last_error)
         VALUES ($1, 'supplier_profile', gen_random_uuid()::text, 'corr-dead', '{"contactEmail":"owner@anand.test"}', 'dead', 8, $2) RETURNING id`,
        [type, error],
      )).id;
    const first = await dead('supplier.approved.v1', 'no handler registered for supplier.approved.v1');
    const second = await dead('iam.invitation.issued.v1', 'smtp rejected recipient new.person@kovai.test after 98400 11122 retries');

    expect((await sourcing.get('/api/v1/operations/dead-letters')).status).toBe(403);
    const listed = await admin.get('/api/v1/operations/dead-letters');
    const letters = listed.body['deadLetters'] as Body[];
    expect(letters.map((l) => l['eventType'])).toEqual(['supplier.approved.v1', 'iam.invitation.issued.v1']);
    expect(JSON.stringify(letters)).not.toMatch(/anand\.test|kovai\.test|contactEmail/);
    expect(letters[1]!['lastError']).toBe('smtp rejected recipient [e-mail] after [number] retries');

    expect((await admin.post(`/api/v1/operations/dead-letters/${first}/replay`, {})).status).toBe(400);
    const replayed = await admin.post(`/api/v1/operations/dead-letters/${first}/replay`, { reason: 'Handler registered in F-11.3' });
    expect(replayed.body).toEqual({ eventId: first, status: 'pending' });
    expect(await one(`SELECT status, attempts FROM platform.outbox_event WHERE id = $1`, [first])).toEqual({ status: 'pending', attempts: 0 });
    expect((await admin.post(`/api/v1/operations/dead-letters/${first}/replay`, { reason: 'Again' })).body['code']).toBe('DEAD_LETTER_NOT_FOUND');

    expect((await sourcing.post(`/api/v1/operations/dead-letters/${second}/dismiss`, { reason: 'Not mine' })).status).toBe(403);
    expect((await admin.post(`/api/v1/operations/dead-letters/${second}/dismiss`, { reason: 'Invitation re-sent by hand' })).body['status']).toBe('dismissed');
    const audit = await pg.query<{ action: string; reason: string }>(
      `SELECT action, reason FROM platform.audit_event WHERE subject_type = 'outbox_event' ORDER BY occurred_at`,
    );
    expect(audit.rows).toEqual([
      { action: 'platform.outbox_replayed', reason: 'Handler registered in F-11.3' },
      { action: 'platform.outbox_dismissed', reason: 'Invitation re-sent by hand' },
    ]);
    expect(((await admin.get('/api/v1/operations/dead-letters')).body['deadLetters'] as Body[])).toEqual([]);
  });
});
