import Redis from 'ioredis';
import type { Logger } from '@jobwork/observability';

/**
 * Counters behind the rate limits: a sliding-window estimate from two fixed windows
 * (the current one, plus the previous one weighted by how much of it still overlaps).
 * It costs two keys per budget and avoids the double burst a plain fixed window allows
 * at every boundary.
 */
export interface WindowCount {
  current: number;
  previous: number;
}

export interface RateLimitStore {
  /** Counts one hit against `key` in the window containing `now`, and returns both windows. */
  hit(key: string, windowMs: number, now: number): Promise<WindowCount>;
}

function windowKeys(key: string, windowMs: number, now: number): { current: string; previous: string } {
  const index = Math.floor(now / windowMs);
  return { current: `${key}:${index}`, previous: `${key}:${index - 1}` };
}

/** Per-process counters: the fallback when Redis is unreachable, and the store in a test. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counts = new Map<string, { value: number; expiresAt: number }>();
  private lastSweep = 0;

  async hit(key: string, windowMs: number, now: number): Promise<WindowCount> {
    this.sweep(now);
    const keys = windowKeys(key, windowMs, now);
    const entry = this.counts.get(keys.current);
    const value = entry && entry.expiresAt > now ? entry.value + 1 : 1;
    this.counts.set(keys.current, { value, expiresAt: (Math.floor(now / windowMs) + 2) * windowMs });
    const previous = this.counts.get(keys.previous);
    return { current: value, previous: previous && previous.expiresAt > now ? previous.value : 0 };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.counts) if (v.expiresAt <= now) this.counts.delete(k);
  }
}

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, windowMs: number, now: number): Promise<WindowCount> {
    const keys = windowKeys(key, windowMs, now);
    const result = await this.redis
      .multi()
      .incr(keys.current)
      .pexpire(keys.current, windowMs * 2)
      .get(keys.previous)
      .exec();
    if (!result) throw new Error('rate-limit transaction aborted');
    for (const [err] of result) if (err) throw err;
    return { current: Number(result[0]![1]), previous: Number(result[2]![1] ?? 0) };
  }
}

/**
 * Redis first; per-process memory when Redis fails (doc 12 §3: "Redis down: degrade
 * cache/rate convenience safely"). Failing open would drop the per-address half of
 * `AUTH-12`; failing closed would turn a cache outage into a platform outage. While
 * degraded each API instance enforces its own budgets — looser across a fleet, never
 * absent — and Redis is retried after a cool-down instead of on every request.
 */
export class ResilientRateLimitStore implements RateLimitStore {
  private degradedUntil = 0;

  constructor(
    private readonly primary: RateLimitStore,
    private readonly fallback: RateLimitStore,
    private readonly log: Logger,
    private readonly coolDownMs = 30_000,
  ) {}

  get degraded(): boolean {
    return Date.now() < this.degradedUntil;
  }

  async hit(key: string, windowMs: number, now: number): Promise<WindowCount> {
    if (now < this.degradedUntil) return this.fallback.hit(key, windowMs, now);
    try {
      return await this.primary.hit(key, windowMs, now);
    } catch (err) {
      if (this.degradedUntil === 0 || now >= this.degradedUntil) {
        this.log.warn({ err: err instanceof Error ? err.message : String(err), outcome: 'degraded' }, 'http.rate_limit_store_degraded');
      }
      this.degradedUntil = now + this.coolDownMs;
      return this.fallback.hit(key, windowMs, now);
    }
  }
}

/** A client that fails fast: a rate-limit check must never wait on a reconnect. */
export function createRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 500,
    commandTimeout: 250,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });
}
