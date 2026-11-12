import type { Pool } from 'pg';
import { NOTIFIED_EVENT_TYPES } from '@jobwork/contracts';
import type { Logger } from '@jobwork/observability';
import { ObjectStoreClient } from '@jobwork/object-store';
import { SCAN_WORKER_PRINCIPAL } from '@jobwork/service-auth';
import { ApiMailer } from './api-mailer';
import type { WorkerConfig } from './config';
import { InternalApiClient, type InternalApiOptions } from './internal-api';
import { buildMailer, type Mailer } from './mailer';
import { createWorkerMetrics, type WorkerMetrics } from './metrics';
import { defaultChannels } from './notifications/channels';
import { notificationHandler } from './notifications/deliver';
import { acknowledgeHandler } from './outbox/handlers/acknowledge';
import { deliveryAcceptanceScan } from './outbox/handlers/delivery-acceptance';
import { emailVerificationHandler } from './outbox/handlers/email-verification';
import { fileFinalizedHandler } from './outbox/handlers/file-finalized';
import { invitationIssuedHandler } from './outbox/handlers/invitation-issued';
import { paymentReconcileScan } from './outbox/handlers/payment-reconcile';
import { rfqDeadlineScan } from './outbox/handlers/rfq-deadline';
import { verificationExpiryScan } from './outbox/handlers/verification-expiry';
import { DEFAULT_POLLER_OPTIONS, OutboxPoller } from './outbox/poller';
import { HandlerRegistry } from './outbox/registry';
import { ACKNOWLEDGED_EVENT_TYPES } from './outbox/subscriptions';
import { SignatureScanner } from './scan/scanner';
import { slaEscalator } from './sla/escalator';

/** A time-driven job: the timer only decides how often the question is asked (doc 06 §14). */
export interface Sweep {
  name: string;
  everyMs: number;
  /** Also run when a long-lived worker starts, rather than first after one interval. */
  atStart: boolean;
  run(): Promise<void>;
}

export interface WorkerParts {
  poller: OutboxPoller;
  sweeps: Sweep[];
  metrics: WorkerMetrics;
  /** Logs the outbox backlog and the age of its oldest event. */
  heartbeat(): Promise<void>;
}

export interface WorkerDeps {
  pool: Pool;
  logger: Logger;
  /** The API through a Worker's service binding instead of `API_URL` (F-CW.4). */
  apiFetch?: InternalApiOptions['fetch'];
  /** How long one API call may take. The sweeps make many database round trips; from a Worker far from the database they need more than the default. */
  apiTimeoutMs?: number;
}

/**
 * Everything the worker does, built once from its settings (F-CW.4). A long-lived Node
 * process runs it on timers (`main.ts`); a Worker runs it once per Cron Trigger
 * (`cron.ts`). The worker holds store credentials and a short-lived service credential
 * only — no user session, no writes to business state (doc 20 §9).
 */
export function createWorker(env: WorkerConfig, deps: WorkerDeps): WorkerParts {
  const { pool, logger } = deps;
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
    ...(deps.apiFetch ? { fetch: deps.apiFetch } : {}),
    ...(deps.apiTimeoutMs ? { timeoutMs: deps.apiTimeoutMs } : {}),
  });

  const mailer: Mailer =
    env.MAIL_TRANSPORT === 'api' ? new ApiMailer(internalApi) : buildMailer({ smtpUrl: env.SMTP_URL, smtpFrom: env.SMTP_FROM });
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
  // the words; the worker delivers and reports.
  const deliver = notificationHandler({ api: internalApi, channels: defaultChannels(mailer), log: logger.child({ module: 'communication.notifications' }) });
  for (const eventType of NOTIFIED_EVENT_TYPES) registry.register(eventType, deliver);
  // Committed and audited, nothing for the worker to do yet (`outbox/subscriptions.ts`).
  for (const eventType of ACKNOWLEDGED_EVENT_TYPES) {
    registry.register(eventType, acknowledgeHandler(logger, 'outbox event acknowledged'));
  }

  const metrics = createWorkerMetrics(process.env['BUILD_SHA'] ?? 'dev');
  const poller = new OutboxPoller(pool, registry, logger, DEFAULT_POLLER_OPTIONS, metrics.observeOutbox);

  const sweeps: Sweep[] = [
    // Verification expiry is data-driven; the RFQ deadline tick rides the same schedule:
    // both cost one query when there is nothing to do.
    { name: 'verification_expiry', everyMs: env.VERIFICATION_SWEEP_MS, atStart: true, run: verificationExpiryScan(internalApi, logger.child({ module: 'supplier.verification' }), metrics.sweep('verification_expiry')) },
    { name: 'rfq_deadline', everyMs: env.VERIFICATION_SWEEP_MS, atStart: false, run: rfqDeadlineScan(internalApi, logger.child({ module: 'sourcing.rfq' }), metrics.sweep('rfq_deadline')) },
    { name: 'payment_reconcile', everyMs: env.PAYMENT_SWEEP_MS, atStart: false, run: paymentReconcileScan(internalApi, logger.child({ module: 'finance.payments' }), metrics.sweep('payment_reconcile')) },
    // F-11.1: queue stays, deadlines and escalations; a minute is the resolution of a deadline.
    { name: 'sla', everyMs: env.SLA_SWEEP_MS, atStart: true, run: slaEscalator(internalApi, logger.child({ module: 'platform.sla' }), metrics.sweep('sla')) },
    // IN-17: a delivery's window closes at the end of an IST day; a quarter-hour is resolution enough.
    { name: 'delivery_acceptance', everyMs: env.DELIVERY_SWEEP_MS, atStart: false, run: deliveryAcceptanceScan(internalApi, logger.child({ module: 'logistics.delivery' }), metrics.sweep('delivery_acceptance')) },
    // ADR-0009: Postgres rate-limit counters outlive their windows; this is housekeeping, not business state.
    {
      name: 'rate_limit_counters',
      everyMs: env.VERIFICATION_SWEEP_MS,
      atStart: false,
      run: async () => {
        await pool.query(`DELETE FROM platform.rate_limit_counter WHERE expires_at < now()`).catch((err: unknown) =>
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'rate-limit counter sweep failed'),
        );
      },
    },
  ];

  return {
    poller,
    sweeps,
    metrics,
    heartbeat: async () => {
      try {
        const r = await pool.query<{ backlog: number; oldest_s: number }>(
          `SELECT count(*)::int AS backlog,
                  COALESCE(EXTRACT(EPOCH FROM now() - min(next_attempt_at)), 0)::int AS oldest_s
             FROM platform.outbox_event WHERE status IN ('pending', 'processing')`,
        );
        logger.info({ backlog: r.rows[0]?.backlog ?? 0, oldestSeconds: r.rows[0]?.oldest_s ?? 0 }, 'worker heartbeat');
      } catch {
        logger.warn('heartbeat query failed');
      }
    },
  };
}
