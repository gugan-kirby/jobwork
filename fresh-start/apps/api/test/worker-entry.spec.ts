import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/worker';

/**
 * F-CW.3: the Worker entry, run on Node. A pool per request, ended through `waitUntil`;
 * the peer is the service binding, and the browser is whoever the caller names.
 */
describe('API Worker entry (F-CW.3)', () => {
  let db: TestDatabase;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_worker_entry');
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['NODE_ENV'] = 'test';
    process.env['PASSWORD_HASHER'] = 'pgcrypto-bcrypt';
    process.env['RATE_LIMIT_STORE'] = 'postgres';
    process.env['RATE_LIMIT_MODE'] = 'enforce';
    process.env['RATE_LIMIT_POLICIES'] = JSON.stringify({ read: [{ dimension: 'ip', limit: 2, windowSeconds: 60 }] });
    worker.start();
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled(pending);
    await db.drop();
    for (const key of ['PASSWORD_HASHER', 'RATE_LIMIT_STORE', 'RATE_LIMIT_MODE', 'RATE_LIMIT_POLICIES']) delete process.env[key];
  });

  it('answers through a pool of its own and hands the pool’s end to waitUntil', async () => {
    const before = pending.length;
    const res = await worker.fetch(new Request('https://api.internal/api/v1/health'), { HYPERDRIVE: { connectionString: db.url } }, ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { db: string }).db).toBe('ok');
    expect(pending.length).toBe(before + 1);
    await expect(pending.at(-1)).resolves.toBeUndefined();
  });

  it('counts the browser the caller names, not the binding', async () => {
    const env = { HYPERDRIVE: { connectionString: db.url } };
    const from = (ip: string): Request =>
      new Request('https://api.internal/api/v1/public/categories', { headers: { 'x-forwarded-for': ip } });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await worker.fetch(from('198.51.100.40'), env, ctx)).status);
    expect(statuses).toEqual([200, 200, 429]);
    expect((await worker.fetch(from('198.51.100.41'), env, ctx)).status).toBe(200);
  });
});
