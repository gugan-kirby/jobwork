import { healthResponseSchema } from '@jobwork/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/boot';

describe('GET /api/v1/health', () => {
  let app: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] =
      process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
    ({ app, baseUrl } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns ok with db reachable and a valid contract shape', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(await res.json());
    expect(body.db).toBe('ok');
    expect(body.status).toBe('ok');
  });
});
