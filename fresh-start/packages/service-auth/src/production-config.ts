/**
 * F-12.3 (doc 11 §11; doc 20 §9): a production process must not start on a credential
 * anyone can read. Every value below is public: a schema default, `.env.example`, or a
 * test fixture in this repository. Development and test keep working on them.
 */
export const PUBLIC_DEV_VALUES: ReadonlySet<string> = new Set([
  'dev-only-change-me',
  'dev-service-token-secret',
  'dev-payment-webhook-secret',
  'test-secret-value',
  'test-service-token-secret',
  'test-payment-webhook-secret',
  'minioadmin',
  'jobwork-dev',
  'jobwork-dev-secret',
]);

/** Shortest signing secret production accepts: 32 characters, about 192 bits if random. */
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

export interface ProductionConfigRules {
  /** HMAC and session secrets: long, and never a public value. */
  secrets: readonly string[];
  /** Credentials issued by a provider (access key ids, passwords): never a public value. */
  credentials?: readonly string[];
  /** Settings whose development default must be replaced, e.g. a localhost database. */
  replaced?: Readonly<Record<string, string>>;
}

/** Why this configuration must not run in production; empty outside production. */
export function productionConfigProblems(env: Readonly<Record<string, unknown>>, rules: ProductionConfigRules): string[] {
  if (env['NODE_ENV'] !== 'production') return [];
  const problems: string[] = [];
  for (const key of rules.secrets) {
    const value = typeof env[key] === 'string' ? (env[key] as string) : '';
    if (PUBLIC_DEV_VALUES.has(value)) problems.push(`${key}: a development value from this repository; set a real secret`);
    else if (value.length < MIN_PRODUCTION_SECRET_LENGTH) problems.push(`${key}: shorter than ${MIN_PRODUCTION_SECRET_LENGTH} characters`);
  }
  for (const key of rules.credentials ?? []) {
    const value = typeof env[key] === 'string' ? (env[key] as string) : '';
    if (value === '' || PUBLIC_DEV_VALUES.has(value)) problems.push(`${key}: a development value from this repository; set the real credential`);
  }
  for (const [key, devDefault] of Object.entries(rules.replaced ?? {})) {
    if (env[key] === devDefault) problems.push(`${key}: still the development default`);
  }
  return problems;
}
