import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_dmsdb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

describe('dms schema constraints', () => {
  let pg: Client;
  let orgA: string;
  let orgB: string;

  async function insertFile(org: string, sha: string): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO dms.file_object (storage_key, byte_size, declared_media_type, sha256, owning_organization_id)
       VALUES ($1, 100, 'application/pdf', $2, $3) RETURNING id`,
      [`quarantine/${randomBytes(8).toString('hex')}`, sha, org],
    );
    return res.rows[0]!.id;
  }

  async function insertDocument(org: string): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO dms.document (owning_organization_id, logical_type, title)
       VALUES ($1, 'drawing_2d', 'Bracket drawing') RETURNING id`,
      [org],
    );
    return res.rows[0]!.id;
  }

  async function insertVersion(docId: string, fileId: string, versionNo: number): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO dms.document_version (document_id, version_no, file_object_id, original_filename)
       VALUES ($1, $2, $3, 'bracket-rev-a.pdf') RETURNING id`,
      [docId, versionNo, fileId],
    );
    return res.rows[0]!.id;
  }

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
    const orgs = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ('customer', 'Acme Fab Pvt Ltd', 'Acme Fab'),
              ('supplier', 'Chennai Precision Works', 'CPW')
       RETURNING id`,
    );
    orgA = orgs.rows[0]!.id;
    orgB = orgs.rows[1]!.id;
  }, 60_000);

  afterAll(async () => {
    await pg.end();
    const admin = new Client({ connectionString: new URL('/postgres', BASE_URL).toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('document versions are unique per (document, version_no)', async () => {
    const doc = await insertDocument(orgA);
    const f1 = await insertFile(orgA, 'a'.repeat(64));
    const f2 = await insertFile(orgA, 'b'.repeat(64));
    await insertVersion(doc, f1, 1);
    await expect(insertVersion(doc, f2, 1)).rejects.toThrow(/duplicate key/);
    await insertVersion(doc, f2, 2); // next version number is fine
  });

  it('byte identity dedupes per organization, never across tenants (doc 05 §7)', async () => {
    const sha = 'c'.repeat(64);
    await insertFile(orgA, sha);
    await expect(insertFile(orgA, sha)).rejects.toThrow(/duplicate key/);
    // Same bytes owned by a different organization must remain a separate row.
    await insertFile(orgB, sha);
  });

  it('audience grants keep FK integrity and org presence matches audience type', async () => {
    const doc = await insertDocument(orgA);
    const file = await insertFile(orgA, 'd'.repeat(64));
    const version = await insertVersion(doc, file, 1);

    // Dangling version ref rejected.
    await expect(
      pg.query(
        `INSERT INTO dms.audience_grant (document_version_id, audience_type, organization_id)
         VALUES (gen_random_uuid(), 'organization', $1)`,
        [orgB],
      ),
    ).rejects.toThrow(/foreign key/);

    // audience_type = organization requires organization_id …
    await expect(
      pg.query(
        `INSERT INTO dms.audience_grant (document_version_id, audience_type)
         VALUES ($1, 'organization')`,
        [version],
      ),
    ).rejects.toThrow(/chk_grant_org/);

    // … and non-organization audiences must not carry one.
    await expect(
      pg.query(
        `INSERT INTO dms.audience_grant (document_version_id, audience_type, organization_id)
         VALUES ($1, 'internal', $2)`,
        [version, orgB],
      ),
    ).rejects.toThrow(/chk_grant_org/);

    await pg.query(
      `INSERT INTO dms.audience_grant (document_version_id, audience_type, organization_id)
       VALUES ($1, 'organization', $2)`,
      [version, orgB],
    );
  });

  it('scan_state only moves along the one-way machine (doc 09 §4)', async () => {
    const id = await insertFile(orgA, 'e'.repeat(64));

    // quarantined cannot jump straight to clean.
    await expect(
      pg.query(`UPDATE dms.file_object SET scan_state = 'clean' WHERE id = $1`, [id]),
    ).rejects.toThrow(/invalid scan_state transition/);

    await pg.query(`UPDATE dms.file_object SET scan_state = 'scanning' WHERE id = $1`, [id]);
    await pg.query(`UPDATE dms.file_object SET scan_state = 'failed' WHERE id = $1`, [id]);
    // failed may retry.
    await pg.query(`UPDATE dms.file_object SET scan_state = 'scanning' WHERE id = $1`, [id]);
    await pg.query(`UPDATE dms.file_object SET scan_state = 'clean' WHERE id = $1`, [id]);

    // clean is terminal — no un-cleaning, no re-quarantine of the verdict row.
    await expect(
      pg.query(`UPDATE dms.file_object SET scan_state = 'quarantined' WHERE id = $1`, [id]),
    ).rejects.toThrow(/invalid scan_state transition/);

    // infected is terminal — can never become clean.
    const bad = await insertFile(orgA, 'f'.repeat(64));
    await pg.query(`UPDATE dms.file_object SET scan_state = 'scanning' WHERE id = $1`, [bad]);
    await pg.query(`UPDATE dms.file_object SET scan_state = 'infected' WHERE id = $1`, [bad]);
    await expect(
      pg.query(`UPDATE dms.file_object SET scan_state = 'clean' WHERE id = $1`, [bad]),
    ).rejects.toThrow(/invalid scan_state transition/);

    // out-of-range values still rejected by the CHECK.
    await expect(
      pg.query(`UPDATE dms.file_object SET scan_state = 'released' WHERE id = $1`, [bad]),
    ).rejects.toThrow(/check constraint|invalid scan_state transition/);
  });

  it('access log is append-only: pre-revocation downloads are permanent facts (doc 19 §3)', async () => {
    const doc = await insertDocument(orgA);
    const file = await insertFile(orgA, '1'.repeat(64));
    const version = await insertVersion(doc, file, 1);
    await pg.query(
      `INSERT INTO dms.access_log (document_version_id, actor_id, organization_id, action)
       VALUES ($1, gen_random_uuid(), $2, 'download')`,
      [version, orgB],
    );
    await expect(
      pg.query(`DELETE FROM dms.access_log WHERE document_version_id = $1`, [version]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pg.query(`UPDATE dms.access_log SET action = 'preview' WHERE document_version_id = $1`, [
        version,
      ]),
    ).rejects.toThrow(/append-only/);
  });
});
