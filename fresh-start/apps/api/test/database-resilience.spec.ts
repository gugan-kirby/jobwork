import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConfigService } from '../src/platform/config/config.service';
import { DatabaseService } from '../src/platform/database/database.service';

/**
 * doc 12 §3: the database ending idle connections (a restart, a failover, an operator's
 * `pg_terminate_backend`) degrades the API for a moment; it must not crash it. An idle
 * pool client's error is emitted on the pool, and an unhandled one kills the process.
 */
describe('database pool resilience', () => {
  let db: TestDatabase;
  let service: DatabaseService;

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_pool');
    service = new DatabaseService({ env: { DATABASE_URL: db.url } } as unknown as ConfigService);
  });

  afterAll(async () => {
    await service?.onModuleDestroy();
    await db?.drop();
  });

  it('survives the server ending its idle connections, and reconnects on the next query', async () => {
    // Open several connections and leave them idle in the pool.
    await Promise.all([1, 2, 3].map(() => service.pool.query('SELECT pg_sleep(0.05)')));
    expect(service.pool.idleCount).toBeGreaterThan(0);

    const admin = new Client({ connectionString: db.url });
    await admin.connect();
    const ended = await admin.query<{ pid: number }>(
      `SELECT pg_terminate_backend(pid) AS pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    await admin.end();
    expect(ended.rows.length).toBeGreaterThan(0);

    // Let the pool see the terminations, then use it again.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await service.ping()).toBe(true);
    const res = await service.pool.query<{ n: number }>('SELECT 1 AS n');
    expect(res.rows[0]!.n).toBe(1);
  });
});
