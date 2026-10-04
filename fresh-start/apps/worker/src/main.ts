import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config as dotenv } from 'dotenv';
import { Pool } from 'pg';
import { z } from 'zod';
import { createLogger, startMetricsServer } from '@jobwork/observability';
import { ObjectStoreClient } from '@jobwork/object-store';
import { SCAN_WORKER_PRINCIPAL } from '@jobwork/service-auth';
import { InternalApiClient } from './internal-api';
import { FileMailer, type Mailer } from './mailer';
import { acknowledgeHandler } from './outbox/handlers/acknowledge';
import { fileFinalizedHandler } from './outbox/handlers/file-finalized';
import { emailVerificationHandler } from './outbox/handlers/email-verification';
import { invitationIssuedHandler } from './outbox/handlers/invitation-issued';
import { rfqDeadlineScan } from './outbox/handlers/rfq-deadline';
import { paymentReconcileScan } from './outbox/handlers/payment-reconcile';
import { verificationExpiryScan } from './outbox/handlers/verification-expiry';
import { slaEscalator } from './sla/escalator';
import { createWorkerMetrics } from './metrics';
import { SignatureScanner } from './scan/scanner';
import { DEFAULT_POLLER_OPTIONS, OutboxPoller } from './outbox/poller';
import { HandlerRegistry } from './outbox/registry';
import { ACKNOWLEDGED_EVENT_TYPES } from './outbox/subscriptions';
import { NOTIFIED_EVENT_TYPES } from '@jobwork/contracts';
import { defaultChannels } from './notifications/channels';
import { notificationHandler } from './notifications/deliver';
import { registerPgTypeParsers } from '@jobwork/database';

registerPgTypeParsers();

if (process.env['NODE_ENV'] !== 'production') {
  for (const candidate of [join(process.cwd(), '.env'), join(process.cwd(), '..', '..', '.env')]) {
    if (existsSync(candidate)) {
      dotenv({ path: candidate });
      break;
    }
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgres://localhost:5432/jobwork_dev'),
  PORTAL_URL: z.string().default('http://localhost:3000'),
  API_URL: z.string().default('http://localhost:4000'),
  SERVICE_TOKEN_SECRET: z.string().min(8).default('dev-service-token-secret'),
  OBJECT_STORE_ENDPOINT: z.string().default('http://localhost:9000'),
  OBJECT_STORE_REGION: z.string().default('us-east-1'),
  OBJECT_STORE_ACCESS_KEY: z.string().default('minioadmin'),
  OBJECT_STORE_SECRET_KEY: z.string().default('minioadmin'),
  OBJECT_STORE_BUCKET_QUARANTINE: z.string().default('jobwork-quarantine'),
  OBJECT_STORE_BUCKET_CLEAN: z.string().default('jobwork-clean'),
  SCAN_MAX_INSPECT_BYTES: z.coerce.number().int().min(1024).default(256 * 1024 * 1024),
  SCAN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  SMTP_URL: z.string().default('log://'),
  WORKER_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(60_000),
  VERIFICATION_SWEEP_MS: z.coerce.number().int().min(1000).default(15 * 60_000),
  OUTBOX_POLL_MS: z.coerce.number().int().min(200).default(2_000),
  PAYMENT_SWEEP_MS: z.coerce.number().int().min(1000).default(5 * 60_000),
  SLA_SWEEP_MS: z.coerce.number().int().min(1000).default(60_000),
  /** F-11.3: Prometheus metrics on their own port; 0 serves none. */
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  METRICS_HOST: z.string().default('127.0.0.1'),
});


