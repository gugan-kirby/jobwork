import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { NoRequestPoolError, RequestPoolSource, SharedPoolSource } from '../src/platform/database/pool-source';

// No query runs here: a pg Pool connects lazily, so these pools never touch a server.
const newPool = (): Pool => new Pool({ connectionString: 'postgres://localhost:1/unused' });

describe('pool sources (F-CW.1, ADR-0009)', () => {
  it('shares one pool across callers on Node', async () => {
    const pool = newPool();
    const source = new SharedPoolSource(pool);
    expect(source.current()).toBe(pool);
    expect(source.current()).toBe(pool);
    await source.end();
  });

  it('gives each request its own pool and ends it when the request is done', async () => {
    const created: Pool[] = [];
    const source = new RequestPoolSource(() => {
      const pool = newPool();
      vi.spyOn(pool, 'end');
      created.push(pool);
      return pool;
    });

    const seen = await Promise.all([
      source.run(async () => source.current()),
      source.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return source.current();
      }),
    ]);

    expect(seen[0]).toBe(created[0]);
    expect(seen[1]).toBe(created[1]);
    expect(seen[0]).not.toBe(seen[1]);
    for (const pool of created) expect(pool.end).toHaveBeenCalledOnce();
  });

  it('ends the pool when the request fails, and hands the end to the caller', async () => {
    const pool = newPool();
    const end = vi.spyOn(pool, 'end');
    const deferred: Promise<void>[] = [];
    const source = new RequestPoolSource(() => pool);

    await expect(
      source.run(async () => {
        throw new Error('handler failed');
      }, (ended) => deferred.push(ended)),
    ).rejects.toThrow('handler failed');

    expect(end).toHaveBeenCalledOnce();
    expect(deferred).toHaveLength(1);
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  it('refuses a query outside a request', () => {
    const source = new RequestPoolSource(newPool);
    expect(() => source.current()).toThrow(NoRequestPoolError);
  });
});
