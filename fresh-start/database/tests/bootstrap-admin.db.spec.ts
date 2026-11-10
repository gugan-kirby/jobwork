import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import argon2 from 'argon2';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin, type AdminBootstrap } from '../src/bootstrap-admin';
import { ensureDatabase, runMigrations } from '../src/migrate';

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_bootdb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

const INPUT: AdminBootstrap = {
  email: 'owner@jobwork.test',
  password: 'a-long-unpublished-passphrase',
  displayName: 'Platform Owner',
  hub: {
    addressLine1: '12 Industrial Road',
    city: 'Chennai',
    state: 'Tamil Nadu',
    postalCode: '600032',
    contactName: 'Receiving desk',
    contactPhone: '+91 90000 00000',
  },
};

/**
 * A deployed environment has no dev seed: its accounts carry passwords published in this
 * repository (doc 05 §16). This is the protected path that creates the first admin there.
 */
describe('first admin bootstrap', () => {
  let pg: Client;

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
  });

  afterAll(async () => {
    await pg.end();
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('refuses a short password and a password this repository publishes', async () => {
    await expect(bootstrapAdmin(url(), { ...INPUT, password: 'too-short' })).rejects.toThrow(/at least 12/);
    await expect(bootstrapAdmin(url(), { ...INPUT, password: 'admin-dev-password-1' })).rejects.toThrow(/published/);
  });

  it('refuses a blank hub address', async () => {
    await expect(
      bootstrapAdmin(url(), { ...INPUT, hub: { ...INPUT.hub, addressLine1: '  ' } }),
    ).rejects.toThrow(/addressLine1/);
    const users = await pg.query(`SELECT 1 FROM iam.user_account`);
    expect(users.rowCount).toBe(0);
  });

  it('creates the internal organization, the admin and the receiving hub in one change', async () => {
    const { userId, organizationId } = await bootstrapAdmin(url(), INPUT);

    const user = await pg.query<{ status: string; email_verified_at: Date | null; password_hash: string }>(
      `SELECT status, email_verified_at, password_hash FROM iam.user_account WHERE id = $1`,
      [userId],
    );
    expect(user.rows[0]).toMatchObject({ status: 'active' });
    expect(user.rows[0]!.email_verified_at).not.toBeNull();
    expect(await argon2.verify(user.rows[0]!.password_hash, INPUT.password)).toBe(true);

    const roles = await pg.query<{ key: string }>(
      `SELECT r.key FROM iam.membership m
         JOIN iam.membership_role mr ON mr.membership_id = m.id
         JOIN iam.role r ON r.id = mr.role_id
        WHERE m.user_id = $1 AND m.organization_id = $2 ORDER BY r.key`,
      [userId, organizationId],
    );
    expect(roles.rows.map((r) => r.key)).toEqual(['org_admin', 'platform_admin', 'security_admin']);

    const hub = await pg.query(
      `SELECT city, contact_name FROM iam.organization_site
        WHERE organization_id = $1 AND kind = 'works' AND status = 'active'`,
      [organizationId],
    );
    expect(hub.rows).toEqual([{ city: 'Chennai', contact_name: 'Receiving desk' }]);
  });

  it('records the change in the audit log and the outbox', async () => {
    const audit = await pg.query<{ actor_type: string; correlation_id: string }>(
      `SELECT actor_type, correlation_id FROM platform.audit_event WHERE action = 'iam.platform_admin_bootstrapped'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.actor_type).toBe('system');

    const outbox = await pg.query<{ correlation_id: string }>(
      `SELECT correlation_id FROM platform.outbox_event WHERE event_type = 'iam.platform_admin.bootstrapped.v1'`,
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]!.correlation_id).toBe(audit.rows[0]!.correlation_id);
  });

  it('hashes with bcrypt in Postgres for a Workers API (ADR-0009)', async () => {
    const other = `${TEST_DB}_bcrypt`;
    const otherUrl = new URL(url());
    otherUrl.pathname = `/${other}`;
    await ensureDatabase(otherUrl.toString());
    try {
      await runMigrations(otherUrl.toString(), join(__dirname, '..', 'migrations'));
      const { userId } = await bootstrapAdmin(otherUrl.toString(), { ...INPUT, passwordHasher: 'pgcrypto-bcrypt' });
      const check = new Client({ connectionString: otherUrl.toString() });
      await check.connect();
      try {
        const row = await check.query<{ version: number; prefix: string; ok: boolean; wrong: boolean }>(
          `SELECT password_params_version AS version, left(password_hash, 7) AS prefix,
                  crypt($2, password_hash) = password_hash AS ok,
                  crypt($3, password_hash) = password_hash AS wrong
             FROM iam.user_account WHERE id = $1`,
          [userId, INPUT.password, `${INPUT.password}x`],
        );
        expect(row.rows[0]).toEqual({ version: 2, prefix: '$2a$10$', ok: true, wrong: false });
      } finally {
        await check.end();
      }
    } finally {
      const admin = new Client({ connectionString: BASE_URL });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS "${other}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('runs once: a second admin comes through an invitation', async () => {
    await expect(bootstrapAdmin(url(), { ...INPUT, email: 'second@jobwork.test' })).rejects.toThrow(/already has a platform admin/);
    const users = await pg.query(`SELECT 1 FROM iam.user_account`);
    expect(users.rowCount).toBe(1);
  });
});