function buildMailer(smtpUrl: string): Mailer {
  if (smtpUrl.startsWith('log://')) return new FileMailer();
  // SMTP transport slot: wired when a real provider is selected (T-0x); fail fast until then.
  throw new Error(`unsupported SMTP_URL scheme: ${smtpUrl}`);
}

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `invalid environment configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const env = parsed.data;
  const logger = createLogger({ service: 'worker' });
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });
  await pool.query('SELECT 1');

  // The worker holds store credentials and a short-lived service credential only —
  // no user session, no database writes to business state (doc 20 §9).
  const objectStore = new ObjectStoreClient({
    endpoint: env.OBJECT_STORE_ENDPOINT,
    region: env.OBJECT_STORE_REGION,
    accessKeyId: env.OBJECT_STORE_ACCESS_KEY,
    secretAccessKey: env.OBJECT_STORE_SECRET_KEY,
    quarantineBucket: env.OBJECT_STORE_BUCKET_QUARANTINE,
    cleanBucket: env.OBJECT_STORE_BUCKET_CLEAN,
    uploadTtlSeconds: 900,
    downloadTtlSeconds: 120,
  });
  const internalApi = new InternalApiClient({
    baseUrl: env.API_URL,
    tokenSecret: env.SERVICE_TOKEN_SECRET,
    principalName: SCAN_WORKER_PRINCIPAL.name,
  });

  const mailer = buildMailer(env.SMTP_URL);
  const registry = new HandlerRegistry()
    .register('iam.invitation.issued.v1', invitationIssuedHandler(mailer, env.PORTAL_URL))
    .register('iam.email_verification.issued.v1', emailVerificationHandler(mailer, env.PORTAL_URL))
    .register(
      'dms.file_finalized',
      fileFinalizedHandler({
        store: objectStore,
        scanner: new SignatureScanner(),
        api: internalApi,
        log: logger.child({ module: 'dms.scan' }),
        maxInspectBytes: env.SCAN_MAX_INSPECT_BYTES,
        scanTimeoutMs: env.SCAN_TIMEOUT_MS,
        maxAttempts: DEFAULT_POLLER_OPTIONS.maxAttempts,
      }),
    );
  // F-10.3: committed events that tell someone something. The API decides who and renders
  // the words; the worker delivers and reports (doc 20 §9: no business state here).
  const deliver = notificationHandler({ api: internalApi, channels: defaultChannels(mailer), log: logger.child({ module: 'communication.notifications' }) });
  for (const eventType of NOTIFIED_EVENT_TYPES) registry.register(eventType, deliver);
  // Committed and audited, nothing for the worker to do yet (`outbox/subscriptions.ts`).
  for (const eventType of ACKNOWLEDGED_EVENT_TYPES) {
    registry.register(eventType, acknowledgeHandler(logger, 'outbox event acknowledged'));
  }
  const metrics = createWorkerMetrics(process.env['BUILD_SHA'] ?? 'dev');
  const metricsServer = env.METRICS_PORT ? await startMetricsServer(metrics.registry, { port: env.METRICS_PORT, host: env.METRICS_HOST }) : null;
  const poller = new OutboxPoller(pool, registry, logger, DEFAULT_POLLER_OPTIONS, metrics.observeOutbox);
  poller.start(env.OUTBOX_POLL_MS);
  logger.info({ version: process.env['BUILD_SHA'] ?? 'dev' }, 'worker started');

  // Time-driven work: verification expiry is data-driven, the timer only decides how
  // often the question is asked (doc 06 §14).
  const sweep = verificationExpiryScan(internalApi, logger.child({ module: 'supplier.verification' }), metrics.sweep('verification_expiry'));
  void sweep();
  const sweepTimer = setInterval(() => void sweep(), env.VERIFICATION_SWEEP_MS);
  // The RFQ deadline tick rides the same schedule: both are date-driven sweeps whose
  // cost is one query when there is nothing to do.
  const deadlineSweep = rfqDeadlineScan(internalApi, logger.child({ module: 'sourcing.rfq' }), metrics.sweep('rfq_deadline'));
  const deadlineTimer = setInterval(() => void deadlineSweep(), env.VERIFICATION_SWEEP_MS);
  const paymentSweep = paymentReconcileScan(internalApi, logger.child({ module: 'finance.payments' }), metrics.sweep('payment_reconcile'));
  const paymentTimer = setInterval(() => void paymentSweep(), env.PAYMENT_SWEEP_MS);
  // F-11.1: queue stays, deadlines and escalations; a minute is the resolution of a deadline.
  const slaSweep = slaEscalator(internalApi, logger.child({ module: 'platform.sla' }), metrics.sweep('sla'));
  void slaSweep();
  const slaTimer = setInterval(() => void slaSweep(), env.SLA_SWEEP_MS);

  const heartbeat = setInterval(() => {
    void pool
      .query(
        `SELECT count(*)::int AS backlog,
                COALESCE(EXTRACT(EPOCH FROM now() - min(next_attempt_at)), 0)::int AS oldest_s
           FROM platform.outbox_event WHERE status IN ('pending', 'processing')`,
      )
      .then((r) =>
        logger.info(
          { backlog: r.rows[0]?.backlog ?? 0, oldestSeconds: r.rows[0]?.oldest_s ?? 0 },
          'worker heartbeat',
        ),
      )
      .catch(() => logger.warn('heartbeat query failed'));
  }, env.WORKER_HEARTBEAT_MS);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    clearInterval(sweepTimer);
    clearInterval(deadlineTimer);
    clearInterval(paymentTimer);
    clearInterval(slaTimer);
    poller.stop();
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
  createLogger({ service: 'worker' }).fatal(
    { err: err instanceof Error ? err.message : String(err) },
    'worker failed to start',
  );
  process.exit(1);
});
