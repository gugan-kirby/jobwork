import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { mintServiceToken, SCAN_WORKER_PRINCIPAL, SERVICE_TOKEN_HEADER } from '@jobwork/service-auth';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import Redis from 'ioredis';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/boot';

const SERVICE_SECRET = 'test-service-token-secret';

/** Small budgets so a test can spend them; everything else keeps the defaults. */
const POLICIES = {
  login: [
    { dimension: 'ip', limit: 5, windowSeconds: 60 },
    { dimension: 'account', limit: 3, windowSeconds: 60 },
  ],
  public_form: [{ dimension: 'ip', limit: 2, windowSeconds: 3600 }],
  read: [{ dimension: 'ip', limit: 5, windowSeconds: 60 }],
  webhook: [{ dimension: 'provider', limit: 3, windowSeconds: 60 }],
  service: [{ dimension: 'principal', limit: 2, windowSeconds: 60 }],
};

interface Reply {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

/**
 * F-11.2: budgets per operation class (doc 08 §14; `AUTH-12`). Client addresses are
 * played through `X-Forwarded-For` from a loopback hop — exactly how the web apps'
 * rewrite proxy presents a browser to the API.
 */
describe('Rate limits and abuse controls (F-11.2)', () => {
  let db: TestDatabase;
  let pg: Client;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let degradedApp: NestFastifyApplication;
  let degradedUrl: string;
  const prefix = `rltest${randomBytes(4).toString('hex')}`;
  let redis: Redis;

  async function call(base: string, method: string, path: string, opts: { ip?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.ip) headers['x-forwarded-for'] = opts.ip;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}/api/v1${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  const login = (base: string, ip: string, email: string): Promise<Reply> =>
    call(base, 'POST', '/auth/login', { ip, body: { email, password: 'not-the-password-123' } });

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_rate_limit');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = SERVICE_SECRET;
    process.env['NODE_ENV'] = 'test';
    process.env['RATE_LIMIT_MODE'] = 'enforce';
    process.env['RATE_LIMIT_PREFIX'] = prefix;
    process.env['RATE_LIMIT_POLICIES'] = JSON.stringify(POLICIES);
    process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
    pg = new Client({ connectionString: db.url });
    await pg.connect();
    redis = new Redis('redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    ({ app, baseUrl } = await createTestApp());

    // A second instance whose Redis is unreachable (nothing listens on port 1).
    process.env['REDIS_URL'] = 'redis://127.0.0.1:1';
    process.env['RATE_LIMIT_PREFIX'] = `${prefix}x`;
    ({ app: degradedApp, baseUrl: degradedUrl } = await createTestApp());
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await degradedApp?.close();
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
    await pg?.end();
    await db?.drop();
    process.env['RATE_LIMIT_MODE'] = 'off';
    delete process.env['RATE_LIMIT_POLICIES'];
  });

  it('counts sign-in attempts per account, whichever address they come from', async () => {
    const statuses: number[] = [];
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4']) {
      statuses.push((await login(baseUrl, ip, 'Target@Kovai.test')).status);
    }
    // Three wrong passwords are answered as wrong passwords; the fourth is refused unread.
    expect(statuses).toEqual([401, 401, 401, 429]);
    // Case and spacing do not make a new account.
    expect((await login(baseUrl, '203.0.113.5', ' target@kovai.test ')).status).toBe(429);
  });

  it('counts sign-in attempts per address, whichever accounts they name', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await login(baseUrl, '198.51.100.7', `user${i}@spray.test`)).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
    // Another address is untouched.
    expect((await login(baseUrl, '198.51.100.8', 'fresh@spray.test')).status).toBe(401);
  });

  it('refuses with retry guidance and changes nothing', async () => {
    const apply = (n: number): Promise<Reply> =>
      call(baseUrl, 'POST', '/public/supplier-applications', {
        ip: '192.0.2.10',
        body: { companyName: `Spam Works ${n}`, contactName: 'Bot', email: `bot${n}@spam.test`, processCodes: ['cnc_milling'], acceptTerms: true },
      });
    expect((await apply(1)).status).toBe(201);
    expect((await apply(2)).status).toBe(201);
    const refused = await apply(3);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: 'RATE_LIMITED', status: 429, title: 'Too many requests' });
    expect(refused.body['detail']).toMatch(/^Nothing was changed by this request\. Try again in \d+ seconds?\.$/);
    const retryAfter = Number(refused.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(refused.body['retryAfterSeconds']).toBe(retryAfter);
    const rows = await pg.query(`SELECT company_name FROM supplier.network_application WHERE email LIKE 'bot%@spam.test'`);
    expect(rows.rowCount).toBe(2);
  });

  it('keeps payment callbacks in their own bucket, and limits them there', async () => {
    // This address has spent its sign-in budget; the provider's callbacks still get through.
    expect((await login(baseUrl, '198.51.100.7', 'again@spray.test')).status).toBe(429);
    const webhook = (): Promise<Reply> => call(baseUrl, 'POST', '/webhooks/payments/dev', { ip: '198.51.100.7', body: { unsigned: true } });
    const answered = [await webhook(), await webhook(), await webhook()];
    for (const reply of answered) expect(reply.status).not.toBe(429);
    expect((await webhook()).status).toBe(429);
    // A spent callback budget does not touch anyone else's sign-in.
    expect((await login(baseUrl, '198.51.100.9', 'someone@kovai.test')).status).toBe(401);
  });

  it('never limits health probes, and limits anonymous reads per address', async () => {
    for (let i = 0; i < 10; i += 1) expect((await call(baseUrl, 'GET', '/health', { ip: '192.0.2.50' })).status).toBe(200);
    const reads: number[] = [];
    for (let i = 0; i < 6; i += 1) reads.push((await call(baseUrl, 'GET', '/public/categories', { ip: '192.0.2.50' })).status);
    expect(reads).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('counts the worker as itself, not as an address', async () => {
    const sweep = (): Promise<Reply> =>
      call(baseUrl, 'POST', '/internal/sla/sweep', { ip: '192.0.2.50', headers: { [SERVICE_TOKEN_HEADER]: mintServiceToken(SERVICE_SECRET, SCAN_WORKER_PRINCIPAL.name) } });
    // 192.0.2.50 has spent its read budget above; the worker's calls are not reads by it.
    expect((await sweep()).status).toBe(201);
    expect((await sweep()).status).toBe(201);
    expect((await sweep()).status).toBe(429);
  });

  it('keeps counters in Redis, hashed, and degrades to per-instance budgets when Redis is gone', async () => {
    const keys = await redis.keys(`${prefix}:*`);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(' ')).not.toMatch(/203\.0\.113|kovai|spray/);

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await login(degradedUrl, '198.51.100.70', `d${i}@spray.test`)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });
});
