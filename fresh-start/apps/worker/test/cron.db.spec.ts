import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { due, MAX_BATCHES_PER_RUN, runScheduled } from '../src/cron';

const MINUTE = 60_000;
/** A minute divisible by 15, so every sweep is due. */
const QUARTER_HOUR = 1_800_000_900_000 - (1_800_000_900_000 % (15 * MINUTE));

describe('cron schedule (F-CW.4)', () => {
  it('runs each sweep on the minutes its interval falls on', () => {
    expect(due(MINUTE, QUARTER_HOUR + 7 * MINUTE)).toBe(true);
    expect(due(5 * MINUTE, QUARTER_HOUR + 5 * MINUTE)).toBe(true);
    expect(due(5 * MINUTE, QUARTER_HOUR + 7 * MINUTE)).toBe(false);
    expect(due(15 * MINUTE, QUARTER_HOUR)).toBe(true);
    expect(due(15 * MINUTE, QUARTER_HOUR + 5 * MINUTE)).toBe(false);
    // Anything shorter than a minute runs every minute: that is a Cron Trigger's resolution.
    expect(due(2_000, QUARTER_HOUR + 3 * MINUTE)).toBe(true);
  });
});

describe('one Cron Trigger run (F-CW.4, F-CW.5)', () => {
  let db: TestDatabase;
  let pool: Pool;
  const calls: Array<{ path: string; body: unknown; principal: string | null }> = [];
  const api = {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      const text = await request.text();
      calls.push({ path, body: text ? JSON.parse(text) : undefined, principal: request.headers.get('x-service-token') });
      const reply = path.endsWith('/internal/mail') ? { outcome: 'recorded' } : {};
      return new Response(JSON.stringify(reply), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  };

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_cron');
    pool = new Pool({ connectionString: db.url });
    process.env['NODE_ENV'] = 'test';
    process.env['MAIL_TRANSPORT'] = 'api';
    process.env['LOG_LEVEL'] = 'silent';
  }, 60_000);

  afterAll(async () => {
    delete process.env['MAIL_TRANSPORT'];
    await pool.end();
    await db.drop();
  });

  it('hands mail to the API, runs the sweeps due this minute, and clears spent rate-limit counters', async () => {
    const event = await pool.query<{ id: string }>(
      `INSERT INTO platform.outbox_event (event_type, aggregate_type, aggregate_id, correlation_id, data)
       VALUES ('iam.invitation.issued.v1', 'invitation', 'inv-1', 'corr-cron-1', $1) RETURNING id`,
      [JSON.stringify({ invitationId: 'inv-1', organizationName: 'ACME', email: 'invitee@example.com', rawToken: 'raw-token-value' })],
    );
    await pool.query(
      `INSERT INTO platform.rate_limit_counter (key, window_index, count, expires_at)
       VALUES ('spent', 1, 3, now() - interval '1 hour'), ('live', 1, 3, now() + interval '1 hour')`,
    );

    const result = await runScheduled(QUARTER_HOUR, { HYPERDRIVE: { connectionString: db.url }, API: api });

    expect(result.handled).toBe(1);
    const stored = await pool.query<{ status: string; data: Record<string, unknown> }>(
      `SELECT status, data FROM platform.outbox_event WHERE id = $1`,
      [event.rows[0]!.id],
    );
    expect(stored.rows[0]!.status).toBe('delivered');
    // AUTH-09: once handed over, the raw token leaves the stored event.
    expect(stored.rows[0]!.data['rawToken']).toBeUndefined();

    const mail = calls.find((c) => c.path === '/api/v1/internal/mail');
    expect(mail?.body).toMatchObject({ to: 'invitee@example.com' });
    expect((mail?.body as { text: string }).text).toContain('raw-token-value');
    expect(mail?.principal).toBeTruthy();

    expect(calls.map((c) => c.path)).toEqual(
      expect.arrayContaining([
        '/api/v1/internal/suppliers/verification/sweep',
        '/api/v1/internal/rfqs/deadline-sweep',
        '/api/v1/internal/payments/reconcile-sweep',
        '/api/v1/internal/sla/sweep',
        '/api/v1/internal/deliveries/acceptance-sweep',
      ]),
    );
    const counters = await pool.query<{ key: string }>(`SELECT key FROM platform.rate_limit_counter ORDER BY key`);
    expect(counters.rows.map((r) => r.key)).toEqual(['live']);
  });

  it('runs only the every-minute sweep off the quarter hour, and stops at the batch limit', async () => {
    calls.length = 0;
    for (let i = 0; i < 40; i += 1) {
      await pool.query(
        `INSERT INTO platform.outbox_event (event_type, aggregate_type, aggregate_id, correlation_id, data)
         VALUES ('iam.platform_admin.bootstrapped.v1', 'user', $1, 'corr-cron-2', '{}')`,
        [`u-${i}`],
      );
    }

    const result = await runScheduled(QUARTER_HOUR + 7 * MINUTE, { HYPERDRIVE: { connectionString: db.url }, API: api });

    expect(result.handled).toBe(MAX_BATCHES_PER_RUN * 10);
    expect(calls.map((c) => c.path)).toEqual(['/api/v1/internal/sla/sweep']);
    const left = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM platform.outbox_event WHERE status = 'pending'`);
    expect(left.rows[0]!.n).toBe(40 - MAX_BATCHES_PER_RUN * 10);
  });
});
