import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_biddb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * `BR-COM-03` and `FR-401` at the level that survives an application bug: a submitted
 * bid version's commercial content cannot be edited or deleted by anybody, however the
 * write arrives. Its disposition — selected, rejected, superseded — is a different
 * family of columns and moves freely.
 */
describe('bid version immutability (F-06.1)', () => {
  let pg: Client;
  let bidId: string;
  let versionId: string;
  let rfqItemId: string;

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();

    const customer = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ('customer', 'Kovai Pumps', 'Kovai Pumps') RETURNING id`,
    );
    const supplierOrg = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ('supplier', 'Anand Engineering', 'Anand Engineering') RETURNING id`,
    );
    const profile = await pg.query<{ id: string }>(
      `INSERT INTO supplier.supplier_profile (organization_id) VALUES ($1) RETURNING id`,
      [supplierOrg.rows[0]!.id],
    );
    const enquiry = await pg.query<{ id: string }>(
      // A submitted enquiry carries its reference; the constraint says so (IN-05).
      `INSERT INTO sourcing.enquiry
         (customer_organization_id, title, status, reference, submitted_at, submitted_by)
       VALUES ($1, 'Bracket', 'approved_for_sourcing', 'ENQ-2026-9001', now(), gen_random_uuid())
       RETURNING id`,
      [customer.rows[0]!.id],
    );
    const requirement = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash)
       VALUES ($1, 1, 'intake', '{}'::jsonb, 'hash') RETURNING id`,
      [enquiry.rows[0]!.id],
    );
    const rfq = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.rfq
         (enquiry_id, requirement_id, round_no, status, deadline_at, released_at)
       VALUES ($1, $2, 1, 'open', now() + interval '7 days', now()) RETURNING id`,
      [enquiry.rows[0]!.id, requirement.rows[0]!.id],
    );
    const item = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.rfq_item (rfq_id, line_no, part_name, quantity_breakpoints)
       VALUES ($1, 1, 'Bracket', '[{"quantity":10,"unit":"piece"}]'::jsonb) RETURNING id`,
      [rfq.rows[0]!.id],
    );
    rfqItemId = item.rows[0]!.id;
    const invitation = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.rfq_supplier
         (rfq_id, supplier_profile_id, supplier_organization_id, status, invited_at)
       VALUES ($1, $2, $3, 'invited', now()) RETURNING id`,
      [rfq.rows[0]!.id, profile.rows[0]!.id, supplierOrg.rows[0]!.id],
    );
    const bid = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.supplier_bid (rfq_id, rfq_supplier_id, supplier_organization_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [rfq.rows[0]!.id, invitation.rows[0]!.id, supplierOrg.rows[0]!.id],
    );
    bidId = bid.rows[0]!.id;
    const version = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.supplier_bid_version
         (supplier_bid_id, version_no, currency, lines_total_minor, total_amount_minor,
          lead_time_days, validity_until, content_hash)
       VALUES ($1, 1, 'INR', 4500000, 4500000, 21, current_date + 30, 'content-hash-1')
       RETURNING id`,
      [bidId],
    );
    versionId = version.rows[0]!.id;
    await pg.query(
      `INSERT INTO sourcing.bid_line
         (supplier_bid_version_id, rfq_item_id, line_no, quantity, unit, unit_price_minor)
       VALUES ($1, $2, 1, 10, 'piece', 450000)`,
      [versionId, rfqItemId],
    );
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('refuses every edit to the frozen commercial content', async () => {
    for (const [column, value] of [
      ['total_amount_minor', '1'],
      ['lead_time_days', '3'],
      ['currency', `'USD'`],
      ['validity_until', `current_date + 900`],
      ['assumptions', `'we assumed something else'`],
      ['content_hash', `'rewritten'`],
    ] as const) {
      await expect(
        pg.query(`UPDATE sourcing.supplier_bid_version SET ${column} = ${value} WHERE id = $1`, [
          versionId,
        ]),
      ).rejects.toThrow(/content is immutable/);
    }
  });

  it('refuses to delete a submitted version, or to edit its lines', async () => {
    await expect(
      pg.query(`DELETE FROM sourcing.supplier_bid_version WHERE id = $1`, [versionId]),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      pg.query(`UPDATE sourcing.bid_line SET unit_price_minor = 1 WHERE supplier_bid_version_id = $1`, [
        versionId,
      ]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      pg.query(`DELETE FROM sourcing.bid_line WHERE supplier_bid_version_id = $1`, [versionId]),
    ).rejects.toThrow(/cannot be changed/);
  });

  it('lets the disposition move, because that is not content', async () => {
    await pg.query(
      `UPDATE sourcing.supplier_bid_version
          SET status = 'superseded', disposition_reason = 'revised', decided_at = now()
        WHERE id = $1`,
      [versionId],
    );
    const row = await pg.query<{ status: string; total_amount_minor: string }>(
      `SELECT status, total_amount_minor FROM sourcing.supplier_bid_version WHERE id = $1`,
      [versionId],
    );
    expect(row.rows[0]).toMatchObject({ status: 'superseded', total_amount_minor: '4500000' });
  });

  it('numbers versions per bid and refuses a duplicate', async () => {
    await pg.query(
      `INSERT INTO sourcing.supplier_bid_version
         (supplier_bid_id, version_no, currency, lines_total_minor, total_amount_minor,
          lead_time_days, validity_until, content_hash, supersedes_version_id)
       VALUES ($1, 2, 'INR', 4300000, 4300000, 21, current_date + 30, 'content-hash-2', $2)`,
      [bidId, versionId],
    );
    await expect(
      pg.query(
        `INSERT INTO sourcing.supplier_bid_version
           (supplier_bid_id, version_no, currency, lines_total_minor, total_amount_minor,
            lead_time_days, validity_until, content_hash)
         VALUES ($1, 2, 'INR', 1, 1, 5, current_date + 30, 'dup')`,
        [bidId],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('walks the RFQ state machine and refuses the steps it does not have', async () => {
    const enquiry = await pg.query<{ id: string }>(
      `SELECT enquiry_id AS id FROM sourcing.rfq LIMIT 1`,
    );
    const requirement = await pg.query<{ id: string }>(
      `SELECT id FROM sourcing.requirement LIMIT 1`,
    );
    const second = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.rfq (enquiry_id, requirement_id, round_no, status)
       VALUES ($1, $2, 2, 'draft') RETURNING id`,
      [enquiry.rows[0]!.id, requirement.rows[0]!.id],
    );
    const id = second.rows[0]!.id;

    // A round cannot be evaluated before anybody was invited to it.
    await expect(
      pg.query(`UPDATE sourcing.rfq SET status = 'evaluation' WHERE id = $1`, [id]),
    ).rejects.toThrow(/invalid rfq transition: draft -> evaluation/);

    await pg.query(
      `UPDATE sourcing.rfq SET status = 'open', deadline_at = now() + interval '3 days',
              released_at = now() WHERE id = $1`,
      [id],
    );
    await pg.query(`UPDATE sourcing.rfq SET status = 'responses_received' WHERE id = $1`, [id]);
    await pg.query(`UPDATE sourcing.rfq SET status = 'evaluation' WHERE id = $1`, [id]);
    // Cancelling is always available; going back to draft after release is not.
    await expect(
      pg.query(`UPDATE sourcing.rfq SET status = 'draft' WHERE id = $1`, [id]),
    ).rejects.toThrow(/invalid rfq transition: evaluation -> draft/);
    await pg.query(`UPDATE sourcing.rfq SET status = 'cancelled' WHERE id = $1`, [id]);
  });
});
