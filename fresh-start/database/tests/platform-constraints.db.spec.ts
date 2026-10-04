import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_platdb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

describe('platform schema constraints', () => {
  let pg: Client;

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
  }, 60_000);

  afterAll(async () => {
    await pg.end();
    const admin = new Client({ connectionString: new URL('/postgres', BASE_URL).toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('audit events are append-only at the database layer (BR-SYS-05)', async () => {
    await pg.query(
      `INSERT INTO platform.audit_event (actor_type, action, subject_type, subject_id, correlation_id)
       VALUES ('system', 'test.created', 'test', 't1', 'corr-1')`,
    );
    await expect(
      pg.query(`UPDATE platform.audit_event SET action = 'tampered' WHERE subject_id = 't1'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      pg.query(`DELETE FROM platform.audit_event WHERE subject_id = 't1'`),
    ).rejects.toThrow(/append-only/);
  });

  it('idempotency keys are unique per scope and operation (BR-SYS-04)', async () => {
    const scope = randomBytes(16).toString('hex');
    const scopeId = `${scope.slice(0, 8)}-${scope.slice(8, 12)}-4${scope.slice(13, 16)}-a${scope.slice(17, 20)}-${scope.slice(20, 32)}`;
    await pg.query(
      `INSERT INTO platform.idempotency_record (scope_type, scope_id, operation, idempotency_key, request_hash)
       VALUES ('user', $1, 'op', 'key-1', 'h1')`,
      [scopeId],
    );
    await expect(
      pg.query(
        `INSERT INTO platform.idempotency_record (scope_type, scope_id, operation, idempotency_key, request_hash)
         VALUES ('user', $1, 'op', 'key-1', 'h2')`,
        [scopeId],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('inbox receipts dedupe per consumer (BR-SYS-06)', async () => {
    await pg.query(
      `INSERT INTO platform.inbox_receipt (consumer, event_id) VALUES ('worker', 'evt-1')`,
    );
    await expect(
      pg.query(`INSERT INTO platform.inbox_receipt (consumer, event_id) VALUES ('worker', 'evt-1')`),
    ).rejects.toThrow(/duplicate key/);
  });

  it('outbox due-scan uses the partial index', async () => {
    const plan = await pg.query(
      `EXPLAIN SELECT id FROM platform.outbox_event
        WHERE status IN ('pending', 'processing') AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT 10`,
    );
    const text = plan.rows.map((r) => (r as { 'QUERY PLAN': string })['QUERY PLAN']).join('\n');
    expect(text).toMatch(/idx_outbox_due|Index Scan/);
  });
});
