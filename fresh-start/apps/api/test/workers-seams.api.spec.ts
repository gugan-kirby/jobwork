import type { TestApp } from './helpers/boot';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'a-long-enough-password-1';

/**
 * F-CW.1: the settings a Workers deployment runs on (ADR-0009) — passwords hashed by
 * Postgres, rate limits counted in Postgres, no Redis — behave as the defaults do.
 */
describe('Workers settings: pgcrypto passwords and Postgres rate limits (F-CW.1)', () => {
  let db: TestDatabase;
  let pg: Client;
  let app: TestApp;
  let baseUrl: string;

  const login = (email: string, password: string, ip: string): Promise<Response> =>
    fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email, password }),
    });

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_workers_seams');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['NODE_ENV'] = 'test';
    process.env['PASSWORD_HASHER'] = 'pgcrypto-bcrypt';
    process.env['RATE_LIMIT_STORE'] = 'postgres';
    process.env['RATE_LIMIT_MODE'] = 'enforce';
    process.env['RATE_LIMIT_POLICIES'] = JSON.stringify({
      login: [{ dimension: 'account', limit: 3, windowSeconds: 60 }],
    });
    // An address nothing listens on: a Redis connection would fail, so passing proves none is used.
    process.env['REDIS_URL'] = 'redis://127.0.0.1:1';
    pg = new Client({ connectionString: db.url });
    await pg.connect();
    ({ app, baseUrl } = await createTestApp());
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
    for (const key of ['PASSWORD_HASHER', 'RATE_LIMIT_STORE', 'RATE_LIMIT_MODE', 'RATE_LIMIT_POLICIES', 'REDIS_URL']) {
      delete process.env[key];
    }
  });

  it('registers, verifies and signs in with a bcrypt hash made by Postgres', async () => {
    const guest = new TestClient(baseUrl);
    const registered = await guest.post('/api/v1/auth/register', {
      fullName: 'Meena R',
      mobile: '+91 98400 00002',
      email: 'meena@hosur.test',
      password: PASSWORD,
      organizationName: 'Hosur Castings',
      acceptTerms: true,
    });
    expect(registered.status).toBe(201);

    const stored = await pg.query<{ version: number; prefix: string }>(
      `SELECT password_params_version AS version, left(password_hash, 7) AS prefix
         FROM iam.user_account WHERE email = 'meena@hosur.test'`,
    );
    expect(stored.rows[0]).toEqual({ version: 2, prefix: '$2a$10$' });

    const token = new URL(registered.body['verifyUrl'] as string).searchParams.get('token')!;
    expect((await guest.post('/api/v1/auth/verify-email', { token })).status).toBe(201);

    const client = new TestClient(baseUrl);
    const signedIn = await client.post('/api/v1/auth/login', { email: 'meena@hosur.test', password: PASSWORD });
    expect(signedIn.status).toBe(201);
    expect((await client.get('/api/v1/auth/me')).body['email']).toBe('meena@hosur.test');
  });

  it('answers an unknown account and a wrong password alike', async () => {
    expect((await login('nobody@hosur.test', PASSWORD, '203.0.113.20')).status).toBe(401);
    expect((await login('meena@hosur.test', `${PASSWORD}x`, '203.0.113.21')).status).toBe(401);
  });

  it('counts sign-in attempts in Postgres and refuses past the budget', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await login('target@hosur.test', 'wrong-password-123', '203.0.113.30')).status);
    expect(statuses).toEqual([401, 401, 401, 429]);

    const rows = await pg.query<{ count: number }>(`SELECT count FROM platform.rate_limit_counter WHERE key LIKE '%login%'`);
    expect(rows.rows.length).toBeGreaterThan(0);
  });
});
