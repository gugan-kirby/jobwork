import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

/**
 * The guest surface (F-MX.3, `D-17`): category education and nothing else. The
 * negative half matters more than the positive one — the same anonymous client that
 * can read categories must be refused everything that names a supplier.
 */
describe('Public categories (F-MX.3)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let guest: TestClient;

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_public');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['NODE_ENV'] = 'test';
    const booted = await createTestApp();
    app = booted.app;
    guest = new TestClient(booted.baseUrl);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('lists process families with their processes to an anonymous caller', async () => {
    const res = await guest.get('/api/v1/public/categories');
    expect(res.status).toBe(200);
    const families = res.body['families'] as Array<{
      code: string;
      label: string;
      processes: Array<{ code: string; label: string }>;
    }>;
    expect(families.length).toBeGreaterThan(0);
    const machining = families.find((f) => f.code === 'machining')!;
    expect(machining.label).toBe('CNC machining');
    expect(machining.processes.map((p) => p.code)).toEqual(
      expect.arrayContaining(['cnc_milling', 'cnc_turning', 'vmc_machining']),
    );
    // A family with nothing under it would be an empty shelf; none is listed.
    expect(families.every((f) => f.processes.length > 0)).toBe(true);
  });

  it('carries nothing that leads to a supplier — no ids, counts or availability', () => {
    // Serialised shape check: the only keys anywhere in the payload are the four
    // educational ones. Anything else is a leak waiting for a curious guest.
    return guest.get('/api/v1/public/categories').then((res) => {
      const keys = new Set<string>();
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') {
          for (const [k, v] of Object.entries(value)) {
            keys.add(k);
            walk(v);
          }
        }
      };
      walk(res.body);
      expect([...keys].sort()).toEqual(['code', 'families', 'label', 'processes']);
    });
  });

  it('still refuses the authenticated taxonomy and every supplier route to a guest', async () => {
    for (const path of [
      '/api/v1/suppliers/me/taxonomy',
      '/api/v1/suppliers',
      '/api/v1/capability-cards',
      '/api/v1/enquiries',
    ]) {
      const res = await guest.get(path);
      expect(res.status, path).toBe(401);
    }
  });
});
