import { Pool } from 'pg';
import { registerPgTypeParsers } from '@jobwork/database';
import { createLogger } from '@jobwork/observability';
import { parseWorkerConfig } from './config';
import { createWorker } from './wiring';

registerPgTypeParsers();

/** The bindings `wrangler.jsonc` declares; vars and secrets arrive in `process.env`. */
export interface CronEnv {
  HYPERDRIVE: { connectionString: string };
  /** The API Worker, through a service binding: it has no public address (F-CW.3). */
  API: { fetch(request: Request): Promise<Response> };
}

interface ScheduledController {
  scheduledTime: number;
}

interface CronContext {
  waitUntil(promise: Promise<unknown>): void;
}

const MINUTE_MS = 60_000;
/**
 * Outbox batches per run (each up to the poller's 10 events). A Worker invocation has
 * 10 ms of CPU on the free plan; most of a batch is waiting on the API and Postgres,
 * which is not counted. What is left over waits a minute for the next run.
 */
export const MAX_BATCHES_PER_RUN = 3;

/** Whether a sweep that runs every `everyMs` is due in the minute that started at `scheduledTime`. */
export function due(everyMs: number, scheduledTime: number): boolean {
  const everyMinutes = Math.max(1, Math.round(everyMs / MINUTE_MS));
  return Math.floor(scheduledTime / MINUTE_MS) % everyMinutes === 0;
}

/**
 * One Cron Trigger run (F-CW.4, ADR-0009): the worker without a long-lived process.
 * Drain a bounded part of the outbox, run the sweeps due this minute, report the backlog.
 * Everything it does is idempotent, so an overlap or a missed minute only delays work.
 */
export async function runScheduled(scheduledTime: number, env: CronEnv): Promise<{ handled: number }> {
  const config = parseWorkerConfig({ ...process.env, DATABASE_URL: env.HYPERDRIVE.connectionString });
  const logger = createLogger({ service: 'worker' });
  // One pool per run: a Worker cannot keep sockets between invocations; Hyperdrive pools.
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
  pool.on('error', (err) => logger.warn({ code: (err as { code?: string }).code }, 'db.idle_client_error'));
  try {
    const worker = createWorker(config, {
      pool,
      logger,
      apiFetch: (input, init) => env.API.fetch(new Request(input, init)),
      // The SLA sweep alone makes over a hundred round trips to the database; a cron
      // run may take minutes, so an API call gets a minute rather than the default 15 s.
      apiTimeoutMs: 60_000,
    });
    // Events claimed and processed, whether delivered, retried or dead-lettered.
    let handled = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const claimed = await worker.poller.tick();
      handled += claimed;
      if (claimed === 0) break;
    }
    for (const sweep of worker.sweeps) {
      if (due(sweep.everyMs, scheduledTime)) await sweep.run();
    }
    await worker.heartbeat();
    return { handled };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export default {
  /**
   * Awaited, not handed to `waitUntil`: the runtime keeps background work alive only for
   * a short grace period after the handler returns, and tore the run down about 14 s in,
   * cancelling the sweep's call to the API every minute (2026-11-12). A cron invocation
   * may run for minutes while its handler is still awaiting.
   */
  async scheduled(controller: ScheduledController, env: CronEnv, _ctx: CronContext): Promise<void> {
    await runScheduled(controller.scheduledTime, env);
  },
};
