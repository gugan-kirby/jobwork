import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { registerPgTypeParsers } from '../src/pg-types';

registerPgTypeParsers();

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_settledb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * Settlement and support in the schema (IN-18 F-18.1/F-18.2; doc 10 §§5–6, 15; doc 06 §15): a bill
 * keeps what was billed and is billed once per supplier reference; a paid settlement is final; the
 * case machine with its close guard; an action carries its amount, is verified by someone else, and
 * only moves forward; the case's timeline is append-only.
 */
describe('settlement and support schema (0027)', () => {
  let pg: Client;
  let customer: string;
  let supplierOrg: string;
  let orderId: string;
  let poId: string;
  let n = 0;

  const one = async <T>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;

  async function bill(reference = `INV-${randomBytes(3).toString('hex')}`): Promise<string> {
    n += 1;
    return (await one<{ id: string }>(
      `INSERT INTO finance.supplier_bill (number, purchase_order_id, supplier_organization_id, supplier_reference, bill_date, currency, quantity, taxable_minor, tax_minor, total_minor, submitted_by)
       VALUES ($1, $2, $3, $4, current_date, 'INR', 10, 1000, 180, 1180, gen_random_uuid()) RETURNING id`,
      [`SB-2026-${String(n).padStart(4, '0')}`, poId, supplierOrg, reference],
    )).id;
  }

  async function journal(): Promise<string> {
    return (await one<{ id: string }>(`INSERT INTO finance.journal (source_type, description, currency) VALUES ('test', 'test', 'INR') RETURNING id`)).id;
  }

  async function supportCase(): Promise<string> {
    n += 1;
    return (await one<{ id: string }>(
      `INSERT INTO support.case (number, kind, sales_order_id, customer_organization_id, title, description, opened_by, opened_by_party)
       VALUES ($1, 'delivery_issue', $2, $3, 'Dented flange', 'Two dented on arrival', gen_random_uuid(), 'customer') RETURNING id`,
      [`CASE-2026-${String(n).padStart(4, '0')}`, orderId, customer],
    )).id;
  }

  const move = (id: string, status: string) => pg.query(`UPDATE support.case SET status = $2 WHERE id = $1`, [id, status]);
  const action = (caseId: string, seq: number, kind: string, amount: number | null = null) =>
    one<{ id: string }>(`INSERT INTO support.resolution_action (case_id, seq, kind, description, amount_minor) VALUES ($1, $2, $3, 'Put it right', $4) RETURNING id`, [caseId, seq, kind, amount]);

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
    customer = (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('customer', 'Kovai', 'Kovai') RETURNING id`)).id;
    supplierOrg = (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('supplier', 'Anand', 'Anand') RETURNING id`)).id;
    const profile = await one<{ id: string }>(`INSERT INTO supplier.supplier_profile (organization_id) VALUES ($1) RETURNING id`, [supplierOrg]);
    const enquiry = await one<{ id: string }>(`INSERT INTO sourcing.enquiry (customer_organization_id, status) VALUES ($1, 'draft') RETURNING id`, [customer]);
    const set = await one<{ id: string }>(`INSERT INTO commercial.quote_offer_set (enquiry_id, customer_organization_id, created_by) VALUES ($1, $2, gen_random_uuid()) RETURNING id`, [enquiry.id, customer]);
    const quote = await one<{ id: string }>(`INSERT INTO commercial.customer_quote (offer_set_id, enquiry_id, customer_organization_id, status, reference, created_by) VALUES ($1, $2, $3, 'accepted', 'QUO-2026-0001', gen_random_uuid()) RETURNING id`, [set.id, enquiry.id, customer]);
    const terms = await one<{ id: string }>(`SELECT id FROM commercial.terms_version LIMIT 1`);
    const version = await one<{ id: string }>(
      `INSERT INTO commercial.quote_version (customer_quote_id, version_no, currency, subtotal_minor, tax_rate_bp, tax_minor, total_minor, delivery_lead_days, validity_until, terms_version_id, content_hash, status, created_by)
       VALUES ($1, 1, 'INR', 100, 0, 0, 100, 7, current_date + 7, $2, 'h', 'accepted', gen_random_uuid()) RETURNING id`,
      [quote.id, terms.id],
    );
    const acceptance = await one<{ id: string }>(
      `INSERT INTO commercial.acceptance (customer_quote_id, quote_version_id, content_hash, terms_version_id, terms_hash, accepted_by, organization_id, authority_snapshot)
       VALUES ($1, $2, 'h', $3, 't', gen_random_uuid(), $4, '{}'::jsonb) RETURNING id`,
      [quote.id, version.id, terms.id, customer],
    );
    const snapshot = await one<{ id: string }>(`INSERT INTO commercial.contract_snapshot (acceptance_id, snapshot, content_hash) VALUES ($1, '{}'::jsonb, 'c') RETURNING id`, [acceptance.id]);
    orderId = (await one<{ id: string }>(
      `INSERT INTO orders.sales_order (number, customer_organization_id, enquiry_id, customer_quote_id, accepted_quote_version_id, acceptance_id, contract_snapshot_id, title, currency, total_minor, delivery_lead_days)
       VALUES ('SO-2026-0001', $1, $2, $3, $4, $5, $6, 'Bracket', 'INR', 100, 7) RETURNING id`,
      [customer, enquiry.id, quote.id, version.id, acceptance.id, snapshot.id],
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

  it('seeds the accounts, both approval policies, the queues and the templates', async () => {
    expect((await pg.query(`SELECT code FROM finance.ledger_account WHERE code IN ('supplier_payable', 'cost_of_goods', 'gst_input', 'supplier_recovery', 'warranty_cost')`)).rowCount).toBe(5);
    const rules = await pg.query<{ kind: string; rules: Record<string, unknown> }>(
      `SELECT p.kind, v.rules FROM commercial.approval_policy p JOIN commercial.approval_policy_version v ON v.policy_id = p.id AND v.version_no = p.current_version_no WHERE p.kind IN ('bill_exception', 'case_resolution') ORDER BY p.kind`,
    );
    expect(rules.rows).toEqual([
      { kind: 'bill_exception', rules: { approverRoles: ['jobwork_finance'], tolerance: { basisPoints: 100, capMinor: 50000 } } },
      { kind: 'case_resolution', rules: { moneyRoles: ['jobwork_finance'], physicalRoles: ['jobwork_quality'] } },
    ]);
    expect((await pg.query(`SELECT key FROM platform.work_queue WHERE key IN ('supplier_bills_to_match', 'settlements_held', 'cases_open')`)).rowCount).toBe(3);
  });

  it('keeps what a supplier billed, once per reference, with a total that adds up', async () => {
    const id = await bill('INV-77');
    await expect(bill('INV-77')).rejects.toThrow(/supplier_bill_supplier_organization_id_supplier_reference_key/);
    await expect(pg.query(`UPDATE finance.supplier_bill SET taxable_minor = 900 WHERE id = $1`, [id])).rejects.toThrow(/keeps what was billed/);
    await expect(pg.query(`UPDATE finance.supplier_bill SET quantity = 9 WHERE id = $1`, [id])).rejects.toThrow(/keeps what was billed/);
    await expect(pg.query(`DELETE FROM finance.supplier_bill WHERE id = $1`, [id])).rejects.toThrow(/keeps what was billed/);
    // Only the decision on it moves.
    await pg.query(`UPDATE finance.supplier_bill SET status = 'matched', decided_at = now(), aggregate_version = aggregate_version + 1 WHERE id = $1`, [id]);
    await expect(
      pg.query(
        `INSERT INTO finance.supplier_bill (number, purchase_order_id, supplier_organization_id, supplier_reference, bill_date, currency, quantity, taxable_minor, tax_minor, total_minor, submitted_by)
         VALUES ('SB-2026-9999', $1, $2, 'INV-X', current_date, 'INR', 10, 1000, 180, 1000, gen_random_uuid())`,
        [poId, supplierOrg],
      ),
    ).rejects.toThrow(/supplier_bill_check/);
  });

  it('pays a settlement once, with its evidence, and never rewrites it', async () => {
    const billId = await bill();
    const s = await one<{ id: string }>(`INSERT INTO finance.settlement (supplier_bill_id, status, eligibility) VALUES ($1, 'eligible', '{"pass": true, "reasons": []}') RETURNING id`, [billId]);
    await expect(pg.query(`INSERT INTO finance.settlement (supplier_bill_id, eligibility) VALUES ($1, '{}')`, [billId])).rejects.toThrow(/settlement_supplier_bill_id_key/);
    await expect(pg.query(`UPDATE finance.settlement SET status = 'paid', paid_at = now(), paid_by = gen_random_uuid(), payment_reference = 'UTR1' WHERE id = $1`, [s.id])).rejects.toThrow(/chk_settlement_paid/);
    await expect(pg.query(`UPDATE finance.settlement SET status = 'paid', paid_at = now(), paid_by = gen_random_uuid(), payment_reference = 'U', journal_id = $2 WHERE id = $1`, [s.id, await journal()])).rejects.toThrow(/chk_settlement_paid/);
    await pg.query(`UPDATE finance.settlement SET status = 'paid', paid_at = now(), paid_by = gen_random_uuid(), payment_reference = 'UTR-0001', journal_id = $2 WHERE id = $1`, [s.id, await journal()]);
    await expect(pg.query(`UPDATE finance.settlement SET payment_reference = 'UTR-0002' WHERE id = $1`, [s.id])).rejects.toThrow(/paid settlement is final/);
    await expect(pg.query(`DELETE FROM finance.settlement WHERE id = $1`, [s.id])).rejects.toThrow(/paid settlement is final/);
  });

  it('walks the doc 06 §15 case machine and closes only when every action is verified or cancelled', async () => {
    const id = await supportCase();
    await expect(move(id, 'investigating')).rejects.toThrow(/invalid case transition: open -> investigating/);
    for (const s of ['triage', 'investigating', 'resolution_proposed']) await move(id, s);
    // A proposal sent back returns to investigation.
    await move(id, 'investigating');
    await move(id, 'resolution_proposed');
    await move(id, 'resolution_approved');
    await expect(move(id, 'verifying')).rejects.toThrow(/invalid case transition: resolution_approved -> verifying/);
    const refund = await action(id, 1, 'refund', 5000);
    const concession = await action(id, 2, 'concession');
    await move(id, 'executing');
    await move(id, 'verifying');
    await expect(move(id, 'closed')).rejects.toThrow(/every resolution action is verified or cancelled/);
    const doer = '00000000-0000-4000-8000-0000000000aa';
    await pg.query(`UPDATE support.resolution_action SET status = 'done', done_by = $2, done_at = now() WHERE id = $1`, [refund.id, doer]);
    await expect(pg.query(`UPDATE support.resolution_action SET status = 'verified', verified_by = $2, verified_at = now() WHERE id = $1`, [refund.id, doer])).rejects.toThrow(/chk_action_verifier/);
    await pg.query(`UPDATE support.resolution_action SET status = 'verified', verified_by = gen_random_uuid(), verified_at = now() WHERE id = $1`, [refund.id]);
    await pg.query(`UPDATE support.resolution_action SET status = 'cancelled' WHERE id = $1`, [concession.id]);
    await move(id, 'closed');
    await expect(move(id, 'executing')).rejects.toThrow(/invalid case transition: closed -> executing/);
    await expect(pg.query(`UPDATE support.case SET kind = 'dispute' WHERE id = $1`, [id])).rejects.toThrow(/keeps its order and kind/);
  });

  it('withdraws or rejects only before investigation', async () => {
    const early = await supportCase();
    await move(early, 'withdrawn');
    const late = await supportCase();
    await move(late, 'triage');
    await move(late, 'investigating');
    await expect(move(late, 'rejected')).rejects.toThrow(/invalid case transition: investigating -> rejected/);
    await expect(move(late, 'withdrawn')).rejects.toThrow(/invalid case transition: investigating -> withdrawn/);
  });

  it('gives every money action its amount, and moves an action only forward', async () => {
    const id = await supportCase();
    await expect(action(id, 1, 'credit_note')).rejects.toThrow(/chk_action_money/);
    await expect(action(id, 1, 'refund', 0)).rejects.toThrow(/resolution_action_amount_minor_check/);
    const a = await action(id, 1, 'credit_note', 1180);
    await expect(action(id, 1, 'concession')).rejects.toThrow(/resolution_action_case_id_seq_key/);
    await pg.query(`UPDATE support.resolution_action SET status = 'done', done_by = gen_random_uuid(), done_at = now(), result = '{"creditNoteNumber": "CN-2026-0001"}' WHERE id = $1`, [a.id]);
    await pg.query(`UPDATE support.resolution_action SET status = 'verified', verified_by = gen_random_uuid(), verified_at = now() WHERE id = $1`, [a.id]);
    // What was carried out and checked stays carried out and checked.
    await expect(pg.query(`UPDATE support.resolution_action SET status = 'planned' WHERE id = $1`, [a.id])).rejects.toThrow(/resolution action moves only forward/);
    await expect(pg.query(`UPDATE support.resolution_action SET amount_minor = 1 WHERE id = $1`, [a.id])).rejects.toThrow(/resolution action moves only forward/);
    await expect(pg.query(`DELETE FROM support.resolution_action WHERE id = $1`, [a.id])).rejects.toThrow(/resolution action moves only forward/);
    const b = await action(id, 2, 'concession');
    await pg.query(`UPDATE support.resolution_action SET status = 'cancelled' WHERE id = $1`, [b.id]);
    await expect(pg.query(`UPDATE support.resolution_action SET status = 'done', done_by = gen_random_uuid(), done_at = now() WHERE id = $1`, [b.id])).rejects.toThrow(/resolution action moves only forward/);
    // A proposal replaced before anything was done may drop its planned actions.
    const c = await action(id, 3, 'concession');
    await pg.query(`DELETE FROM support.resolution_action WHERE id = $1`, [c.id]);
  });

  it('keeps the case timeline append-only', async () => {
    const id = await supportCase();
    const e = await one<{ id: string }>(`INSERT INTO support.case_event (case_id, audience, kind, note, author_party) VALUES ($1, 'customer', 'opened', 'Two dented', 'customer') RETURNING id`, [id]);
    await expect(pg.query(`UPDATE support.case_event SET note = 'Nothing' WHERE id = $1`, [e.id])).rejects.toThrow(/immutable/);
    await expect(pg.query(`DELETE FROM support.case_event WHERE id = $1`, [e.id])).rejects.toThrow(/immutable/);
    await expect(pg.query(`INSERT INTO support.case_event (case_id, audience, kind, author_party) VALUES ($1, 'everyone', 'note', 'jobwork')`, [id])).rejects.toThrow(/case_event_audience_check/);
  });
});
