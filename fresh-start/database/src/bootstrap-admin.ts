import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Client } from 'pg';

export interface AdminBootstrap {
  email: string;
  password: string;
  displayName: string;
  /** JobWork's receiving hub: leg-1 shipments are addressed to it (IN-16). */
  hub: {
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
    contactName: string;
    contactPhone: string;
  };
}

/** Same values as `apps/api/src/modules/iam/domain/password.ts`, version 1. */
const PASSWORD_PARAMS_VERSION = 1;
const PASSWORD_MIN_LENGTH = 12;
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

/** The dev seed and E2E passwords: anyone who can read this repository knows them. */
const PUBLISHED_PASSWORDS: ReadonlySet<string> = new Set([
  'admin-dev-password-1',
  'demo-portal-password-1',
  'demo-vendor-password-1',
  'sourcing-dev-password-1',
  'e2e-journey-password-1',
]);

const INTERNAL_ORGANIZATION = 'JobWork Operations';
const ADMIN_ROLES = ['platform_admin', 'security_admin', 'org_admin'];
const BOOTSTRAPPED_EVENT = {
  eventType: 'iam.platform_admin.bootstrapped.v1',
  aggregateType: 'user',
};

function problemWith(input: AdminBootstrap): string | null {
  if (!input.email.includes('@')) return 'email is not an address';
  if (input.password.length < PASSWORD_MIN_LENGTH) return `password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (PUBLISHED_PASSWORDS.has(input.password)) return 'password is published in this repository';
  if (input.displayName.trim() === '') return 'displayName is required';
  const blank = Object.entries(input.hub).find(([, value]) => value.trim() === '');
  return blank ? `hub ${blank[0]} is required` : null;
}

/**
 * The protected path that creates a deployed environment's first admin, where the dev
 * seed must never run (doc 05 §16). It works once: every later account is an invitation.
 */
export async function bootstrapAdmin(
  databaseUrl: string,
  input: AdminBootstrap,
): Promise<{ userId: string; organizationId: string }> {
  const problem = problemWith(input);
  if (problem) throw new Error(problem);
  const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('iam.bootstrap_admin'))`);

    const existing = await client.query(
      `SELECT 1 FROM iam.membership m
         JOIN iam.membership_role mr ON mr.membership_id = m.id
         JOIN iam.role r ON r.id = mr.role_id
        WHERE r.key = 'platform_admin' AND m.status <> 'ended'`,
    );
    if (existing.rowCount !== 0) throw new Error('this environment already has a platform admin');

    const found = await client.query<{ id: string }>(
      `SELECT id FROM iam.organization WHERE type = 'internal' AND display_name = $1`,
      [INTERNAL_ORGANIZATION],
    );
    const organization =
      found.rows[0] ??
      (
        await client.query<{ id: string }>(
          `INSERT INTO iam.organization (type, legal_name, display_name)
           VALUES ('internal', 'JobWork', $1) RETURNING id`,
          [INTERNAL_ORGANIZATION],
        )
      ).rows[0]!;

    const user = (
      await client.query<{ id: string }>(
        `INSERT INTO iam.user_account
           (email, password_hash, password_params_version, display_name, status, email_verified_at)
         VALUES ($1, $2, $3, $4, 'active', now()) RETURNING id`,
        [input.email, passwordHash, PASSWORD_PARAMS_VERSION, input.displayName],
      )
    ).rows[0]!;

    const membership = (
      await client.query<{ id: string }>(
        `INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`,
        [user.id, organization.id],
      )
    ).rows[0]!;
    const roles = await client.query(
      `INSERT INTO iam.membership_role (membership_id, role_id)
       SELECT $1, r.id FROM iam.role r WHERE r.key = ANY($2)`,
      [membership.id, ADMIN_ROLES],
    );
    if (roles.rowCount !== ADMIN_ROLES.length) throw new Error('admin roles are missing; run the migrations first');

    const { hub } = input;
    await client.query(
      `INSERT INTO iam.organization_site
         (organization_id, label, kind, address_line1, city, state, postal_code, contact_name, contact_phone)
       VALUES ($1, 'JobWork receiving hub', 'works', $2, $3, $4, $5, $6, $7)`,
      [organization.id, hub.addressLine1, hub.city, hub.state, hub.postalCode, hub.contactName, hub.contactPhone],
    );

    // BR-SYS-02: the audit row and the event commit with the change they record.
    const correlationId = randomUUID();
    await client.query(
      `INSERT INTO platform.audit_event
         (actor_type, actor_id, organization_id, action, subject_type, subject_id, correlation_id)
       VALUES ('system', NULL, $1, 'iam.platform_admin_bootstrapped', 'user', $2, $3)`,
      [organization.id, user.id, correlationId],
    );
    await client.query(
      `INSERT INTO platform.outbox_event
         (event_type, aggregate_type, aggregate_id, organization_id, actor, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        BOOTSTRAPPED_EVENT.eventType,
        BOOTSTRAPPED_EVENT.aggregateType,
        user.id,
        organization.id,
        JSON.stringify({ type: 'system', id: null }),
        correlationId,
      ],
    );

    await client.query('COMMIT');
    return { userId: user.id, organizationId: organization.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

export function adminBootstrapFromEnv(env: NodeJS.ProcessEnv): AdminBootstrap {
  return {
    email: env['ADMIN_EMAIL'] ?? '',
    password: env['ADMIN_PASSWORD'] ?? '',
    displayName: env['ADMIN_NAME'] ?? 'Platform Admin',
    hub: {
      addressLine1: env['HUB_ADDRESS'] ?? '',
      city: env['HUB_CITY'] ?? '',
      state: env['HUB_STATE'] ?? '',
      postalCode: env['HUB_POSTAL_CODE'] ?? '',
      contactName: env['HUB_CONTACT_NAME'] ?? '',
      contactPhone: env['HUB_CONTACT_PHONE'] ?? '',
    },
  };
}
