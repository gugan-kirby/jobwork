import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config as dotenv } from 'dotenv';
import { Pool } from 'pg';
import { registerPgTypeParsers } from '@jobwork/database';
import { createLogger, startMetricsServer } from '@jobwork/observability';
import { parseWorkerConfig } from './config';
import { createWorker } from './wiring';

registerPgTypeParsers();

if (process.env['NODE_ENV'] !== 'production') {
  for (const candidate of [join(process.cwd(), '.env'), join(process.cwd(), '..', '..', '.env')]) {
    if (existsSync(candidate)) {
      dotenv({ path: candidate });
      break;
    }
  }
}

/** The worker as a long-lived Node process: the outbox polled continuously, sweeps on timers. */
async function main(): Promise<void> {
  const env = parseWorkerConfig(process.env);
  const logger = createLogger({ service: 'worker' });
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
  // An idle connection ended by the server must not kill the worker (see the API's
  // DatabaseService): the pool drops it and reconnects on the next query.
  pool.on('error', (err) => logger.warn({ code: (err as { code?: string }).code }, 'db.idle_client_error'));
  await pool.query('SELECT 1');

  const worker = createWorker(env, { pool, logger });
  const metricsServer = env.METRICS_PORT ? await startMetricsServer(worker.metrics.registry, { port: env.METRICS_PORT, host: env.METRICS_HOST }) : null;
  worker.poller.start(env.OUTBOX_POLL_MS);
  logger.info({ version: process.env['BUILD_SHA'] ?? 'dev' }, 'worker started');

  const timers = worker.sweeps.map((sweep) => {
    if (sweep.atStart) void sweep.run();
    return setInterval(() => void sweep.run(), sweep.everyMs);
  });
  const heartbeat = setInterval(() => void worker.heartbeat(), env.WORKER_HEARTBEAT_MS);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    for (const timer of timers) clearInterval(timer);
    worker.poller.stop();
    metricsServer?.close();
    logger.info({ signal }, 'worker stopping');
    pool
      .end()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  createLogger({ service: 'worker' }).fatal({ err: err instanceof Error ? err.message : String(err) }, 'worker failed to start');
  process.exit(1);
});
