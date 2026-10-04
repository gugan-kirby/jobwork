import { Injectable } from '@nestjs/common';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().default('postgres://localhost:5432/jobwork_dev'),
  SESSION_COOKIE_NAME: z.string().default('jw_session'),
  SESSION_SECRET: z.string().min(8),
  SERVICE_TOKEN_SECRET: z.string().min(8).default('dev-service-token-secret'),
  LOG_LEVEL: z.string().default('info'),
  OBJECT_STORE_ENDPOINT: z.string().default('http://localhost:9000'),
  OBJECT_STORE_ACCESS_KEY: z.string().default('minioadmin'),
  OBJECT_STORE_SECRET_KEY: z.string().default('minioadmin'),
  OBJECT_STORE_BUCKET_QUARANTINE: z.string().default('jobwork-quarantine'),
  OBJECT_STORE_BUCKET_CLEAN: z.string().default('jobwork-clean'),
  OBJECT_STORE_REGION: z.string().default('us-east-1'),
  UPLOAD_GRANT_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  DOWNLOAD_GRANT_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(120),
  PORTAL_URL: z.string().default('http://localhost:3000'),
  /** Where JobWork staff open records; notification links for internal recipients point here. */
  OPERATIONS_URL: z.string().default('http://localhost:3001'),
  /** `T-03`: the payment provider behind the gateway port. `dev` is the simulated gateway. */
  PAYMENT_PROVIDER: z.enum(['dev']).default('dev'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(8).default('dev-payment-webhook-secret'),
  PAYMENT_INTENT_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  /** F-11.2: rate-limit counters. Empty keeps them in this process only. */
  REDIS_URL: z.string().default('redis://localhost:6379'),
  RATE_LIMIT_MODE: z.enum(['enforce', 'observe', 'off']).default('enforce'),
  /** JSON document replacing the budgets of named operation classes (`policies.ts`). */
  RATE_LIMIT_POLICIES: z.string().optional(),
  RATE_LIMIT_PREFIX: z.string().regex(/^[a-z0-9:_-]{1,40}$/).default('rl'),
  /**
   * Which proxy hops may name the client address in `X-Forwarded-For` (Fastify
   * `trustProxy`: `loopback`, or a comma-separated address/CIDR list; `false` for none).
   * Hop counts and `true` are refused: neither checks that the peer is a proxy. The web
   * apps' rewrite proxy is a loopback hop locally; deployed, name the edge and web hosts.
   */
  TRUST_PROXY: z.string().default('loopback'),
  /** F-11.3: Prometheus metrics on their own port; 0 serves none (tests). Never the API port. */
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  METRICS_HOST: z.string().default('127.0.0.1'),
});

export type Env = z.infer<typeof envSchema>;

@Injectable()
export class ConfigService {
  readonly env: Env;
  readonly buildVersion: string;

  constructor() {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new Error(`invalid environment configuration: ${issues}`);
    }
    this.env = parsed.data;
    this.buildVersion = process.env['BUILD_SHA'] ?? 'dev';
  }
}
