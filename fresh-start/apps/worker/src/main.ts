import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config as dotenv } from 'dotenv';
import { Pool } from 'pg';
import { z } from 'zod';
import { createLogger } from '@jobwork/observability';
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
import { SignatureScanner } from './scan/scanner';
import { DEFAULT_POLLER_OPTIONS, OutboxPoller } from './outbox/poller';
import { HandlerRegistry } from './outbox/registry';
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
});

const ACKNOWLEDGED_UNTIL_NOTIFICATIONS = [
  'sourcing.enquiry_submitted',
  'sourcing.enquiry_approved_for_sourcing',
  'sourcing.enquiry_declined',
  'sourcing.enquiry_cancelled',
  'sourcing.clarification_requested',
  'sourcing.clarification_answered',
  'supplier.admitted.v1',
  'supplier.availability_changed.v1',
  'supplier.declaration_withdrawn.v1',
  'supplier.exited.v1',
  'supplier.onboarding_submitted.v1',
  'commercial.approval_decided.v1',
  'commercial.award_proposed.v1',
  'commercial.cost_sheet_approval_requested.v1',
  'commercial.quote_approval_requested.v1',
  'commercial.quote_sent.v1',
  'commercial.quote_revision_requested.v1',
  'commercial.quote_rejected.v1',
  'commercial.quote_withdrawn.v1',
  'commercial.quote_expired.v1',
  'commercial.quote_accepted.v1',
  'orders.sales_order_created.v1',
  'orders.sales_order_released.v1',
  'orders.purchase_order_issued.v1',
  'orders.purchase_order_acknowledged.v1',
  'finance.invoice_issued.v1',
  'finance.payment_received.v1',
  'finance.payment_failed.v1',
  'finance.payment_suspense.v1',
  'finance.allocation_proposed.v1',
  'finance.credit_hold_placed.v1',
  'dms.baseline_released.v1',
  'dms.transmittal_issued.v1',
  'dms.transmittal_acknowledged.v1',
  'orders.work_package_released.v1',
  'orders.work_package_completed.v1',
  'orders.containment_recorded.v1',
  'orders.milestone_evidence_submitted.v1',
  'orders.milestone_evidence_rejected.v1',
  'orders.milestone_verified.v1',
  'orders.milestone_delayed.v1',
] as const;

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
    .register('supplier.application_received.v1', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('supplier.application_declined.v1', acknowledgeHandler(logger, 'outbox event acknowledged'))
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
    )
    // Published now, subscribed to later (IN-10 notification, F-10.4 transmittals).
    .register('dms.file_cleared', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('dms.file_quarantined', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('dms.audience_granted', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('dms.audience_revoked', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('supplier.verification_submitted', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('supplier.verification_verified', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('supplier.verification_returned', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('supplier.verification_revoked', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('supplier.verification_expiring', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('sourcing.rfq_released.v1', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('sourcing.rfq_closed.v1', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('sourcing.rfq_declined.v1', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('sourcing.bid_submitted.v1', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('sourcing.rfq_deadline_passed.v1', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('supplier.verification_expired', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('supplier.capability_published', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('supplier.machine_registered', acknowledgeHandler(logger, 'outbox event acknowledged'))
    .register('supplier.capacity_declared', acknowledgeHandler(logger, 'outbox event acknowledged'));
  // Published by IN-02…IN-08 commands and consumed by the notification increment (IN-10).
  // Until then they are acknowledged rather than left to dead-letter (doc 07 §10): a
  // dead-letter is an alarm, and an alarm that always rings is one nobody answers.
  for (const eventType of ACKNOWLEDGED_UNTIL_NOTIFICATIONS) {
    registry.register(eventType, acknowledgeHandler(logger, 'outbox event acknowledged'));
  }
  const poller = new OutboxPoller(pool, registry, logger);
  poller.start(env.OUTBOX_POLL_MS);
  logger.info({ version: process.env['BUILD_SHA'] ?? 'dev' }, 'worker started');

  // Time-driven work: verification expiry is data-driven, the timer only decides how
  // often the question is asked (doc 06 §14).
  const sweep = verificationExpiryScan(internalApi, logger.child({ module: 'supplier.verification' }));
  void sweep();
  const sweepTimer = setInterval(() => void sweep(), env.VERIFICATION_SWEEP_MS);
  // The RFQ deadline tick rides the same schedule: both are date-driven sweeps whose
  // cost is one query when there is nothing to do.
  const deadlineSweep = rfqDeadlineScan(internalApi, logger.child({ module: 'sourcing.rfq' }));
  const deadlineTimer = setInterval(() => void deadlineSweep(), env.VERIFICATION_SWEEP_MS);
  const paymentSweep = paymentReconcileScan(internalApi, logger.child({ module: 'finance.payments' }));
  const paymentTimer = setInterval(() => void paymentSweep(), env.PAYMENT_SWEEP_MS);

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
    poller.stop();
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
