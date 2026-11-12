import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../src/bootstrap-admin';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { addStaff } from '../src/staff';

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_staffdb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

const OWNER = 'owner@jobwork.test';

/**
 * A deployed environment's staff before anyone can invite them from the console, and a
 * demo's one owner who needs every screen: roles granted directly, audited, within the
 * separation-of-duties rules.
 */
describe('staff roles granted without an invitation', () => {
  let pg: Client;

  async function rolesOf(email: string): Promise<string[]> {
    const rows = await pg.query<{ key: string }>(
      `SELECT r.key FROM iam.user_account u
         JOIN iam.membership m ON m.user_id = u.id
         JOIN iam.membership_role mr ON mr.membership_id = m.id
         JOIN iam.role r ON r.id = mr.role_id
        WHERE u.email = $1 ORDER BY r.key`,
      [email],
    );
    return rows.rows.map((r) => r.key);
  }

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
    await bootstrapAdmin(url(), {
      email: OWNER,
      password: 'a-long-unpublished-passphrase',
      displayName: 'Platform Owner',
      hub: { addressLine1: '12 Industrial Road', city: 'Chennai', state: 'Tamil Nadu', postalCode: '600032', contactName: 'Receiving desk', contactPhone: '+91 90000 00000' },
    });
  });

  afterAll(async () => {
    await pg.end();
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('adds operational roles to the existing owner, once, with an audit row and an event', async () => {
    const first = await addStaff(url(), { email: OWNER, displayName: 'Platform Owner', roles: ['jobwork_sourcing', 'jobwork_engineering'] });
    expect(first.created).toBe(false);
    expect(first.added).toEqual(['jobwork_engineering', 'jobwork_sourcing']);
    expect(await rolesOf(OWNER)).toEqual(['jobwork_engineering', 'jobwork_sourcing', 'org_admin', 'platform_admin', 'security_admin']);

    const again = await addStaff(url(), { email: OWNER, displayName: 'Platform Owner', roles: ['jobwork_sourcing'] });
    expect(again.added).toEqual([]);

    const audit = await pg.query<{ data: { roles: string[] }; correlation_id: string }>(
      `SELECT data, correlation_id FROM platform.audit_event WHERE action = 'iam.staff_roles_granted'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.data.roles).toEqual(['jobwork_engineering', 'jobwork_sourcing']);
    const outbox = await pg.query<{ correlation_id: string }>(
      `SELECT correlation_id FROM platform.outbox_event WHERE event_type = 'iam.staff.roles_granted.v1'`,
    );
    expect(outbox.rows.map((r) => r.correlation_id)).toEqual([audit.rows[0]!.correlation_id]);
  });

  it('creates a new staff account with a bcrypt password when asked', async () => {
    const result = await addStaff(url(), {
      email: 'finance@jobwork.test',
      displayName: 'Finance',
      roles: ['jobwork_finance'],
      password: 'another-unpublished-passphrase',
      passwordHasher: 'pgcrypto-bcrypt',
    });
    expect(result.created).toBe(true);
    expect(await rolesOf('finance@jobwork.test')).toEqual(['jobwork_finance']);
    const row = await pg.query<{ version: number; status: string; ok: boolean }>(
      `SELECT password_params_version AS version, status, crypt($2, password_hash) = password_hash AS ok
         FROM iam.user_account WHERE email = $1`,
      ['finance@jobwork.test', 'another-unpublished-passphrase'],
    );
    expect(row.rows[0]).toEqual({ version: 2, status: 'active', ok: true });
  });

  it('refuses a missing account without a password, unknown roles, and forbidden combinations', async () => {
    await expect(addStaff(url(), { email: 'nobody@jobwork.test', displayName: 'Nobody', roles: ['jobwork_sales'] })).rejects.toThrow(/give a password/);
    await expect(addStaff(url(), { email: OWNER, displayName: 'Platform Owner', roles: ['jobwork_wizard'] })).rejects.toThrow(/unknown internal roles: jobwork_wizard/);
    await expect(addStaff(url(), { email: 'finance@jobwork.test', displayName: 'Finance', roles: ['jobwork_sales'] })).rejects.toThrow(/separation of duties/);
    expect(await rolesOf('finance@jobwork.test')).toEqual(['jobwork_finance']);
    await expect(addStaff(url(), { email: OWNER, displayName: 'Platform Owner', roles: ['platform_admin'] })).rejects.toThrow(/unknown internal roles/);
  });
});
