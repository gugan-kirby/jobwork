import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditWriter } from '../src/platform/commands/audit.writer';
import type { CommandContext, CommandDefinition } from '../src/platform/commands/command';
import {
  CommandExecutor,
  IdempotencyPayloadMismatch,
} from '../src/platform/commands/execute';
import { OutboxWriter } from '../src/platform/commands/outbox.writer';
import type { ConfigService } from '../src/platform/config/config.service';
import { DatabaseService } from '../src/platform/database/database.service';
import { MetricsService } from '../src/platform/metrics/metrics.service';
import type { HttpAdapterHost } from '@nestjs/core';

const CTX: CommandContext = {
  actor: { type: 'user', id: '00000000-0000-7000-8000-000000000001', organizationId: null },
  correlationId: 'corr-spine',
};

describe('command execution spine (BR-SYS-01..04, doc 02 §8)', () => {
  let db: TestDatabase;
  let dbService: DatabaseService;
  let executor: CommandExecutor;
  let metrics: MetricsService;
  let pg: Client;

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_spine');
    dbService = new DatabaseService({ env: { DATABASE_URL: db.url } } as unknown as ConfigService);
    metrics = new MetricsService(
      { env: { METRICS_PORT: 0, METRICS_HOST: '127.0.0.1' }, buildVersion: 'test' } as unknown as ConfigService,
      {} as HttpAdapterHost,
      dbService,
    );
    executor = new CommandExecutor(dbService, new AuditWriter(), new OutboxWriter(), metrics);
    pg = new Client({ connectionString: db.url });
    await pg.connect();
  }, 60_000);

  afterAll(async () => {
    await pg.end();
    await dbService.onModuleDestroy();
    await db.drop();
  });

  const createOrg: CommandDefinition<{ name: string; fail?: boolean }, { id: string }> = {
    operation: 'test.create-org',
    handler: async (tx, _ctx, input) => {
      const res = await tx.query<{ id: string }>(
        `INSERT INTO iam.organization (type, legal_name, display_name)
         VALUES ('customer', $1, $1) RETURNING id`,
        [input.name],
      );
      if (input.fail) throw new Error('forced failure after business write');
      const id = res.rows[0]?.id ?? '';
      return {
        result: { id },
        audit: [{ action: 'test.org_created', subjectType: 'organization', subjectId: id }],
        outbox: [
          { eventType: 'test.org.created.v1', aggregateType: 'organization', aggregateId: id, data: {} },
        ],
      };
    },
  };

  it('persists business state, audit, and outbox atomically', async () => {
    const { id } = await executor.execute(createOrg, CTX, { name: 'Atomic Co' });
    const audit = await pg.query(
      `SELECT correlation_id FROM platform.audit_event WHERE subject_id = $1`,
      [id],
    );
    const outbox = await pg.query(
      `SELECT status FROM platform.outbox_event WHERE aggregate_id = $1`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.correlation_id).toBe('corr-spine');
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0]?.status).toBe('pending');
  });

  it('rolls back everything together when the handler fails (BR-SYS-02)', async () => {
    const before = await pg.query(`SELECT count(*)::int AS n FROM iam.organization`);
    await expect(
      executor.execute(createOrg, CTX, { name: 'Ghost Co', fail: true }),
    ).rejects.toThrow(/forced failure/);
    const after = await pg.query(`SELECT count(*)::int AS n FROM iam.organization`);
    const audit = await pg.query(
      `SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'test.org_created'`,
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect(audit.rows[0]?.n).toBe(1); // only the earlier successful command's row
  });

  let executions = 0;
  const counted: CommandDefinition<{ name: string }, { id: string }> = {
    operation: 'test.counted',
    handler: async (tx, ctx, input) => {
      executions += 1;
      return createOrg.handler(tx, ctx, input);
    },
  };

  it('same idempotency key + same payload returns the original result without re-executing', async () => {
    const first = await executor.execute(counted, CTX, { name: 'Once Co' }, { idempotencyKey: 'k1' });
    const second = await executor.execute(counted, CTX, { name: 'Once Co' }, { idempotencyKey: 'k1' });
    expect(second).toEqual(first);
    expect(executions).toBe(1);
  });

  it('same key + same operation with different payload conflicts (BR-SYS-04)', async () => {
    await expect(
      executor.execute(counted, CTX, { name: 'Different Co' }, { idempotencyKey: 'k1' }),
    ).rejects.toThrow(IdempotencyPayloadMismatch);
    expect(executions).toBe(1); // handler never ran for the mismatched request
  });

  it('concurrent same-key commands execute exactly once and agree on the result', async () => {
    let executions = 0;
    const counted: CommandDefinition<{ name: string }, { id: string }> = {
      operation: 'test.concurrent',
      handler: async (tx, ctx, input) => {
        executions += 1;
        await new Promise((r) => setTimeout(r, 25));
        return createOrg.handler(tx, ctx, input);
      },
    };
    const [a, b] = await Promise.all([
      executor.execute(counted, CTX, { name: 'Race Co' }, { idempotencyKey: 'race-1' }),
      executor.execute(counted, CTX, { name: 'Race Co' }, { idempotencyKey: 'race-1' }),
    ]);
    expect(executions).toBe(1);
    expect(a).toEqual(b);
    const rows = await pg.query(
      `SELECT count(*)::int AS n FROM iam.organization WHERE legal_name = 'Race Co'`,
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('counts every command by operation and outcome (F-11.3)', async () => {
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/jobwork_commands_total\{operation="test\.create-org",outcome="ok",service="api"\} [1-9]/);
    // A thrown handler error is an error; a reused key with another payload is a conflict.
    expect(text).toMatch(/jobwork_commands_total\{operation="test\.create-org",outcome="error",service="api"\} [1-9]/);
    expect(text).toMatch(/jobwork_commands_total\{operation="test\.counted",outcome="conflict",service="api"\} [1-9]/);
    expect(text).toMatch(/jobwork_command_duration_seconds_count\{service="api",operation="test\.create-org"\} 2/);
  });
});
