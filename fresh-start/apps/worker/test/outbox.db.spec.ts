import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { createLogger } from '@jobwork/observability';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileMailer } from '../src/mailer';
import { invitationIssuedHandler } from '../src/outbox/handlers/invitation-issued';
import { DEFAULT_POLLER_OPTIONS, OutboxPoller, retryDelayMs } from '../src/outbox/poller';
import { HandlerRegistry } from '../src/outbox/registry';

const log = createLogger({ service: 'worker-test', level: 'silent' });

async function insertEvent(
  pool: Pool,
  eventType: string,
  data: Record<string, unknown>,
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO platform.outbox_event
       (event_type, aggregate_type, aggregate_id, correlation_id, data)
     VALUES ($1, 'test', 't1', 'corr-1', $2) RETURNING id`,
    [eventType, JSON.stringify(data)],
  );
  return res.rows[0]?.id ?? '';
}

describe('outbox poller', () => {
  let db: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_outbox');
    pool = new Pool({ connectionString: db.url, max: 8 });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('caps retry delay after jitter (doc 07 §10 corrected formula)', () => {
    const opts = { ...DEFAULT_POLLER_OPTIONS, baseDelayMs: 1000, capDelayMs: 5000 };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect(retryDelayMs(attempt, opts, () => 0.999)).toBeLessThanOrEqual(5000);
    }
  });

  it('delivers an invitation email and strips the raw token from stored data', async () => {
    const mailDir = mkdtempSync(join(tmpdir(), 'jobwork-mail-'));
    const registry = new HandlerRegistry().register(
      'iam.invitation.issued.v1',
      invitationIssuedHandler(new FileMailer(mailDir), 'http://localhost:3000'),
    );
    const poller = new OutboxPoller(pool, registry, log);
    const id = await insertEvent(pool, 'iam.invitation.issued.v1', {
      invitationId: 'inv-1',
      organizationName: 'ACME',
      email: 'invitee@example.com',
      rawToken: 'super-secret-token',
    });

    await poller.tick();

    const files = readdirSync(mailDir);
    expect(files.length).toBe(1);
    const mail = JSON.parse(readFileSync(join(mailDir, files[0] ?? ''), 'utf8')) as {
      to: string;
      text: string;
    };
    expect(mail.to).toBe('invitee@example.com');
    expect(mail.text).toContain('super-secret-token');

    const row = await pool.query(
      `SELECT status, data, delivered_at FROM platform.outbox_event WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]?.status).toBe('delivered');
    expect(row.rows[0]?.delivered_at).not.toBeNull();
    expect((row.rows[0]?.data as Record<string, unknown>)['rawToken']).toBeUndefined();
    expect((row.rows[0]?.data as Record<string, unknown>)['email']).toBe('invitee@example.com');
  });

  it('never processes an event twice under concurrent pollers (SKIP LOCKED)', async () => {
    const handled: string[] = [];
    const registry = new HandlerRegistry().register('race.v1', async (event) => {
      handled.push(event.id);
      await new Promise((r) => setTimeout(r, 20));
    });
    for (let i = 0; i < 12; i += 1) await insertEvent(pool, 'race.v1', { i });

    const a = new OutboxPoller(pool, registry, log);
    const b = new OutboxPoller(pool, registry, log);
    await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
    // drain any remainder
    await a.tick();

    expect(new Set(handled).size).toBe(handled.length);
    expect(handled.length).toBe(12);
  });

  it('retries with backoff and dead-letters after max attempts, without blocking others', async () => {
    let healthyRuns = 0;
    const registry = new HandlerRegistry()
      .register('poison.v1', async () => {
        throw new Error('boom');
      })
      .register('healthy.v1', async () => {
        healthyRuns += 1;
      });
    const opts = { ...DEFAULT_POLLER_OPTIONS, maxAttempts: 2, baseDelayMs: 1, capDelayMs: 2 };
    const poller = new OutboxPoller(pool, registry, log, opts);

    const poisonId = await insertEvent(pool, 'poison.v1', {});
    await insertEvent(pool, 'healthy.v1', {});

    await poller.tick(); // poison attempt 1 → retry scheduled; healthy delivered
    expect(healthyRuns).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    await poller.tick(); // poison attempt 2 → dead (attempts >= maxAttempts)

    const row = await pool.query(`SELECT status, last_error FROM platform.outbox_event WHERE id = $1`, [
      poisonId,
    ]);
    expect(row.rows[0]?.status).toBe('dead');
    expect(row.rows[0]?.last_error).toContain('boom');
  });

  it('reclaims stuck processing rows after the visibility timeout (crash recovery)', async () => {
    let runs = 0;
    const registry = new HandlerRegistry().register('stuck.v1', async () => {
      runs += 1;
    });
    const id = await insertEvent(pool, 'stuck.v1', {});
    // simulate a worker that claimed and died
    await pool.query(
      `UPDATE platform.outbox_event
          SET status = 'processing', locked_at = now() - interval '10 minutes', attempts = 1
        WHERE id = $1`,
      [id],
    );
    const poller = new OutboxPoller(pool, registry, log);
    await poller.tick();
    expect(runs).toBe(1);
    const row = await pool.query(`SELECT status FROM platform.outbox_event WHERE id = $1`, [id]);
    expect(row.rows[0]?.status).toBe('delivered');
  });

  it('parks events with no registered handler as dead with a clear error', async () => {
    const registry = new HandlerRegistry();
    const id = await insertEvent(pool, 'unknown.v1', {});
    const poller = new OutboxPoller(pool, registry, log);
    await poller.tick();
    const row = await pool.query(`SELECT status, last_error FROM platform.outbox_event WHERE id = $1`, [
      id,
    ]);
    expect(row.rows[0]?.status).toBe('dead');
    expect(row.rows[0]?.last_error).toContain('no handler');
  });
});
