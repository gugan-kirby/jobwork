import type { DatabaseService } from '../../database/database.service';
import type { RateLimitStore, WindowCount } from './store';

/**
 * Counters in Postgres (`platform.rate_limit_counter`, ADR-0009) for deployments with no
 * Redis. One statement counts the hit in the current window and reads the previous one,
 * so a check costs one round trip. Rows outlive their use by one window; the worker's
 * cron sweep deletes them after `expires_at`.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly db: DatabaseService) {}

  async hit(key: string, windowMs: number, now: number): Promise<WindowCount> {
    const index = Math.floor(now / windowMs);
    const result = await this.db.pool.query<{ current: number; previous: number }>(
      `WITH counted AS (
         INSERT INTO platform.rate_limit_counter AS c (key, window_index, count, expires_at)
         VALUES ($1, $2, 1, to_timestamp($3 / 1000.0))
         ON CONFLICT (key, window_index) DO UPDATE SET count = c.count + 1
         RETURNING count
       )
       SELECT (SELECT count FROM counted) AS current,
              COALESCE((SELECT count FROM platform.rate_limit_counter
                         WHERE key = $1 AND window_index = $2 - 1), 0) AS previous`,
      [key, index, (index + 2) * windowMs],
    );
    const row = result.rows[0]!;
    return { current: row.current, previous: row.previous };
  }
}
