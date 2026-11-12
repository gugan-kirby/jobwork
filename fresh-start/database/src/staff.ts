import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Client } from 'pg';

export interface StaffGrant {
  email: string;
  displayName: string;
  /** Internal role keys (`iam.role`), added to whatever the person already holds. */
  roles: string[];
  /** Required when the account does not exist yet; ignored otherwise. */
  password?: string | undefined;
  /** The API's `PASSWORD_HASHER` (see `bootstrap-admin.ts`). */
  passwordHasher?: 'argon2id' | 'pgcrypto-bcrypt' | undefined;
}

export interface StaffGrantResult {
  userId: string;
  created: boolean;
  /** The roles that were added; empty when the person already held them all. */
  added: string[];
}

/** Same values as `apps/api/src/modules/iam/domain/password.ts` and its hashers. */
const ARGON2ID_PARAMS_VERSION = 1;
const BCRYPT_PARAMS_VERSION = 2;
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

/**
 * Role pairs one person may not hold (doc 03 §5). The API's
 * `modules/iam/domain/separation-of-duties.ts` is the source of truth and refuses them
 * on invitation; this path grants without an invitation, so it checks the same pairs.
 */
const FORBIDDEN_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['jobwork_sales', 'jobwork_finance'],
  ['jobwork_finance', 'jobwork_quality'],
];

const INTERNAL_ORGANIZATION = 'JobWork Operations';
const GRANTED_EVENT = {
  eventType: 'iam.staff.roles_granted.v1',
  aggregateType: 'user',
};

function problemWith(input: StaffGrant): string | null {
  if (!input.email.includes('@')) return 'email is not an address';
  if (input.displayName.trim() === '') return 'displayName is required';
  if (input.roles.length === 0) return 'at least one role is required';
  if (input.roles.some((r) => !/^[a-z_]+$/.test(r))) return 'role keys are lower-case words';
  if (input.password !== undefined) {
    if (input.password.length < PASSWORD_MIN_LENGTH) return `password must be at least ${PASSWORD_MIN_LENGTH} characters`;
    if (PUBLISHED_PASSWORDS.has(input.password)) return 'password is published in this repository';
  }
  return null;
}

function conflictIn(held: ReadonlySet<string>): string | null {
  const pair = FORBIDDEN_PAIRS.find(([a, b]) => held.has(a) && held.has(b));
  return pair ? `${pair[0]} and ${pair[1]} may not be held by one person (separation of duties)` : null;
}

/**
 * Gives a JobWork staff member internal roles, creating the account when it does not
 * exist: the way a deployed environment gets its operational staff before anyone can
 * invite them from the console, and how a demo's one owner gets every screen. Writes the
 * audit row and the outbox event with the change (BR-SYS-02). Runs as often as needed:
 * roles already held are left alone.
 */
export async function addStaff(databaseUrl: string, input: StaffGrant): Promise<StaffGrantResult> {
  const problem = problemWith(input);
  if (problem) throw new Error(problem);
  const bcrypt = input.passwordHasher === 'pgcrypto-bcrypt';

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('iam.staff'))`);

    const organization = await client.query<{ id: string }>(
      `SELECT id FROM iam.organization WHERE type = 'internal' AND display_name = $1`,
      [INTERNAL_ORGANIZATION],
    );
    const organizationId = organization.rows[0]?.id;
    if (!organizationId) throw new Error('no internal organization yet; run bootstrap-admin first');

    const roles = await client.query<{ id: string; key: string }>(
      `SELECT id, key FROM iam.role WHERE key = ANY($1) AND key LIKE 'jobwork_%'`,
      [input.roles],
    );
    const unknown = input.roles.filter((key) => !roles.rows.some((r) => r.key === key));
    if (unknown.length > 0) throw new Error(`unknown internal roles: ${unknown.join(', ')}`);

    let created = false;
    let user = (await client.query<{ id: string }>(`SELECT id FROM iam.user_account WHERE email = $1`, [input.email])).rows[0];
    if (!user) {
      if (input.password === undefined) throw new Error(`${input.email} does not exist; give a password to create the account`);
      const passwordHash = bcrypt
        ? (await client.query<{ hash: string }>(`SELECT crypt($1, gen_salt('bf', 10)) AS hash`, [input.password])).rows[0]!.hash
        : await argon2.hash(input.password, ARGON2_OPTIONS);
      user = (
        await client.query<{ id: string }>(
          `INSERT INTO iam.user_account
             (email, password_hash, password_params_version, display_name, status, email_verified_at)
           VALUES ($1, $2, $3, $4, 'active', now()) RETURNING id`,
          [input.email, passwordHash, bcrypt ? BCRYPT_PARAMS_VERSION : ARGON2ID_PARAMS_VERSION, input.displayName.trim()],
        )
      ).rows[0]!;
      created = true;
    }

    let membership = (
      await client.query<{ id: string }>(
        `SELECT id FROM iam.membership WHERE user_id = $1 AND organization_id = $2 AND status <> 'ended'`,
        [user.id, organizationId],
      )
    ).rows[0];
    if (!membership) {
      membership = (
        await client.query<{ id: string }>(
          `INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`,
          [user.id, organizationId],
        )
      ).rows[0]!;
    }

    const held = new Set(
      (
        await client.query<{ key: string }>(
          `SELECT r.key FROM iam.membership_role mr JOIN iam.role r ON r.id = mr.role_id WHERE mr.membership_id = $1`,
          [membership.id],
        )
      ).rows.map((r) => r.key),
    );
    const added = roles.rows.filter((r) => !held.has(r.key)).map((r) => r.key).sort();
    const conflict = conflictIn(new Set([...held, ...added]));
    if (conflict) throw new Error(conflict);

    if (added.length > 0) {
      await client.query(
        `INSERT INTO iam.membership_role (membership_id, role_id)
         SELECT $1, r.id FROM iam.role r WHERE r.key = ANY($2)`,
        [membership.id, added],
      );
      // BR-SYS-02: the audit row and the event commit with the change they record.
      const correlationId = randomUUID();
      await client.query(
        `INSERT INTO platform.audit_event
           (actor_type, actor_id, organization_id, action, subject_type, subject_id, correlation_id, data)
         VALUES ('system', NULL, $1, 'iam.staff_roles_granted', 'user', $2, $3, $4)`,
        [organizationId, user.id, correlationId, JSON.stringify({ roles: added, created })],
      );
      await client.query(
        `INSERT INTO platform.outbox_event
           (event_type, aggregate_type, aggregate_id, organization_id, actor, correlation_id, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          GRANTED_EVENT.eventType,
          GRANTED_EVENT.aggregateType,
          user.id,
          organizationId,
          JSON.stringify({ type: 'system', id: null }),
          correlationId,
          JSON.stringify({ email: input.email, roles: added }),
        ],
      );
    }

    await client.query('COMMIT');
    return { userId: user.id, created, added };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

export function staffGrantFromEnv(env: NodeJS.ProcessEnv): StaffGrant {
  return {
    email: env['STAFF_EMAIL'] ?? '',
    displayName: env['STAFF_NAME'] ?? 'JobWork staff',
    roles: (env['STAFF_ROLES'] ?? '').split(',').map((r) => r.trim()).filter(Boolean),
    password: env['STAFF_PASSWORD'] || undefined,
    passwordHasher: env['PASSWORD_HASHER'] === 'pgcrypto-bcrypt' ? 'pgcrypto-bcrypt' : 'argon2id',
  };
}
