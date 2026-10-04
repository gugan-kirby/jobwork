import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_suppdb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

describe('supplier schema constraints', () => {
  let pg: Client;
  let profileA: string;
  let millingId: string;

  async function insertProfile(name: string): Promise<string> {
    const org = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ('supplier', $1, $1) RETURNING id`,
      [name],
    );
    const profile = await pg.query<{ id: string }>(
      `INSERT INTO supplier.supplier_profile (organization_id, region_class)
       VALUES ($1, 'chennai_metro') RETURNING id`,
      [org.rows[0]!.id],
    );
    return profile.rows[0]!.id;
  }

  async function publishCapability(profile: string, versionNo: number): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO supplier.supplier_capability
         (supplier_profile_id, capability_id, version_no, attributes)
       VALUES ($1, $2, $3, '{"toleranceClass":"IT7"}'::jsonb) RETURNING id`,
      [profile, millingId, versionNo],
    );
    return res.rows[0]!.id;
  }

  async function insertVerification(
    profile: string,
    kind: string,
    status = 'draft',
  ): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO supplier.verification_item (supplier_profile_id, kind, status, submitted_by)
       VALUES ($1, $2, $3, gen_random_uuid()) RETURNING id`,
      [profile, kind, status],
    );
    return res.rows[0]!.id;
  }

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
    profileA = await insertProfile('Chennai Precision');
    const capability = await pg.query<{ id: string }>(
      `SELECT id FROM supplier.capability WHERE code = 'cnc_milling'`,
    );
    millingId = capability.rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('seeds the launch taxonomy and keeps codes unique', async () => {
    const codes = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM supplier.capability WHERE status = 'active'`,
    );
    expect(codes.rows[0]!.n).toBeGreaterThanOrEqual(18);
    await expect(
      pg.query(
        `INSERT INTO supplier.capability (code, kind, label) VALUES ('cnc_milling','process','Dup')`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('allows one live declaration per capability and keeps superseded versions readable', async () => {
    const v1 = await publishCapability(profileA, 1);
    await expect(publishCapability(profileA, 2)).rejects.toThrow(/uq_supplier_capability_live/);

    await pg.query(`UPDATE supplier.supplier_capability SET status = 'superseded' WHERE id = $1`, [
      v1,
    ]);
    const v2 = await publishCapability(profileA, 2);
    expect(v2).not.toBe(v1);

    // A settled version is evidence: it cannot be edited or removed afterwards.
    await expect(
      pg.query(
        `UPDATE supplier.supplier_capability SET attributes = '{"toleranceClass":"IT5"}'::jsonb WHERE id = $1`,
        [v1],
      ),
    ).rejects.toThrow(/settled and cannot be edited/);
    await expect(
      pg.query(`DELETE FROM supplier.supplier_capability WHERE id = $1`, [v1]),
    ).rejects.toThrow(/settled and cannot be edited/);

    const old = await pg.query<{ attributes: { toleranceClass: string } }>(
      `SELECT attributes FROM supplier.supplier_capability WHERE id = $1`,
      [v1],
    );
    expect(old.rows[0]!.attributes.toleranceClass).toBe('IT7');
  });

  it('validates the machine envelope structurally rather than trusting it', async () => {
    await expect(
      pg.query(
        `INSERT INTO supplier.machine
           (supplier_profile_id, machine_key, version_no, label, envelope)
         VALUES ($1, 'vmc-1', 1, 'VMC 850', '{"xMm":"800","yMm":500,"zMm":500}'::jsonb)`,
        [profileA],
      ),
    ).rejects.toThrow(/chk_machine_envelope/);

    await expect(
      pg.query(
        `INSERT INTO supplier.machine
           (supplier_profile_id, machine_key, version_no, label, envelope)
         VALUES ($1, 'vmc-1', 1, 'VMC 850', '{"xMm":800,"yMm":500}'::jsonb)`,
        [profileA],
      ),
    ).rejects.toThrow(/chk_machine_envelope/);

    const ok = await pg.query<{ id: string }>(
      `INSERT INTO supplier.machine
         (supplier_profile_id, machine_key, version_no, label, envelope, axes)
       VALUES ($1, 'vmc-1', 1, 'VMC 850', '{"xMm":800,"yMm":500,"zMm":500,"maxWeightKg":600}'::jsonb, 3)
       RETURNING id`,
      [profileA],
    );
    expect(ok.rowCount).toBe(1);
  });

  it('walks the verification lifecycle and refuses illegal jumps (doc 06 §14)', async () => {
    const item = await insertVerification(profileA, 'gst');
    const reviewer = randomBytes(16);

    await expect(
      pg.query(`UPDATE supplier.verification_item SET status = 'verified' WHERE id = $1`, [item]),
    ).rejects.toThrow(/invalid verification transition/);

    await pg.query(`UPDATE supplier.verification_item SET status = 'submitted' WHERE id = $1`, [item]);
    await pg.query(`UPDATE supplier.verification_item SET status = 'under_review' WHERE id = $1`, [item]);
    await pg.query(
      `UPDATE supplier.verification_item
          SET status = 'verified', reviewed_by = gen_random_uuid(), reviewed_at = now()
        WHERE id = $1`,
      [item],
    );
    // verified -> submitted is not a legal way back; re-verification appends instead.
    await expect(
      pg.query(`UPDATE supplier.verification_item SET status = 'submitted' WHERE id = $1`, [item]),
    ).rejects.toThrow(/invalid verification transition/);
    expect(reviewer.length).toBe(16);
  });

  it('refuses a verified item without a reviewer, and a reviewer who is the submitter', async () => {
    const item = await insertVerification(profileA, 'pan');
    await pg.query(`UPDATE supplier.verification_item SET status = 'submitted' WHERE id = $1`, [item]);
    await pg.query(`UPDATE supplier.verification_item SET status = 'under_review' WHERE id = $1`, [item]);

    await expect(
      pg.query(`UPDATE supplier.verification_item SET status = 'verified' WHERE id = $1`, [item]),
    ).rejects.toThrow(/chk_verification_reviewed/);

    const submitter = await pg.query<{ submitted_by: string }>(
      `SELECT submitted_by FROM supplier.verification_item WHERE id = $1`,
      [item],
    );
    await expect(
      pg.query(
        `UPDATE supplier.verification_item
            SET status = 'verified', reviewed_by = $2, reviewed_at = now()
          WHERE id = $1`,
        [item, submitter.rows[0]!.submitted_by],
      ),
    ).rejects.toThrow(/chk_verification_self_review/);
  });

  it('projects eligibility from live capabilities and current verification only', async () => {
    const profile = await insertProfile('Eligibility Works');
    await pg.query(
      `INSERT INTO supplier.supplier_capability (supplier_profile_id, capability_id, version_no)
       VALUES ($1, $2, 1)`,
      [profile, millingId],
    );

    const before = await pg.query<{ mandatory_verified_count: string }>(
      `SELECT mandatory_verified_count FROM supplier.eligibility WHERE supplier_profile_id = $1`,
      [profile],
    );
    expect(Number(before.rows[0]!.mandatory_verified_count)).toBe(0);

    for (const kind of ['gst', 'pan', 'bank_account']) {
      const item = await insertVerification(profile, kind);
      await pg.query(`UPDATE supplier.verification_item SET status = 'submitted' WHERE id = $1`, [item]);
      await pg.query(`UPDATE supplier.verification_item SET status = 'under_review' WHERE id = $1`, [item]);
      await pg.query(
        `UPDATE supplier.verification_item
            SET status = 'verified', reviewed_by = gen_random_uuid(), reviewed_at = now(),
                expires_at = now() + interval '30 days'
          WHERE id = $1`,
        [item],
      );
    }

    const after = await pg.query<{ mandatory_verified_count: string }>(
      `SELECT mandatory_verified_count FROM supplier.eligibility WHERE supplier_profile_id = $1`,
      [profile],
    );
    expect(Number(after.rows[0]!.mandatory_verified_count)).toBe(3);

    // An expiry in the past drops out of the projection without touching the row's history.
    await pg.query(
      `UPDATE supplier.verification_item SET expires_at = now() - interval '1 minute'
        WHERE supplier_profile_id = $1 AND kind = 'gst'`,
      [profile],
    );
    const expired = await pg.query<{ mandatory_verified_count: string }>(
      `SELECT mandatory_verified_count FROM supplier.eligibility WHERE supplier_profile_id = $1`,
      [profile],
    );
    expect(Number(expired.rows[0]!.mandatory_verified_count)).toBe(2);
    const history = await pg.query<{ status: string }>(
      `SELECT status FROM supplier.verification_item WHERE supplier_profile_id = $1 AND kind = 'gst'`,
      [profile],
    );
    expect(history.rows[0]!.status).toBe('verified');
  });
});
