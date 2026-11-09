import { productionConfigProblems } from '@jobwork/service-auth';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgres://localhost:5432/jobwork_dev'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
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
  /** `smtp`: send through SMTP_URL (`log://` writes files). `api`: keep each mail for the operations Mail page (F-CW.5). */
  MAIL_TRANSPORT: z.enum(['smtp', 'api']).default('smtp'),
  SMTP_URL: z.string().default('log://'),
  /** The From header, e.g. `JobWork <jobwork.staging@gmail.com>`. Required with SMTP. */
  SMTP_FROM: z.string().default(''),
  WORKER_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(60_000),
  VERIFICATION_SWEEP_MS: z.coerce.number().int().min(1000).default(15 * 60_000),
  OUTBOX_POLL_MS: z.coerce.number().int().min(200).default(2_000),
  PAYMENT_SWEEP_MS: z.coerce.number().int().min(1000).default(5 * 60_000),
  SLA_SWEEP_MS: z.coerce.number().int().min(1000).default(60_000),
  /** IN-17: how often to ask whether a delivery's acceptance window has closed. */
  DELIVERY_SWEEP_MS: z.coerce.number().int().min(1000).default(15 * 60_000),
  /** F-11.3: Prometheus metrics on their own port; 0 serves none. */
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  METRICS_HOST: z.string().default('127.0.0.1'),
});

export type WorkerConfig = z.infer<typeof envSchema>;

/** The worker's settings, refused in production where they are published defaults (F-12.3). */
export function parseWorkerConfig(source: Record<string, string | undefined>): WorkerConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `invalid environment configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const problems = productionConfigProblems(parsed.data, {
    secrets: ['SERVICE_TOKEN_SECRET'],
    credentials: ['OBJECT_STORE_ACCESS_KEY', 'OBJECT_STORE_SECRET_KEY'],
    // log:// writes mail to a local file, and production shows nobody the links in it.
    replaced: {
      DATABASE_URL: 'postgres://localhost:5432/jobwork_dev',
      ...(parsed.data.MAIL_TRANSPORT === 'smtp' ? { SMTP_URL: 'log://' } : {}),
    },
  });
  if (problems.length > 0) throw new Error(`refusing to start in production: ${problems.join('; ')}`);
  return parsed.data;
}
