import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';

/** Where `DatabaseService.pool` comes from: one pool for the process, or one per request. */
export interface PoolSource {
  current(): Pool;
  end(): Promise<void>;
}

export const POOL_SOURCE = Symbol('PoolSource');

/** Node: one long-lived pool shared by every request. */
export class SharedPoolSource implements PoolSource {
  constructor(private readonly pool: Pool) {}

  current(): Pool {
    return this.pool;
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}

/** A query ran outside `RequestPoolSource.run`: a wiring defect, never a client error. */
export class NoRequestPoolError extends Error {
  constructor() {
    super('database used outside a request scope');
    this.name = 'NoRequestPoolError';
  }
}

/**
 * Workers: a pool per request (ADR-0009). A Worker cannot use a socket opened by another
 * request, so nothing may outlive the request that opened it; Hyperdrive pools the real
 * connections to Postgres. The pool is held in `AsyncLocalStorage`, so repositories keep
 * reading `db.pool` unchanged.
 */
export class RequestPoolSource implements PoolSource {
  private readonly scope = new AsyncLocalStorage<Pool>();

  constructor(private readonly create: () => Pool) {}

  current(): Pool {
    const pool = this.scope.getStore();
    if (!pool) throw new NoRequestPoolError();
    return pool;
  }

  /**
   * Runs `fn` with a pool of its own and ends the pool after. `defer` receives that end,
   * so a Worker can hand it to `waitUntil` instead of holding the response for it.
   */
  async run<T>(fn: () => Promise<T>, defer: (ended: Promise<void>) => void = () => undefined): Promise<T> {
    const pool = this.create();
    try {
      return await this.scope.run(pool, fn);
    } finally {
      defer(pool.end().catch(() => undefined));
    }
  }

  async end(): Promise<void> {
    // Every pool ends with its request.
  }
}
