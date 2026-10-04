import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { registerPgTypeParsers } from '../src/pg-types';

registerPgTypeParsers();

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_changedb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * Change control's schema (IN-13 F-13.2): the doc 06 §9 machine in the database, a
 * superseding baseline that must name its change, and every judgement append-only.
 */
describe('change control schema (F-13.2)', () => {
  let pg: Client;
  let orderId: string;
  let poId: string;
  let supplierOrg: string;
  let n = 0;

  const one = async <T>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;
  async function change(status = 'proposed', classification: string | null = null): Promise<string> {
    n += 1;
    return (await one<{ id: string }>(
      `INSERT INTO change.change_request (number, sales_order_id, origin, title, reason, proposed_by, classification, customer_approval_required)
       VALUES ($1, $2, 'internal', 'Tighter bore', 'Fit trial failed', gen_random_uuid(), $3, $4) RETURNING id`,
      [`CR-2026-${String(n).padStart(4, '0')}`, orderId, classification, status === 'proposed' ? null : true],
    )).id;
  }

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
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
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('walks the doc 06 §9 machine and refuses every shortcut', async () => {
    const id = await change();
    await expect(pg.query(`UPDATE change.change_request SET status = 'approved' WHERE id = $1`, [id])).rejects.toThrow(/invalid change transition: proposed -> approved/);
    await pg.query(`UPDATE change.change_request SET status = 'triage' WHERE id = $1`, [id]);
    // Past triage, a change must be classified.
    await expect(pg.query(`UPDATE change.change_request SET status = 'impact_analysis' WHERE id = $1`, [id])).rejects.toThrow(/chk_change_classified/);
    await pg.query(`UPDATE change.change_request SET status = 'impact_analysis', classification = 'scope' WHERE id = $1`, [id]);
    await expect(pg.query(`UPDATE change.change_request SET status = 'commercial_approval' WHERE id = $1`, [id])).rejects.toThrow(/chk_change_approval_known/);
    await pg.query(`UPDATE change.change_request SET status = 'commercial_approval', customer_approval_required = true WHERE id = $1`, [id]);
    await pg.query(`UPDATE change.change_request SET status = 'approved' WHERE id = $1`, [id]);
    // Released means a baseline was released for it.
    await expect(pg.query(`UPDATE change.change_request SET status = 'released' WHERE id = $1`, [id])).rejects.toThrow(/chk_change_released/);
    await expect(pg.query(`UPDATE change.change_request SET status = 'closed' WHERE id = $1`, [id])).rejects.toThrow(/invalid change transition: approved -> closed/);
  });

  it('closes a clarification from triage without any baseline', async () => {
    const id = await change();
    await pg.query(`UPDATE change.change_request SET status = 'triage' WHERE id = $1`, [id]);
    await pg.query(`UPDATE change.change_request SET status = 'closed', classification = 'clarification', closed_at = now() WHERE id = $1`, [id]);
  });

  it('lets a baseline supersede another only in the name of a change', async () => {
    const first = (await one<{ id: string }>(`INSERT INTO dms.baseline (number, sales_order_id, created_by) VALUES ('BL-2026-0901', $1, gen_random_uuid()) RETURNING id`, [orderId])).id;
    await expect(
      pg.query(`INSERT INTO dms.baseline (number, sales_order_id, created_by, supersedes_baseline_id) VALUES ('BL-2026-0902', $1, gen_random_uuid(), $2)`, [orderId, first]),
    ).rejects.toThrow(/chk_baseline_supersedes_by_change/);
    const cr = await change();
    await pg.query(`INSERT INTO dms.baseline (number, sales_order_id, created_by, supersedes_baseline_id, change_request_id) VALUES ('BL-2026-0903', $1, gen_random_uuid(), $2, $3)`, [orderId, first, cr]);
    await expect(
      pg.query(`INSERT INTO dms.baseline (number, sales_order_id, created_by, supersedes_baseline_id, change_request_id) VALUES ('BL-2026-0904', $1, gen_random_uuid(), $2, gen_random_uuid())`, [orderId, first]),
    ).rejects.toThrow(/fk_baseline_change_request/);
  });

  it('keeps impact versions, supplier input and customer decisions as written', async () => {
    const cr = await change();
    const iv = await one<{ id: string }>(`INSERT INTO change.impact_version (change_request_id, version_no, areas, recorded_by) VALUES ($1, 1, '{}'::jsonb, gen_random_uuid()) RETURNING id`, [cr]);
    await expect(pg.query(`UPDATE change.impact_version SET customer_price_delta_minor = 1 WHERE id = $1`, [iv.id])).rejects.toThrow(/immutable/);
    await pg.query(`INSERT INTO change.supplier_impact (change_request_id, purchase_order_id, supplier_organization_id, cost_delta_minor, lead_time_delta_days, submitted_by) VALUES ($1, $2, $3, 100, 2, gen_random_uuid())`, [cr, poId, supplierOrg]);
    await expect(pg.query(`DELETE FROM change.supplier_impact WHERE change_request_id = $1`, [cr])).rejects.toThrow(/immutable/);
    await pg.query(`INSERT INTO change.customer_decision (change_request_id, decision, decided_by, membership_id, authority_snapshot) VALUES ($1, 'approved', gen_random_uuid(), gen_random_uuid(), '{}'::jsonb)`, [cr]);
    await expect(pg.query(`UPDATE change.customer_decision SET decision = 'rejected' WHERE change_request_id = $1`, [cr])).rejects.toThrow(/immutable/);
  });

  it('lifts an interim decision once, and nothing else about it moves', async () => {
    const cr = await change();
    const d = await one<{ id: string }>(
      `INSERT INTO change.interim_decision (change_request_id, purchase_order_id, decision, reason, expires_at, issued_by) VALUES ($1, $2, 'stop', 'Hold the bore', now() + interval '2 days', gen_random_uuid()) RETURNING id`,
      [cr, poId],
    );
    await expect(pg.query(`UPDATE change.interim_decision SET decision = 'continue' WHERE id = $1`, [d.id])).rejects.toThrow(/only ever lifted/);
    await pg.query(`UPDATE change.interim_decision SET lifted_at = now(), lifted_by = gen_random_uuid(), lift_reason = 'Released' WHERE id = $1`, [d.id]);
    await expect(pg.query(`UPDATE change.interim_decision SET lift_reason = 'Again' WHERE id = $1`, [d.id])).rejects.toThrow(/only ever lifted/);
    await expect(
      pg.query(`INSERT INTO change.interim_decision (change_request_id, purchase_order_id, decision, reason, expires_at, issued_by) VALUES ($1, $2, 'stop', 'Already over', now() - interval '1 hour', gen_random_uuid())`, [cr, poId]),
    ).rejects.toThrow(/chk_interim_expiry/);
  });

  it('accepts the new approval, installment and invoice kinds and the change accounts', async () => {
    expect((await one<{ n: string }>(`SELECT count(*) AS n FROM commercial.approval_policy WHERE kind = 'change'`)).n).toBe('1');
    expect((await one<{ n: string }>(`SELECT count(*) AS n FROM finance.ledger_account WHERE code IN ('change_cost', 'supplier_accrual')`)).n).toBe('2');
    await pg.query(`INSERT INTO finance.installment (sales_order_id, seq, kind, label, amount_minor, currency, trigger) VALUES ($1, 9, 'change', 'Change CR-2026-0001', 500, 'INR', 'on_acceptance')`, [orderId]);
  });
});
