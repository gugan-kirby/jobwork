import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_sonbdb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * The onboarding rules that must hold even if every line of application code is wrong:
 * which network transitions exist, that a decision names a decider who is not the
 * person who asked for it, and that a supplier's works address belongs to the supplier.
 */
describe('supplier onboarding constraints (F-SO.1)', () => {
  let pg: Client;

  async function insertProfile(name: string): Promise<{ profile: string; organization: string }> {
    const org = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ('supplier', $1, $1) RETURNING id`,
      [name],
    );
    const organization = org.rows[0]!.id;
    const profile = await pg.query<{ id: string }>(
      `INSERT INTO supplier.supplier_profile (organization_id, region_class)
       VALUES ($1, 'chennai_metro') RETURNING id`,
      [organization],
    );
    return { profile: profile.rows[0]!.id, organization };
  }

  async function insertSite(organizationId: string, label: string): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization_site
         (organization_id, label, kind, address_line1, city, state, postal_code)
       VALUES ($1, $2, 'works', '12 Ambattur Industrial Estate', 'Chennai', 'Tamil Nadu', '600058')
       RETURNING id`,
      [organizationId, label],
    );
    return res.rows[0]!.id;
  }

  /** Moves a profile through submission with a distinct submitter and decider. */
  async function submit(profile: string): Promise<string> {
    const submitter = (await pg.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
    await pg.query(
      `UPDATE supplier.supplier_profile
          SET status = 'submitted', submitted_by = $2, submitted_for_approval_at = now()
        WHERE id = $1`,
      [profile, submitter],
    );
    return submitter;
  }

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('accepts every legal network transition and refuses the rest', async () => {
    const { profile } = await insertProfile('Legal transitions works');
    await submit(profile);
    await pg.query(
      `UPDATE supplier.supplier_profile
          SET status = 'active', decided_by = gen_random_uuid(), decided_at = now()
        WHERE id = $1`,
      [profile],
    );
    await pg.query(`UPDATE supplier.supplier_profile SET status = 'paused' WHERE id = $1`, [
      profile,
    ]);
    await pg.query(`UPDATE supplier.supplier_profile SET status = 'active' WHERE id = $1`, [
      profile,
    ]);

    // Admission never skips the decision: onboarding cannot jump straight to active.
    const { profile: second } = await insertProfile('Illegal transitions works');
    await expect(
      pg.query(
        `UPDATE supplier.supplier_profile
            SET status = 'active', decided_by = gen_random_uuid(), decided_at = now()
          WHERE id = $1`,
        [second],
      ),
    ).rejects.toThrow(/invalid supplier profile transition: onboarding -> active/);

    // Leaving the network is always available, from wherever the supplier stands — and
    // it must record when, so an award made while the supplier was in the network still
    // reads correctly (F-SN).
    await expect(
      pg.query(`UPDATE supplier.supplier_profile SET status = 'exited' WHERE id = $1`, [second]),
    ).rejects.toThrow(/chk_supplier_exited/);
    await pg.query(
      `UPDATE supplier.supplier_profile SET status = 'exited', exited_at = now() WHERE id = $1`,
      [second],
    );
    await expect(
      pg.query(`UPDATE supplier.supplier_profile SET status = 'onboarding' WHERE id = $1`, [second]),
    ).rejects.toThrow(/invalid supplier profile transition: exited -> onboarding/);
  });

  it('refuses an admitted supplier that names no decider', async () => {
    const { profile } = await insertProfile('Undecided works');
    await submit(profile);
    await expect(
      pg.query(`UPDATE supplier.supplier_profile SET status = 'active' WHERE id = $1`, [profile]),
    ).rejects.toThrow(/chk_supplier_decided/);
  });

  it('refuses a supplier that decides its own admission', async () => {
    const { profile } = await insertProfile('Self deciding works');
    const submitter = await submit(profile);
    await expect(
      pg.query(
        `UPDATE supplier.supplier_profile
            SET status = 'active', decided_by = $2, decided_at = now()
          WHERE id = $1`,
        [profile, submitter],
      ),
    ).rejects.toThrow(/chk_supplier_self_decision/);
  });

  it('refuses a works site belonging to another organization', async () => {
    const { profile, organization } = await insertProfile('Own site works');
    const { organization: otherOrganization } = await insertProfile('Other site works');
    const mine = await insertSite(organization, 'Ambattur unit');
    const theirs = await insertSite(otherOrganization, 'Ambattur unit');

    await pg.query(`UPDATE supplier.supplier_profile SET works_site_id = $2 WHERE id = $1`, [
      profile,
      mine,
    ]);
    await expect(
      pg.query(`UPDATE supplier.supplier_profile SET works_site_id = $2 WHERE id = $1`, [
        profile,
        theirs,
      ]),
    ).rejects.toThrow(/fk_supplier_works_site/);
  });

  it('keeps the earlier decision on a re-opened rejection until a new one replaces it', async () => {
    const { profile } = await insertProfile('Reopened works');
    const submitter = await submit(profile);
    const firstDecider = (await pg.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!
      .id;
    await pg.query(
      `UPDATE supplier.supplier_profile
          SET status = 'rejected', decided_by = $2, decided_at = now(),
              decision_reason = 'No quality system evidence'
        WHERE id = $1`,
      [profile, firstDecider],
    );
    await pg.query(`UPDATE supplier.supplier_profile SET status = 'onboarding' WHERE id = $1`, [
      profile,
    ]);

    const row = await pg.query<{
      status: string;
      decided_by: string;
      decision_reason: string;
      submitted_by: string;
    }>(
      `SELECT status, decided_by, decision_reason, submitted_by
         FROM supplier.supplier_profile WHERE id = $1`,
      [profile],
    );
    // Re-opening is a new chance, not an erasure: the refusal that happened is still
    // readable until a later decision overwrites it.
    expect(row.rows[0]).toMatchObject({
      status: 'onboarding',
      decided_by: firstDecider,
      decision_reason: 'No quality system evidence',
      submitted_by: submitter,
    });
  });
});
