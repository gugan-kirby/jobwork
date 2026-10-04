import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { registerPgTypeParsers } from '../src/pg-types';

registerPgTypeParsers();

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_proddb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * The production schema's teeth (F-09.1): a released baseline and its items never move,
 * one transmittal is live per purchase order, a released plan and its snapshot are frozen,
 * a milestone's original plan survives delays, and forecasts and evidence are append-only.
 */
describe('production schema constraints (F-09.1)', () => {
  let pg: Client;
  let orderId: string;
  let poId: string;
  let supplierOrg: string;
  let versionId: string;
  let documentId: string;

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
    const one = async <T>(sql: string, args: unknown[] = []) => (await pg.query(sql, args)).rows[0] as T;
    const customer = await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('customer', 'Kovai', 'Kovai') RETURNING id`);
    supplierOrg = (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('supplier', 'Anand', 'Anand') RETURNING id`)).id;
    const profile = await one<{ id: string }>(`INSERT INTO supplier.supplier_profile (organization_id) VALUES ($1) RETURNING id`, [supplierOrg]);
    const enquiry = await one<{ id: string }>(`INSERT INTO sourcing.enquiry (customer_organization_id, status) VALUES ($1, 'draft') RETURNING id`, [customer.id]);
    const set = await one<{ id: string }>(`INSERT INTO commercial.quote_offer_set (enquiry_id, customer_organization_id, created_by) VALUES ($1, $2, gen_random_uuid()) RETURNING id`, [enquiry.id, customer.id]);
    const quote = await one<{ id: string }>(`INSERT INTO commercial.customer_quote (offer_set_id, enquiry_id, customer_organization_id, status, reference, created_by) VALUES ($1, $2, $3, 'accepted', 'QUO-2026-0001', gen_random_uuid()) RETURNING id`, [set.id, enquiry.id, customer.id]);
    const terms = await one<{ id: string }>(`SELECT id FROM commercial.terms_version LIMIT 1`);
    const version = await one<{ id: string }>(
      `INSERT INTO commercial.quote_version (customer_quote_id, version_no, currency, subtotal_minor, tax_rate_bp, tax_minor, total_minor, delivery_lead_days, validity_until, terms_version_id, content_hash, status, created_by)
       VALUES ($1, 1, 'INR', 100, 0, 0, 100, 7, current_date + 7, $2, 'h', 'accepted', gen_random_uuid()) RETURNING id`,
      [quote.id, terms.id],
    );
    const acceptance = await one<{ id: string }>(
      `INSERT INTO commercial.acceptance (customer_quote_id, quote_version_id, content_hash, terms_version_id, terms_hash, accepted_by, organization_id, authority_snapshot)
       VALUES ($1, $2, 'h', $3, 't', gen_random_uuid(), $4, '{}'::jsonb) RETURNING id`,
      [quote.id, version.id, terms.id, customer.id],
    );
    const snapshot = await one<{ id: string }>(`INSERT INTO commercial.contract_snapshot (acceptance_id, snapshot, content_hash) VALUES ($1, '{}'::jsonb, 'c') RETURNING id`, [acceptance.id]);
    orderId = (await one<{ id: string }>(
      `INSERT INTO orders.sales_order (number, customer_organization_id, enquiry_id, customer_quote_id, accepted_quote_version_id, acceptance_id, contract_snapshot_id, title, currency, total_minor, delivery_lead_days)
       VALUES ('SO-2026-0001', $1, $2, $3, $4, $5, $6, 'Bracket', 'INR', 100, 7) RETURNING id`,
      [customer.id, enquiry.id, quote.id, version.id, acceptance.id, snapshot.id],
    )).id;
    const req = await one<{ id: string }>(`INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash) VALUES ($1, 1, 'intake', '{}'::jsonb, 'h') RETURNING id`, [enquiry.id]);
    const rfq = await one<{ id: string }>(`INSERT INTO sourcing.rfq (enquiry_id, requirement_id, round_no, currency, status, deadline_at, released_at) VALUES ($1, $2, 1, 'INR', 'awarded', now(), now()) RETURNING id`, [enquiry.id, req.id]);
    const award = await one<{ id: string }>(`INSERT INTO commercial.award (rfq_id, proposed_by, currency, status) VALUES ($1, gen_random_uuid(), 'INR', 'approved') RETURNING id`, [rfq.id]);
    poId = (await one<{ id: string }>(
      `INSERT INTO orders.purchase_order (number, sales_order_id, award_id, supplier_organization_id, supplier_profile_id, currency, total_minor, lead_time_days, content_hash, issued_by)
       VALUES ('PO-2026-0001', $1, $2, $3, $4, 'INR', 90, 14, 'p', gen_random_uuid()) RETURNING id`,
      [orderId, award.id, supplierOrg, profile.id],
    )).id;
    const file = await one<{ id: string }>(
      `INSERT INTO dms.file_object (storage_key, byte_size, declared_media_type, sha256, scan_state, owning_organization_id) VALUES ('k1', 10, 'application/pdf', 'abc', 'clean', $1) RETURNING id`,
      [customer.id],
    );
    documentId = (await one<{ id: string }>(`INSERT INTO dms.document (owning_organization_id, logical_type, title) VALUES ($1, 'drawing_2d', 'Bracket') RETURNING id`, [customer.id])).id;
    versionId = (await one<{ id: string }>(
      `INSERT INTO dms.document_version (document_id, version_no, file_object_id, original_filename, status) VALUES ($1, 1, $2, 'bracket.pdf', 'available') RETURNING id`,
      [documentId, file.id],
    )).id;
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('freezes a released baseline and its items, and allows one released baseline per order', async () => {
    const draft = await pg.query<{ id: string }>(`INSERT INTO dms.baseline (number, sales_order_id, created_by) VALUES ('BL-2026-0001', $1, gen_random_uuid()) RETURNING id`, [orderId]);
    const baselineId = draft.rows[0]!.id;
    await pg.query(`INSERT INTO dms.baseline_item (baseline_id, document_id, document_version_id, file_sha256, purpose) VALUES ($1, $2, $3, 'abc', 'governing')`, [baselineId, documentId, versionId]);
    // A released baseline must carry its hash.
    await expect(pg.query(`UPDATE dms.baseline SET status = 'released', released_at = now(), released_by = gen_random_uuid() WHERE id = $1`, [baselineId])).rejects.toThrow(/chk_baseline_hash/);
    await pg.query(`UPDATE dms.baseline SET status = 'released', released_at = now(), released_by = gen_random_uuid(), manifest_hash = 'm1' WHERE id = $1`, [baselineId]);
    await expect(pg.query(`UPDATE dms.baseline SET manifest_hash = 'm2' WHERE id = $1`, [baselineId])).rejects.toThrow(/immutable/);
    await expect(pg.query(`UPDATE dms.baseline_item SET purpose = 'reference' WHERE baseline_id = $1`, [baselineId])).rejects.toThrow(/frozen/);
    await expect(pg.query(`DELETE FROM dms.baseline_item WHERE baseline_id = $1`, [baselineId])).rejects.toThrow(/frozen/);
    await expect(pg.query(`DELETE FROM dms.baseline WHERE id = $1`, [baselineId])).rejects.toThrow(/cannot be deleted/);
    // A second released production baseline for the same order is refused; superseding first is how it is done.
    const second = await pg.query<{ id: string }>(`INSERT INTO dms.baseline (number, sales_order_id, created_by) VALUES ('BL-2026-0002', $1, gen_random_uuid()) RETURNING id`, [orderId]);
    await expect(
      pg.query(`UPDATE dms.baseline SET status = 'released', released_at = now(), released_by = gen_random_uuid(), manifest_hash = 'm3' WHERE id = $1`, [second.rows[0]!.id]),
    ).rejects.toThrow(/uq_baseline_released/);
    await pg.query(`UPDATE dms.baseline SET status = 'superseded' WHERE id = $1`, [baselineId]);
    await pg.query(`UPDATE dms.baseline SET status = 'released', released_at = now(), released_by = gen_random_uuid(), manifest_hash = 'm3' WHERE id = $1`, [second.rows[0]!.id]);
    await expect(pg.query(`UPDATE dms.baseline SET status = 'released' WHERE id = $1`, [baselineId])).rejects.toThrow(/immutable/);
  });

  it('keeps one live transmittal per purchase order and its delivered content fixed', async () => {
    const baseline = await pg.query<{ id: string }>(`SELECT id FROM dms.baseline WHERE status = 'released' LIMIT 1`);
    const insert = (number: string) =>
      pg.query<{ id: string }>(
        `INSERT INTO dms.transmittal (number, baseline_id, purchase_order_id, recipient_organization_id, manifest_hash, acknowledgment_due_at, issued_by)
         VALUES ($1, $2, $3, $4, 'm3', now() + interval '3 days', gen_random_uuid()) RETURNING id`,
        [number, baseline.rows[0]!.id, poId, supplierOrg],
      );
    const first = await insert('TR-2026-0001');
    await expect(insert('TR-2026-0002')).rejects.toThrow(/uq_transmittal_live/);
    await expect(pg.query(`UPDATE dms.transmittal SET manifest_hash = 'x' WHERE id = $1`, [first.rows[0]!.id])).rejects.toThrow(/immutable/);
    await expect(pg.query(`UPDATE dms.transmittal SET acknowledged_at = now() WHERE id = $1`, [first.rows[0]!.id])).rejects.toThrow(/chk_transmittal_ack/);
    await pg.query(`UPDATE dms.transmittal SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = gen_random_uuid() WHERE id = $1`, [first.rows[0]!.id]);
    await expect(pg.query(`UPDATE dms.transmittal SET acknowledged_at = now() + interval '1 day' WHERE id = $1`, [first.rows[0]!.id])).rejects.toThrow(/immutable/);
  });

  it('freezes a released plan, preserves the original milestone date and keeps forecasts and evidence append-only', async () => {
    const wp = await pg.query<{ id: string }>(
      `INSERT INTO orders.work_package (number, sales_order_id, purchase_order_id, supplier_organization_id, planned_start, planned_finish, created_by)
       VALUES ('WP-2026-0001', $1, $2, $3, current_date, current_date + 14, gen_random_uuid()) RETURNING id`,
      [orderId, poId, supplierOrg],
    );
    const wpId = wp.rows[0]!.id;
    const milestone = await pg.query<{ id: string }>(
      `INSERT INTO orders.milestone (work_package_id, seq, title, planned_date, forecast_date) VALUES ($1, 1, 'First article', current_date + 5, current_date + 5) RETURNING id`,
      [wpId],
    );
    const milestoneId = milestone.rows[0]!.id;
    // Before release the plan moves freely.
    await pg.query(`UPDATE orders.milestone SET planned_date = current_date + 6 WHERE id = $1`, [milestoneId]);
    // Released means released with a snapshot.
    await expect(pg.query(`UPDATE orders.work_package SET status = 'released' WHERE id = $1`, [wpId])).rejects.toThrow(/chk_wp_released/);
    await pg.query(`UPDATE orders.work_package SET status = 'released', released_at = now(), released_by = gen_random_uuid(), release_snapshot = '{"gates":[]}'::jsonb WHERE id = $1`, [wpId]);
    await expect(pg.query(`UPDATE orders.work_package SET release_snapshot = '{}'::jsonb WHERE id = $1`, [wpId])).rejects.toThrow(/snapshot is immutable/);
    await expect(pg.query(`UPDATE orders.work_package SET planned_finish = current_date + 30 WHERE id = $1`, [wpId])).rejects.toThrow(/frozen after release/);
    await expect(pg.query(`UPDATE orders.milestone SET planned_date = current_date + 9 WHERE id = $1`, [milestoneId])).rejects.toThrow(/preserved/);
    // A delay is a forecast revision, and a recorded forecast never changes.
    await pg.query(`UPDATE orders.milestone SET forecast_date = current_date + 9 WHERE id = $1`, [milestoneId]);
    const forecast = await pg.query<{ id: string }>(
      `INSERT INTO orders.milestone_forecast (milestone_id, revision_no, forecast_date, reason_code, reason, recorded_by) VALUES ($1, 1, current_date + 9, 'machine', 'Spindle repair', gen_random_uuid()) RETURNING id`,
      [milestoneId],
    );
    await expect(pg.query(`UPDATE orders.milestone_forecast SET reason = 'x' WHERE id = $1`, [forecast.rows[0]!.id])).rejects.toThrow(/append-only/);
    const evidence = await pg.query<{ id: string }>(
      `INSERT INTO orders.milestone_evidence (milestone_id, document_version_id, file_sha256, observed_at, submitted_by) VALUES ($1, $2, 'abc', now(), gen_random_uuid()) RETURNING id`,
      [milestoneId, versionId],
    );
    await expect(pg.query(`DELETE FROM orders.milestone_evidence WHERE id = $1`, [evidence.rows[0]!.id])).rejects.toThrow(/append-only/);
    // A verified milestone names who verified it; a waived one says why.
    await expect(pg.query(`UPDATE orders.milestone SET status = 'verified' WHERE id = $1`, [milestoneId])).rejects.toThrow(/chk_milestone_verified/);
    await expect(pg.query(`UPDATE orders.milestone SET status = 'waived', decided_by = gen_random_uuid(), decided_at = now() WHERE id = $1`, [milestoneId])).rejects.toThrow(/chk_milestone_waived_reason/);
  });
});
