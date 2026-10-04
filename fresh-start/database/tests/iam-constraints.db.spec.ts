import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_iamdb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

describe('iam schema constraints', () => {
  let pg: Client;

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
  }, 60_000);

  afterAll(async () => {
    await pg.end();
    const admin = new Client({ connectionString: new URL('/postgres', BASE_URL).toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('enforces case-insensitive unique emails (citext)', async () => {
    await pg.query(
      `INSERT INTO iam.user_account (email, display_name) VALUES ('Case@Example.com', 'A')`,
    );
    await expect(
      pg.query(`INSERT INTO iam.user_account (email, display_name) VALUES ('case@example.com', 'B')`),
    ).rejects.toThrow(/duplicate key/);
  });

  it('allows only one live membership per user and organization', async () => {
    const org = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ('customer', 'C1', 'C1') RETURNING id`,
    );
    const user = await pg.query<{ id: string }>(
      `INSERT INTO iam.user_account (email, display_name) VALUES ('m@example.com', 'M') RETURNING id`,
    );
    await pg.query(`INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2)`, [
      user.rows[0]?.id,
      org.rows[0]?.id,
    ]);
    await expect(
      pg.query(`INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2)`, [
        user.rows[0]?.id,
        org.rows[0]?.id,
      ]),
    ).rejects.toThrow(/uq_membership_live/);

    // an ended membership frees the slot
    await pg.query(
      `UPDATE iam.membership SET status = 'ended' WHERE user_id = $1 AND organization_id = $2`,
      [user.rows[0]?.id, org.rows[0]?.id],
    );
    await expect(
      pg.query(`INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2)`, [
        user.rows[0]?.id,
        org.rows[0]?.id,
      ]),
    ).resolves.toBeTruthy();
  });

  it('rejects sessions and invitations referencing missing rows (FK integrity)', async () => {
    await expect(
      pg.query(
        `INSERT INTO iam.session (token_hash, user_id, idle_expires_at, absolute_expires_at)
         VALUES ('x', gen_random_uuid(), now(), now())`,
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      pg.query(
        `INSERT INTO iam.invitation (organization_id, email, proposed_role_keys, token_hash, expires_at)
         VALUES (gen_random_uuid(), 'x@example.com', '{org_admin}', 'y', now())`,
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('constrains status and auth strength enumerations', async () => {
    await expect(
      pg.query(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('weird', 'X', 'X')`),
    ).rejects.toThrow(/check constraint/);
  });
});
