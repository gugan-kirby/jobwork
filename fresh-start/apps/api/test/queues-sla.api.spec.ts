import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { mintServiceToken, SCAN_WORKER_PRINCIPAL, SERVICE_TOKEN_HEADER } from '@jobwork/service-auth';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'queues-sla-password-1';
const SERVICE_SECRET = 'test-service-token-secret';
const QUEUE = 'supplier_applications_received';

type Body = Record<string, unknown>;

interface StayRow {
  id: string;
  status: string;
  clock_started_at: Date;
  waiting_since: Date;
  due_at: Date | null;
  due_version: number;
  escalation_level: number;
  assignee_user_id: string | null;
  aggregate_version: number;
}

/**
 * F-11.1: work queues, service targets and escalation (doc 07 §11; UC-38). The queue
 * under test is "Workshops asking to join": its members arrive through the public form,
 * so every case starts from a real API path rather than an inserted row.
 *
 * Before anything opens, the queue's policy is re-published as if it had been in force
 * for a month (so backdated arrivals can be overdue), and the calendar is published as
 * every day, all day, so working minutes track the wall clock whatever time the suite runs.
 */
describe('Work queues and SLA escalation (F-11.1)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let admin: TestClient;
  let sourcing1: TestClient;
  let sourcing2: TestClient;
  let quality: TestClient;
  let customer: TestClient;
  const ids: Record<string, string> = {};

  const one = async <T>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;

  function totp(secret: string, email: string): string {
    return new OTPAuth.TOTP({ issuer: 'JobWork', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  }

  async function seedOrg(type: string, name: string): Promise<string> {
    return (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ($1, $2, $2) RETURNING id`, [type, name])).id;
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

  async function service(path: string, body?: unknown): Promise<{ status: number; body: Body }> {
    const headers: Record<string, string> = { [SERVICE_TOKEN_HEADER]: mintServiceToken(SERVICE_SECRET, SCAN_WORKER_PRINCIPAL.name) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${baseUrl}/api/v1/internal/${path}`, { method: 'POST', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Body) : {} };
  }

  async function sweep(): Promise<Body> {
    const res = await service('sla/sweep');
    expect(res.status).toBe(201);
    return res.body;
  }

  async function apply(companyName: string): Promise<string> {
    const res = await new TestClient(baseUrl).post('/api/v1/public/supplier-applications', {
      companyName,
      contactName: 'Owner',
      email: `${companyName.toLowerCase().replace(/[^a-z]+/g, '.')}@works.test`,
      processCodes: ['cnc_milling'],
      acceptTerms: true,
    });
    expect(res.status).toBe(201);
    return res.body['applicationId'] as string;
  }

  async function stays(subjectId: string): Promise<StayRow[]> {
    return (await pg.query<StayRow>(
      `SELECT id, status, clock_started_at, waiting_since, due_at, due_version, escalation_level, assignee_user_id, aggregate_version
         FROM platform.queue_assignment WHERE queue_key = $1 AND subject_id = $2 ORDER BY opened_at`,
      [QUEUE, subjectId],
    )).rows;
  }

  async function openStay(subjectId: string): Promise<StayRow> {
    const open = (await stays(subjectId)).filter((s) => s.status === 'open');
    expect(open).toHaveLength(1);
    return open[0]!;
  }

  async function escalations(stayId: string): Promise<Array<{ step: number; due_version: number; notify: string }>> {
    return (await pg.query<{ step: number; due_version: number; notify: string }>(
      `SELECT step, due_version, notify FROM platform.sla_escalation WHERE queue_assignment_id = $1 ORDER BY fired_at, step`,
      [stayId],
    )).rows;
  }

  const allDay = { timeZone: 'Asia/Kolkata', workingDays: [1, 2, 3, 4, 5, 6, 7], dayStart: '00:00', dayEnd: '23:59' };
  const localDate = (offsetDays: number): string =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offsetDays * 86_400_000));

  async function publishCalendar(holidays: string[], reason: string): Promise<{ status: number; body: Body }> {
    const current = await one<{ version: number }>(`SELECT version FROM platform.business_calendar_version WHERE calendar_key = 'chennai' AND status = 'active'`);
    return admin.post('/api/v1/sla/calendars/chennai/versions', { ...allDay, holidays, reason, expectedVersion: current.version });
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_queues_sla');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = SERVICE_SECRET;
    process.env['OPERATIONS_URL'] = 'https://ops.jobwork.test';
    process.env['NODE_ENV'] = 'test';

    pg = new Client({ connectionString: db.url });
    await pg.connect();
    const internalOrg = await seedOrg('internal', 'JobWork Operations');
    const customerOrg = await seedOrg('customer', 'Kovai Pumps');
    ids['admin'] = await seedUser(internalOrg, 'admin@jobwork.test', 'Admin', ['platform_admin']);
    ids['sourcing1'] = await seedUser(internalOrg, 'priya@jobwork.test', 'Priya', ['jobwork_sourcing']);
    ids['sourcing2'] = await seedUser(internalOrg, 'ravi@jobwork.test', 'Ravi', ['jobwork_sourcing']);
    ids['quality'] = await seedUser(internalOrg, 'qa@jobwork.test', 'Quality', ['jobwork_quality']);
    await seedUser(customerOrg, 'buyer@kovai.test', 'Buyer', ['customer_requester']);

    // The applications target as if it had been in force for a month (see the suite note).
    await pg.query(`UPDATE platform.sla_policy_version SET status = 'retired', retired_at = now() WHERE policy_key = $1`, [QUEUE]);
    await pg.query(
      `INSERT INTO platform.sla_policy_version (policy_key, version, calendar_key, target_minutes, escalation_steps, reason, activated_at)
       SELECT policy_key, 2, calendar_key, target_minutes, escalation_steps, 'In force for a month (test)', now() - interval '30 days'
         FROM platform.sla_policy_version WHERE policy_key = $1 AND version = 1`,
      [QUEUE],
    );

    ({ app, baseUrl } = await createTestApp());
    admin = await signIn('admin@jobwork.test', true);
    sourcing1 = await signIn('priya@jobwork.test', true);
    sourcing2 = await signIn('ravi@jobwork.test', true);
    quality = await signIn('qa@jobwork.test', true);
    customer = await signIn('buyer@kovai.test', false);

    const published = await publishCalendar([], 'Every day, all day, for the suite');
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({ calendarKey: 'chennai', version: 2, workingDays: [1, 2, 3, 4, 5, 6, 7] });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('opens one stay per member, closes departed ones, and gives a return a new clock', async () => {
    const alpha = await apply('Alpha Works');
    const beta = await apply('Beta Forge');
    const first = await sweep();
    expect(first['opened']).toBe(2);
    const alphaStay = await openStay(alpha);
    expect(alphaStay.due_at).not.toBeNull();
    expect(alphaStay.clock_started_at.getTime()).toBe(alphaStay.waiting_since.getTime());

    expect(await sweep()).toMatchObject({ opened: 0, closed: 0 });

    const declined = await sourcing1.post(`/api/v1/supplier-applications/${beta}/decline`, { reason: 'No machining capacity listed' });
    expect(declined.status).toBe(201);
    expect((await sweep())['closed']).toBe(1);
    expect((await stays(beta)).map((s) => s.status)).toEqual(['closed']);

    // The same application back in the queue is a second stay, clocked from its return.
    const before = Date.now();
    await pg.query(`UPDATE supplier.network_application SET status = 'received', decided_by = NULL, decided_at = NULL, decision_reason = '' WHERE id = $1`, [beta]);
    expect((await sweep())['opened']).toBe(1);
    const history = await stays(beta);
    expect(history.map((s) => s.status)).toEqual(['closed', 'open']);
    expect(history[1]!.clock_started_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(history[1]!.clock_started_at.getTime()).toBeGreaterThan(history[1]!.waiting_since.getTime());
    ids['alpha'] = alpha;
  });

  it('counts on the command center exactly what the queue lists', async () => {
    const summary = await sourcing1.get('/api/v1/operations/summary');
    const view = await sourcing1.get('/api/v1/queues');
    expect(view.status).toBe(200);
    const counted = (summary.body['queues'] as Array<{ key: string; count: number }>).find((q) => q.key === QUEUE)!.count;
    const listed = (view.body['items'] as Array<{ queueKey: string }>).filter((i) => i.queueKey === QUEUE).length;
    const overview = (view.body['queues'] as Array<{ key: string; count: number; targetMinutes: number }>).find((q) => q.key === QUEUE)!;
    expect(listed).toBe(counted);
    expect(overview).toMatchObject({ count: counted, targetMinutes: 1620 });
  });

  it('fires the last due step once, however many sweeps race', async () => {
    const late = await apply('Delta Castings');
    await pg.query(`UPDATE supplier.network_application SET created_at = now() - interval '10 days' WHERE id = $1`, [late]);
    const results = await Promise.all([sweep(), sweep(), sweep()]);
    expect(results.reduce((n, r) => n + (r['escalated'] as number), 0)).toBe(1);

    const stay = await openStay(late);
    // Ten days late is past both steps; only the last one fires (no storm of stale "due" notices).
    expect(await escalations(stay.id)).toEqual([{ step: 2, due_version: 1, notify: 'escalation' }]);
    expect(stay.escalation_level).toBe(2);
    const events = await pg.query<{ data: Body }>(`SELECT data FROM platform.outbox_event WHERE event_type = 'platform.sla_escalated.v1' AND aggregate_id = $1`, [stay.id]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.data).toMatchObject({ queueKey: QUEUE, step: 2, notify: 'escalation', reference: 'Application' });
    const audits = await pg.query(`SELECT 1 FROM platform.audit_event WHERE action = 'queue.sla_escalated' AND subject_id = $1`, [stay.id]);
    expect(audits.rowCount).toBe(1);

    expect((await sweep())['escalated']).toBe(0);
  });

  it('tells only the owner when an item falls due, and the notice names the record, never the workshop', async () => {
    const gamma = await apply('Gamma Precision');
    await pg.query(`UPDATE supplier.network_application SET created_at = now() - interval '30 hours' WHERE id = $1`, [gamma]);
    // Taken before any sweep has seen it: taking opens the stay itself.
    const taken = await sourcing1.post(`/api/v1/queues/${QUEUE}/items/${gamma}/take`, { expectedVersion: null });
    expect(taken.status).toBe(201);
    expect(taken.body).toMatchObject({ assignee: { userId: ids['sourcing1'], displayName: 'Priya' }, state: 'overdue', reference: 'Application', title: 'Gamma Precision' });

    // Thirty hours is past the 27-hour target and short of twice it.
    expect((await sweep())['escalated']).toBe(1);
    const stay = await openStay(gamma);
    expect(await escalations(stay.id)).toEqual([{ step: 1, due_version: 1, notify: 'owner' }]);

    const event = await one<{ id: string }>(`SELECT id FROM platform.outbox_event WHERE event_type = 'platform.sla_escalated.v1' AND aggregate_id = $1`, [stay.id]);
    const dispatched = await service('notifications/dispatch', { eventId: event.id });
    expect(dispatched.status).toBe(201);
    const notices = await pg.query<{ recipient_user_id: string; title: string; body: string; link: string }>(
      `SELECT recipient_user_id, title, body, link FROM communication.notification WHERE source_event_id = $1`,
      [event.id],
    );
    expect(notices.rows.map((n) => n.recipient_user_id)).toEqual([ids['sourcing1']]);
    expect(notices.rows[0]).toMatchObject({ title: 'Application is due — Workshops asking to join' });
    expect(notices.rows[0]!.link).toContain(`/queues?queue=${QUEUE}`);
    expect(JSON.stringify([notices.rows, dispatched.body])).not.toContain('Gamma');
    ids['gamma'] = gamma;
  });

  it('moves open deadlines when the calendar changes, and fires again only for the new deadline', async () => {
    const before = await openStay(ids['gamma']!);
    // A declared holiday on every day the item has waited: its deadline moves out.
    const holidays = [localDate(-2), localDate(-1), localDate(0)];
    expect((await publishCalendar(holidays, 'Cyclone holiday declared by the state')).status).toBe(201);
    const moved = await sweep();
    expect(moved['rescheduled']).toBeGreaterThanOrEqual(1);
    const after = await openStay(ids['gamma']!);
    expect(after.due_version).toBe(before.due_version + 1);
    expect(after.escalation_level).toBe(0);
    expect(after.due_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await escalations(after.id)).toEqual([{ step: 1, due_version: 1, notify: 'owner' }]);
    const audit = await pg.query(`SELECT data FROM platform.audit_event WHERE action = 'queue.deadline_rescheduled' AND subject_id = $1`, [after.id]);
    expect(audit.rowCount).toBe(1);

    // The holiday withdrawn: the deadline is back in the past, a new deadline, and its step fires once.
    expect((await publishCalendar([], 'Holiday withdrawn')).status).toBe(201);
    await sweep();
    const again = await openStay(ids['gamma']!);
    expect(again.due_version).toBe(after.due_version + 1);
    expect(await escalations(again.id)).toEqual([
      { step: 1, due_version: 1, notify: 'owner' },
      { step: 1, due_version: again.due_version, notify: 'owner' },
    ]);
    await sweep();
    expect(await escalations(again.id)).toHaveLength(2);
  });

  it('hands items over by audited commands under version, to people who work the queue', async () => {
    const epsilon = await apply('Epsilon Tools');
    const taken = await sourcing1.post(`/api/v1/queues/${QUEUE}/items/${epsilon}/take`, { expectedVersion: null });
    expect(taken.status).toBe(201);
    const v1 = taken.body['assignmentVersion'] as number;

    const grab = await sourcing2.post(`/api/v1/queues/${QUEUE}/items/${epsilon}/take`, { expectedVersion: v1 });
    expect(grab.status).toBe(409);
    expect(grab.body).toMatchObject({ code: 'QUEUE_ITEM_ASSIGNED', title: 'Priya has this item' });
    expect((await sourcing2.post(`/api/v1/queues/${QUEUE}/items/${epsilon}/release`, { expectedVersion: v1 })).body['code']).toBe('QUEUE_ITEM_NOT_YOURS');
    expect((await sourcing2.post(`/api/v1/queues/${QUEUE}/items/${epsilon}/reassign`, { assigneeUserId: ids['sourcing2'], expectedVersion: v1 })).status).toBe(400);

    const covered = await sourcing2.post(`/api/v1/queues/${QUEUE}/items/${epsilon}/reassign`, {
      assigneeUserId: ids['sourcing2'],
      reason: 'Covering while Priya is on leave',
      expectedVersion: v1,
    });
    expect(covered.status).toBe(201);
    expect(covered.body['assignee']).toMatchObject({ userId: ids['sourcing2'] });
    const v2 = covered.body['assignmentVersion'] as number;
    const audit = await one<{ reason: string; data: Body; actor_id: string }>(
      `SELECT reason, data, actor_id FROM platform.audit_event WHERE action = 'queue.item_reassigned' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit).toMatchObject({ reason: 'Covering while Priya is on leave', actor_id: ids['sourcing2'], data: { from: ids['sourcing1'], to: ids['sourcing2'], queueKey: QUEUE } });

    // Stale version, and a person outside the queue's roles.
    expect((await sourcing1.post(`/api/v1/queues/${QUEUE}/items/${epsilon}/reassign`, { assigneeUserId: ids['sourcing1'], reason: 'Back now', expectedVersion: v1 })).body['code']).toBe('VERSION_CONFLICT');
    const outsider = await sourcing2.post(`/api/v1/queues/${QUEUE}/items/${epsilon}/reassign`, { assigneeUserId: ids['quality'], reason: 'Please look', expectedVersion: v2 });
    expect(outsider.status).toBe(422);
    expect(outsider.body['code']).toBe('QUEUE_ASSIGNEE_NOT_ELIGIBLE');

    // Handing it to someone else tells them; taking it yourself tells nobody.
    const handed = await sourcing2.post(`/api/v1/queues/${QUEUE}/items/${epsilon}/reassign`, { assigneeUserId: ids['sourcing1'], reason: 'Back from leave', expectedVersion: v2 });
    expect(handed.status).toBe(201);
    const handover = await pg.query<{ data: Body }>(`SELECT data FROM platform.outbox_event WHERE event_type = 'platform.queue_item_reassigned.v1'`);
    expect(handover.rows).toHaveLength(1);
    expect(handover.rows[0]!.data).toMatchObject({ assigneeUserId: ids['sourcing1'], reference: 'Application' });

    const released = await sourcing1.post(`/api/v1/queues/${QUEUE}/items/${epsilon}/release`, { expectedVersion: handed.body['assignmentVersion'] });
    expect(released.status).toBe(201);
    expect(released.body['assignee']).toBeNull();
    ids['epsilon'] = epsilon;
  });

  it('keeps queues to JobWork, each to the roles that work it', async () => {
    expect((await customer.get('/api/v1/queues')).status).toBe(403);
    expect((await customer.get('/api/v1/sla')).status).toBe(403);
    const qa = await quality.get('/api/v1/queues');
    expect(qa.status).toBe(200);
    const keys = (qa.body['queues'] as Array<{ key: string }>).map((q) => q.key);
    expect(keys).toContain('milestones_to_verify');
    expect(keys).not.toContain(QUEUE);
    expect((qa.body['items'] as Array<{ queueKey: string }>).some((i) => i.queueKey === QUEUE)).toBe(false);
    expect((await quality.post(`/api/v1/queues/${QUEUE}/items/${ids['alpha']}/take`, { expectedVersion: null })).status).toBe(403);
    expect((await sourcing1.get('/api/v1/queues/not_a_queue/assignees')).body['code']).toBe('QUEUE_NOT_FOUND');
    const assignees = await sourcing1.get(`/api/v1/queues/${QUEUE}/assignees`);
    expect((assignees.body['assignees'] as Array<{ displayName: string }>).map((a) => a.displayName)).toEqual(['Admin', 'Priya', 'Ravi']);

    // The calendar is published by a platform administrator, under version, in a real zone.
    expect((await sourcing1.post('/api/v1/sla/calendars/chennai/versions', { ...allDay, holidays: [], reason: 'Not mine to change', expectedVersion: 4 })).status).toBe(403);
    expect((await admin.post('/api/v1/sla/calendars/chennai/versions', { ...allDay, timeZone: 'Asia/Mumbai', holidays: [], reason: 'Wrong zone', expectedVersion: 4 })).body['code']).toBe('CALENDAR_INVALID');
    expect((await admin.post('/api/v1/sla/calendars/chennai/versions', { ...allDay, holidays: [], reason: 'Stale', expectedVersion: 1 })).body['code']).toBe('VERSION_CONFLICT');
    expect((await admin.post('/api/v1/sla/calendars/pune/versions', { ...allDay, holidays: [], reason: 'Unknown', expectedVersion: 1 })).status).toBe(404);
    const config = await sourcing1.get('/api/v1/sla');
    expect(config.body['calendars']).toEqual([expect.objectContaining({ calendarKey: 'chennai', version: 4, timeZone: 'Asia/Kolkata' })]);
    expect((config.body['policies'] as Array<{ policyKey: string }>).map((p) => p.policyKey)).toContain(QUEUE);
  });

  it('refuses to take an item that has left the queue', async () => {
    await sourcing1.post(`/api/v1/supplier-applications/${ids['epsilon']}/decline`, { reason: 'Outside our region' });
    const res = await sourcing1.post(`/api/v1/queues/${QUEUE}/items/${ids['epsilon']}/take`, { expectedVersion: null });
    expect(res.status).toBe(404);
    expect(res.body['code']).toBe('QUEUE_ITEM_NOT_FOUND');
  });
});
