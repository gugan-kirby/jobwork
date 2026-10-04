import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { registerPgTypeParsers } from '../src/pg-types';

registerPgTypeParsers();

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_enqdb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

describe('sourcing schema constraints (F-05.1)', () => {
  let pg: Client;
  let customerOrg: string;

  async function insertEnquiry(
    status = 'draft',
    extra: Record<string, string | null> = {},
  ): Promise<string> {
    const columns = ['customer_organization_id', 'status', ...Object.keys(extra)];
    const values = [customerOrg, status, ...Object.values(extra)];
    const res = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.enquiry (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      values,
    );
    return res.rows[0]!.id;
  }

  async function insertItem(enquiryId: string, lineNo: number): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.enquiry_item (enquiry_id, line_no, part_name)
       VALUES ($1, $2, 'Bracket') RETURNING id`,
      [enquiryId, lineNo],
    );
    return res.rows[0]!.id;
  }

  async function freeze(enquiryId: string, revisionNo: number, kind = 'intake'): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash)
       VALUES ($1, $2, $3, '{"items":[]}'::jsonb, $4) RETURNING id`,
      [enquiryId, revisionNo, kind, `hash-${revisionNo}`],
    );
    return res.rows[0]!.id;
  }

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
    const org = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ('customer', 'Kovai Pumps', 'Kovai Pumps') RETURNING id`,
    );
    customerOrg = org.rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('withholds a reference from drafts and demands one past submit', async () => {
    const draft = await insertEnquiry('draft');
    await expect(
      pg.query(`UPDATE sourcing.enquiry SET status = 'submitted' WHERE id = $1`, [draft]),
    ).rejects.toThrow(/chk_enquiry_reference_after_draft/);

    await pg.query(
      `UPDATE sourcing.enquiry SET status = 'submitted', reference = 'ENQ-2026-0001',
         submitted_by = gen_random_uuid(), submitted_at = now() WHERE id = $1`,
      [draft],
    );
    const other = await insertEnquiry('draft');
    await expect(
      pg.query(`UPDATE sourcing.enquiry SET reference = 'ENQ-2026-0001' WHERE id = $1`, [other]),
    ).rejects.toThrow(/duplicate key/);
  });

  it('refuses to close an enquiry without a reason', async () => {
    const enquiry = await insertEnquiry('draft');
    await expect(
      pg.query(
        `UPDATE sourcing.enquiry SET status = 'closed', reference = 'ENQ-2026-0002' WHERE id = $1`,
        [enquiry],
      ),
    ).rejects.toThrow(/chk_enquiry_decision_reason/);
  });

  it('keeps a frozen requirement revision immutable and uniquely numbered', async () => {
    const enquiry = await insertEnquiry('draft');
    const first = await freeze(enquiry, 1);

    await expect(freeze(enquiry, 1, 'reviewed')).rejects.toThrow(/duplicate key/);
    await expect(
      pg.query(`UPDATE sourcing.requirement SET content_hash = 'tampered' WHERE id = $1`, [first]),
    ).rejects.toThrow(/requirement revisions are immutable/);
    await expect(
      pg.query(`DELETE FROM sourcing.requirement WHERE id = $1`, [first]),
    ).rejects.toThrow(/requirement revisions are immutable/);

    // A later reviewed revision is how a clarification changes the requirement.
    const second = await freeze(enquiry, 2, 'reviewed');
    await pg.query(`UPDATE sourcing.requirement SET revision_no = 2 WHERE id = $1`, [first]).catch(
      () => undefined,
    );
    const rows = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sourcing.requirement WHERE enquiry_id = $1`,
      [enquiry],
    );
    expect(rows.rows[0]!.n).toBe(2);
    expect(second).not.toBe(first);
  });

  it('allows exactly one governing document per enquiry', async () => {
    const enquiry = await insertEnquiry('draft');
    const item = await insertItem(enquiry, 1);
    expect(item).toBeTruthy();

    const org = customerOrg;
    const doc = await pg.query<{ id: string }>(
      `INSERT INTO dms.document (owning_organization_id, logical_type, title)
       VALUES ($1, 'drawing_2d', 'Bracket rev A') RETURNING id`,
      [org],
    );
    const file = await pg.query<{ id: string }>(
      `INSERT INTO dms.file_object
         (storage_key, byte_size, declared_media_type, sha256, scan_state, owning_organization_id)
       VALUES ($1, 1024, 'application/pdf', repeat('a', 64), 'clean', $2) RETURNING id`,
      [`clean/${randomBytes(6).toString('hex')}`, org],
    );
    const versionOf = async (n: number): Promise<string> => {
      const res = await pg.query<{ id: string }>(
        `INSERT INTO dms.document_version
           (document_id, version_no, file_object_id, original_filename, status, created_by)
         VALUES ($1, $2, $3, 'bracket.pdf', 'available', gen_random_uuid()) RETURNING id`,
        [doc.rows[0]!.id, n, file.rows[0]!.id],
      );
      return res.rows[0]!.id;
    };
    const v1 = await versionOf(1);
    const v2 = await versionOf(2);

    await pg.query(
      `INSERT INTO sourcing.enquiry_document (enquiry_id, document_version_id, role)
       VALUES ($1, $2, 'governing')`,
      [enquiry, v1],
    );
    await expect(
      pg.query(
        `INSERT INTO sourcing.enquiry_document (enquiry_id, document_version_id, role)
         VALUES ($1, $2, 'governing')`,
        [enquiry, v2],
      ),
    ).rejects.toThrow(/uq_enquiry_governing_document/);

    // A second *reference* document is fine — only the governing one is exclusive.
    await pg.query(
      `INSERT INTO sourcing.enquiry_document (enquiry_id, document_version_id, role)
       VALUES ($1, $2, 'reference')`,
      [enquiry, v2],
    );
  });

  it('keeps an answered clarification honest about carrying an answer', async () => {
    const enquiry = await insertEnquiry('draft');
    await pg.query(
      `INSERT INTO sourcing.clarification
         (enquiry_id, sequence_no, topic, question, asked_against_revision_no)
       VALUES ($1, 1, 'material', 'Which grade of aluminium?', 1)`,
      [enquiry],
    );
    await expect(
      pg.query(
        `UPDATE sourcing.clarification SET status = 'answered' WHERE enquiry_id = $1`,
        [enquiry],
      ),
    ).rejects.toThrow(/chk_clarification_answer/);

    await pg.query(
      `UPDATE sourcing.clarification
          SET status = 'answered', answer = '6061-T6', answered_at = now(),
              answered_by = gen_random_uuid()
        WHERE enquiry_id = $1`,
      [enquiry],
    );
    const row = await pg.query<{ status: string }>(
      `SELECT status FROM sourcing.clarification WHERE enquiry_id = $1`,
      [enquiry],
    );
    expect(row.rows[0]!.status).toBe('answered');
  });

  // ---------------------------------------------------------------- F-MX.1

  it('accepts only the three job types and defaults to job work', async () => {
    const plain = await insertEnquiry('draft');
    const read = await pg.query<{ job_type: string; material_supply: string }>(
      `SELECT job_type, material_supply FROM sourcing.enquiry WHERE id = $1`,
      [plain],
    );
    expect(read.rows[0]!.job_type).toBe('job_work');

    await expect(insertEnquiry('draft', { job_type: 'refurbishment' })).rejects.toThrow(
      /job_type/,
    );
    await expect(insertEnquiry('draft', { material_supply: 'unknown' })).rejects.toThrow(
      /material_supply/,
    );
    for (const jobType of ['new_model', 'correction_ecn']) {
      expect(await insertEnquiry('draft', { job_type: jobType })).toBeTruthy();
    }
  });

  it('lets a correction point at an existing enquiry but never at itself or a ghost', async () => {
    const original = await insertEnquiry('draft');
    const correction = await insertEnquiry('draft', {
      job_type: 'correction_ecn',
      related_enquiry_id: original,
    });
    expect(correction).toBeTruthy();

    await expect(
      insertEnquiry('draft', {
        job_type: 'correction_ecn',
        related_enquiry_id: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toThrow(/foreign key/);
    await expect(
      pg.query(`UPDATE sourcing.enquiry SET related_enquiry_id = id WHERE id = $1`, [correction]),
    ).rejects.toThrow(/chk_enquiry_not_self_related/);
  });

  it('groups process capabilities under families that are roots themselves', async () => {
    const leaves = await pg.query<{ code: string; family: string | null }>(
      `SELECT c.code, f.code AS family
         FROM supplier.capability c
         LEFT JOIN supplier.capability f ON f.id = c.parent_id
        WHERE c.kind = 'process' AND NOT c.is_family
        ORDER BY c.code`,
    );
    expect(leaves.rows.length).toBeGreaterThan(0);
    // Every seeded process belongs to a family; the wizard's category list is never empty.
    expect(leaves.rows.filter((row) => row.family === null)).toEqual([]);
    expect(leaves.rows.find((row) => row.code === 'cnc_milling')!.family).toBe('machining');

    const family = await pg.query<{ id: string }>(
      `SELECT id FROM supplier.capability WHERE code = 'machining'`,
    );
    const other = await pg.query<{ id: string }>(
      `SELECT id FROM supplier.capability WHERE code = 'casting'`,
    );
    await expect(
      pg.query(`UPDATE supplier.capability SET parent_id = $2 WHERE id = $1`, [
        family.rows[0]!.id,
        other.rows[0]!.id,
      ]),
    ).rejects.toThrow(/chk_capability_family_is_root/);
  });

  it('validates measurement shape rather than trusting a bare number', async () => {
    const enquiry = await insertEnquiry('draft');
    await expect(
      pg.query(
        `INSERT INTO sourcing.enquiry_item (enquiry_id, line_no, critical_tolerance)
         VALUES ($1, 9, '0.05'::jsonb)`,
        [enquiry],
      ),
    ).rejects.toThrow(/chk_item_tolerance/);
    await expect(
      pg.query(
        `INSERT INTO sourcing.enquiry_item (enquiry_id, line_no, critical_tolerance)
         VALUES ($1, 9, '{"value":0.05}'::jsonb)`,
        [enquiry],
      ),
    ).rejects.toThrow(/chk_item_tolerance/);
    await pg.query(
      `INSERT INTO sourcing.enquiry_item (enquiry_id, line_no, critical_tolerance)
       VALUES ($1, 9, '{"value":0.05,"unit":"mm"}'::jsonb)`,
      [enquiry],
    );
  });

  /**
   * A `date` is a calendar date, not an instant.
   *
   * `node-pg` parses OID 1082 into a JS `Date` at *local* midnight, so any code that
   * then serialises it as UTC moves the day backwards at every positive offset. These
   * assertions are meaningful only east of UTC — the launch locale is IST (+05:30), and
   * before `registerPgTypeParsers` a required-by date of 2026-11-30 came back as
   * 2026-11-29: a customer's deadline silently moved a day earlier.
   */
  it('reads a calendar date back as the exact day that was written', async () => {
    const enquiry = await insertEnquiry('draft');
    await pg.query(`UPDATE sourcing.enquiry SET required_by_date = '2026-11-30' WHERE id = $1`, [
      enquiry,
    ]);
    const read = await pg.query<{ required_by_date: unknown }>(
      `SELECT required_by_date FROM sourcing.enquiry WHERE id = $1`,
      [enquiry],
    );
    expect(read.rows[0]!.required_by_date).toBe('2026-11-30');
  });

  it('does the same for item target dates and supplier capacity windows', async () => {
    const enquiry = await insertEnquiry('draft');
    await pg.query(
      `INSERT INTO sourcing.enquiry_item (enquiry_id, line_no, target_date)
       VALUES ($1, 40, '2026-01-01')`,
      [enquiry],
    );
    const item = await pg.query<{ target_date: unknown }>(
      `SELECT target_date FROM sourcing.enquiry_item WHERE enquiry_id = $1 AND line_no = 40`,
      [enquiry],
    );
    // New Year's Day is the worst case: a backward shift changes the year too.
    expect(item.rows[0]!.target_date).toBe('2026-01-01');

    const supplierOrg = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ('supplier', 'Date Supplier', 'Date Supplier') RETURNING id`,
    );
    const profile = await pg.query<{ id: string }>(
      `INSERT INTO supplier.supplier_profile (organization_id) VALUES ($1) RETURNING id`,
      [supplierOrg.rows[0]!.id],
    );
    const capability = await pg.query<{ id: string }>(
      `SELECT id FROM supplier.capability WHERE code = 'cnc_milling'`,
    );
    await pg.query(
      `INSERT INTO supplier.capacity_window
         (supplier_profile_id, capability_id, version_no, window_start, window_end)
       VALUES ($1, $2, 1, '2026-11-30', '2026-12-31')`,
      [profile.rows[0]!.id, capability.rows[0]!.id],
    );
    const window = await pg.query<{ window_start: unknown; window_end: unknown }>(
      `SELECT window_start, window_end FROM supplier.capacity_window
        WHERE supplier_profile_id = $1`,
      [profile.rows[0]!.id],
    );
    expect(window.rows[0]!.window_start).toBe('2026-11-30');
    expect(window.rows[0]!.window_end).toBe('2026-12-31');
  });
});
