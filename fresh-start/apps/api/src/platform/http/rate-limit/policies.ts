import { z } from 'zod';

/**
 * Rate-limit budgets by operation class (doc 08 §14; doc 11 §10; `AUTH-12`).
 *
 * Each class names what it costs and who could abuse it, and has its own budgets by
 * dimension: a credential-guessing run is counted per address and per account, a chatty
 * integration per person and per organization, the payment provider's callbacks per
 * provider — in their own buckets, so a flood of public traffic can never starve the
 * callbacks that say money arrived. Budgets are configuration (`DO-16`): the defaults
 * below are overridden by a validated `RATE_LIMIT_POLICIES` document, never edited per
 * environment in code.
 */

export const OPERATION_CLASSES = [
  'login',
  'public_form',
  'upload',
  'search',
  'message',
  'export',
  'payment',
  'webhook',
  'service',
  'command',
  'read',
] as const;
export type OperationClass = (typeof OPERATION_CLASSES)[number];

/**
 * - `ip`: the client address, as resolved through the trusted proxy hops (`TRUST_PROXY`).
 * - `account`: the account a credential attempt names — counted whether or not it exists.
 * - `session`: the session cookie, for steps inside one sign-in (the MFA code).
 * - `user` / `organization`: the signed-in actor and the organization it acts for.
 * - `provider`: the integration a callback claims to come from.
 * - `principal`: a named service principal (the worker).
 */
export const DIMENSIONS = ['ip', 'account', 'session', 'user', 'organization', 'provider', 'principal'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const budgetSchema = z.object({
  dimension: z.enum(DIMENSIONS),
  limit: z.number().int().positive(),
  windowSeconds: z.number().int().min(1).max(86_400),
});
export type Budget = z.infer<typeof budgetSchema>;
export type RatePolicies = Record<OperationClass, Budget[]>;

const MINUTE = 60;

export const DEFAULT_POLICIES: RatePolicies = {
  // Sign-in, MFA, registration, e-mail verification, invitation acceptance.
  login: [
    { dimension: 'ip', limit: 30, windowSeconds: 15 * MINUTE },
    { dimension: 'account', limit: 10, windowSeconds: 15 * MINUTE },
    { dimension: 'session', limit: 10, windowSeconds: 15 * MINUTE },
  ],
  // Anonymous forms that create records (supplier applications).
  public_form: [{ dimension: 'ip', limit: 10, windowSeconds: 60 * MINUTE }],
  upload: [
    { dimension: 'user', limit: 60, windowSeconds: 60 * MINUTE },
    { dimension: 'organization', limit: 300, windowSeconds: 60 * MINUTE },
  ],
  search: [{ dimension: 'user', limit: 120, windowSeconds: MINUTE }],
  message: [
    { dimension: 'user', limit: 30, windowSeconds: MINUTE },
    { dimension: 'organization', limit: 120, windowSeconds: MINUTE },
  ],
  // Documents leaving the platform: download grants, quotation and invoice PDFs.
  export: [
    { dimension: 'user', limit: 60, windowSeconds: 10 * MINUTE },
    { dimension: 'organization', limit: 300, windowSeconds: 10 * MINUTE },
  ],
  payment: [{ dimension: 'user', limit: 20, windowSeconds: 10 * MINUTE }],
  webhook: [{ dimension: 'provider', limit: 600, windowSeconds: MINUTE }],
  service: [{ dimension: 'principal', limit: 6000, windowSeconds: MINUTE }],
  command: [
    { dimension: 'user', limit: 120, windowSeconds: MINUTE },
    { dimension: 'ip', limit: 300, windowSeconds: MINUTE },
  ],
  read: [
    { dimension: 'user', limit: 600, windowSeconds: MINUTE },
    { dimension: 'ip', limit: 1200, windowSeconds: MINUTE },
  ],
};

const overridesSchema = z.partialRecord(z.enum(OPERATION_CLASSES), z.array(budgetSchema).min(1));

/** Defaults with any classes the override document replaces. Throws on an invalid document. */
export function resolvePolicies(json: string | undefined): RatePolicies {
  if (!json) return DEFAULT_POLICIES;
  const parsed = overridesSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new Error(`invalid RATE_LIMIT_POLICIES: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return { ...DEFAULT_POLICIES, ...(parsed.data as Partial<RatePolicies>) };
}
