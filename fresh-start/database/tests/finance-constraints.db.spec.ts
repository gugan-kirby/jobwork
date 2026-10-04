import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { registerPgTypeParsers } from '../src/pg-types';

registerPgTypeParsers();

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_findb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * The money schema's teeth (F-08.1): a journal that does not balance never commits, a
 * provider transaction posts once, an issued invoice is frozen, acceptance evidence is
 * immutable, and an offer set accepts exactly one option even when two acceptances race.
 */
describe('orders and finance schema constraints (F-08.1)', () => {
  let pg: Client;
  let customerOrg: string;

  async function journal(lines: Array<[string, number, number]>, client: Client = pg): Promise<string> {
    await client.query('BEGIN');
    const j = await client.query<{ id: string }>(
      `INSERT INTO finance.journal (source_type, description, currency) VALUES ('test', 'test', 'INR') RETURNING id`,
    );
    for (const [account, debit, credit] of lines) {
      await client.query(
        `INSERT INTO finance.journal_line (journal_id, account_code, debit_minor, credit_minor) VALUES ($1, $2, $3, $4)`,
        [j.rows[0]!.id, account, debit, credit],
      );
    }
    await client.query('COMMIT');
    return j.rows[0]!.id;
  }

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
    const org = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('customer', 'Kovai Pumps', 'Kovai Pumps') RETURNING id`,
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

  it('refuses a journal that does not balance, at commit, and keeps a balanced one', async () => {
    await expect(
      journal([
        ['gateway_clearing', 100_000, 0],
        ['customer_receivable', 0, 99_999],
      ]),
    ).rejects.toThrow(/does not balance/);
    // The failed transaction left nothing behind.
    await pg.query('ROLLBACK').catch(() => undefined);
    const count = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM finance.journal`);
    expect(count.rows[0]!.n).toBe(0);

    const id = await journal([
      ['gateway_clearing', 100_000, 0],
      ['customer_receivable', 0, 100_000],
    ]);
    expect(id).toBeTruthy();
    // Posted means posted.
    await expect(pg.query(`UPDATE finance.journal_line SET debit_minor = 1 WHERE journal_id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(pg.query(`DELETE FROM finance.journal WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
    // A line on both sides, or on neither, is not a line.
    await expect(
      pg.query(`INSERT INTO finance.journal_line (journal_id, account_code, debit_minor, credit_minor) VALUES ($1, 'bank', 5, 5)`, [id]),
    ).rejects.toThrow(/chk_journal_line_one_side/);
  });

  it('posts a provider transaction once per provider transaction id', async () => {
    const insert = () =>
      pg.query(
        `INSERT INTO finance.payment_transaction (provider, provider_transaction_id, kind, amount_minor, currency, occurred_at)
         VALUES ('dev', 'txn_duplicate', 'capture', 1000, 'INR', now())`,
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });

  it('freezes an issued invoice and keeps its paid state honest', async () => {
    const enquiry = await pg.query<{ id: string }>(`INSERT INTO sourcing.enquiry (customer_organization_id, status) VALUES ($1, 'draft') RETURNING id`, [customerOrg]);
    const set = await pg.query<{ id: string }>(`INSERT INTO commercial.quote_offer_set (enquiry_id, customer_organization_id, created_by) VALUES ($1, $2, gen_random_uuid()) RETURNING id`, [enquiry.rows[0]!.id, customerOrg]);
    const quote = await pg.query<{ id: string }>(
      `INSERT INTO commercial.customer_quote (offer_set_id, enquiry_id, customer_organization_id, option_label, status, reference, created_by)
       VALUES ($1, $2, $3, 'standard', 'accepted', 'QUO-2026-0901', gen_random_uuid()) RETURNING id`,
      [set.rows[0]!.id, enquiry.rows[0]!.id, customerOrg],
    );
    const terms = await pg.query<{ id: string }>(`SELECT id FROM commercial.terms_version LIMIT 1`);
    const version = await pg.query<{ id: string }>(
      `INSERT INTO commercial.quote_version (customer_quote_id, version_no, currency, subtotal_minor, tax_rate_bp, tax_minor, freight_minor, total_minor,
         delivery_lead_days, payment_terms, validity_until, terms_version_id, content_hash, status, created_by)
       VALUES ($1, 1, 'INR', 100000, 1800, 18000, 0, 118000, 7, 'advance', current_date + 7, $2, 'h1', 'accepted', gen_random_uuid()) RETURNING id`,
      [quote.rows[0]!.id, terms.rows[0]!.id],
    );
    const acceptance = await pg.query<{ id: string }>(
      `INSERT INTO commercial.acceptance (customer_quote_id, quote_version_id, content_hash, terms_version_id, terms_hash, accepted_by, organization_id, authority_snapshot)
       VALUES ($1, $2, 'h1', $3, 't1', gen_random_uuid(), $4, '{}'::jsonb) RETURNING id`,
      [quote.rows[0]!.id, version.rows[0]!.id, terms.rows[0]!.id, customerOrg],
    );
    // Acceptance evidence never changes, and a version is accepted once.
    await expect(pg.query(`UPDATE commercial.acceptance SET content_hash = 'h2' WHERE id = $1`, [acceptance.rows[0]!.id])).rejects.toThrow(/immutable evidence/);
    await expect(
      pg.query(
        `INSERT INTO commercial.acceptance (customer_quote_id, quote_version_id, content_hash, terms_version_id, terms_hash, accepted_by, organization_id, authority_snapshot)
         VALUES ($1, $2, 'h1', $3, 't1', gen_random_uuid(), $4, '{}'::jsonb)`,
        [quote.rows[0]!.id, version.rows[0]!.id, terms.rows[0]!.id, customerOrg],
      ),
    ).rejects.toThrow(/duplicate key/);
    const snapshot = await pg.query<{ id: string }>(`INSERT INTO commercial.contract_snapshot (acceptance_id, snapshot, content_hash) VALUES ($1, '{}'::jsonb, 'c1') RETURNING id`, [acceptance.rows[0]!.id]);
    const order = await pg.query<{ id: string }>(
      `INSERT INTO orders.sales_order (number, customer_organization_id, enquiry_id, customer_quote_id, accepted_quote_version_id, acceptance_id, contract_snapshot_id, title, currency, total_minor, delivery_lead_days)
       VALUES ('SO-2026-0901', $1, $2, $3, $4, $5, $6, 'Bracket', 'INR', 118000, 7) RETURNING id`,
      [customerOrg, enquiry.rows[0]!.id, quote.rows[0]!.id, version.rows[0]!.id, acceptance.rows[0]!.id, snapshot.rows[0]!.id],
    );
    const invoice = await pg.query<{ id: string }>(
      `INSERT INTO finance.invoice (number, sales_order_id, customer_organization_id, kind, currency, lines, subtotal_minor, tax_rate_bp, tax_minor, total_minor, content_hash, issued_by, due_at)
       VALUES ('INV-2026-0901', $1, $2, 'advance', 'INR', '[]'::jsonb, 50000, 1800, 9000, 59000, 'i1', gen_random_uuid(), now() + interval '7 days') RETURNING id`,
      [order.rows[0]!.id, customerOrg],
    );
    await expect(pg.query(`UPDATE finance.invoice SET total_minor = 1 WHERE id = $1`, [invoice.rows[0]!.id])).rejects.toThrow(/immutable/);
    await expect(pg.query(`DELETE FROM finance.invoice WHERE id = $1`, [invoice.rows[0]!.id])).rejects.toThrow(/cannot be deleted/);
    // Paid state must agree with the money: "paid" with nothing received is a lie.
    await expect(pg.query(`UPDATE finance.invoice SET status = 'paid' WHERE id = $1`, [invoice.rows[0]!.id])).rejects.toThrow(/chk_invoice_paid_status/);
    await pg.query(`UPDATE finance.invoice SET status = 'partially_paid', paid_minor = 10000 WHERE id = $1`, [invoice.rows[0]!.id]);
    await pg.query(`UPDATE finance.invoice SET status = 'paid', paid_minor = 59000 WHERE id = $1`, [invoice.rows[0]!.id]);
  });

  it('lets exactly one of two racing acceptances win an offer set', async () => {
    const enquiry = await pg.query<{ id: string }>(`INSERT INTO sourcing.enquiry (customer_organization_id, status) VALUES ($1, 'draft') RETURNING id`, [customerOrg]);
    const set = await pg.query<{ id: string }>(`INSERT INTO commercial.quote_offer_set (enquiry_id, customer_organization_id, created_by) VALUES ($1, $2, gen_random_uuid()) RETURNING id`, [enquiry.rows[0]!.id, customerOrg]);
    const ids: string[] = [];
    for (const option of ['standard', 'fast']) {
      const q = await pg.query<{ id: string }>(
        `INSERT INTO commercial.customer_quote (offer_set_id, enquiry_id, customer_organization_id, option_label, status, reference, created_by)
         VALUES ($1, $2, $3, $4, 'sent', $5, gen_random_uuid()) RETURNING id`,
        [set.rows[0]!.id, enquiry.rows[0]!.id, customerOrg, option, `QUO-2026-09${option === 'standard' ? '11' : '12'}`],
      );
      ids.push(q.rows[0]!.id);
    }
    const a = new Client({ connectionString: url() });
    const b = new Client({ connectionString: url() });
    await a.connect();
    await b.connect();
    await a.query('BEGIN');
    await b.query('BEGIN');
    await a.query(`UPDATE commercial.customer_quote SET status = 'accepted' WHERE id = $1`, [ids[0]]);
    // b blocks on the partial unique index until a decides. Its refusal is awaited from the
    // start: on a fast machine it lands in the same tick as a's COMMIT, and a rejection with
    // no handler yet is reported as an unhandled error even though the test then catches it.
    const bRefused = expect(
      b.query(`UPDATE commercial.customer_quote SET status = 'accepted' WHERE id = $1`, [ids[1]]),
    ).rejects.toThrow(/uq_offer_set_single_acceptance/);
    await new Promise((r) => setTimeout(r, 150));
    await a.query('COMMIT');
    await bRefused;
    await b.query('ROLLBACK');
    await a.end();
    await b.end();
    const accepted = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM commercial.customer_quote WHERE offer_set_id = $1 AND status = 'accepted'`, [set.rows[0]!.id]);
    expect(accepted.rows[0]!.n).toBe(1);
  });

  it('keeps a purchase order frozen after issue and a credit hold honest about its release', async () => {
    const supplierOrg = await pg.query<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('supplier', 'Anand', 'Anand') RETURNING id`);
    const profile = await pg.query<{ id: string }>(`INSERT INTO supplier.supplier_profile (organization_id) VALUES ($1) RETURNING id`, [supplierOrg.rows[0]!.id]);
    const order = await pg.query<{ id: string }>(`SELECT id FROM orders.sales_order LIMIT 1`);
    const req = await pg.query<{ id: string }>(`WITH r AS (INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash) SELECT enquiry_id, 2, 'intake', '{}'::jsonb, 'h' FROM orders.sales_order LIMIT 1 RETURNING id, enquiry_id)
      INSERT INTO sourcing.rfq (enquiry_id, requirement_id, round_no, currency, status, deadline_at, released_at) SELECT enquiry_id, id, 1, 'INR', 'awarded', now(), now() FROM r RETURNING id`);
    const award = await pg.query<{ id: string }>(`INSERT INTO commercial.award (rfq_id, proposed_by, currency, status) VALUES ($1, gen_random_uuid(), 'INR', 'approved') RETURNING id`, [req.rows[0]!.id]);
    const po = await pg.query<{ id: string }>(
      `INSERT INTO orders.purchase_order (number, sales_order_id, award_id, supplier_organization_id, supplier_profile_id, currency, total_minor, lead_time_days, content_hash, issued_by)
       VALUES ('PO-2026-0901', $1, $2, $3, $4, 'INR', 100000, 21, 'p1', gen_random_uuid()) RETURNING id`,
      [order.rows[0]!.id, award.rows[0]!.id, supplierOrg.rows[0]!.id, profile.rows[0]!.id],
    );
    await expect(pg.query(`UPDATE orders.purchase_order SET total_minor = 1 WHERE id = $1`, [po.rows[0]!.id])).rejects.toThrow(/immutable/);
    // Acknowledgment is a disposition and must carry its timestamp.
    await expect(pg.query(`UPDATE orders.purchase_order SET status = 'acknowledged' WHERE id = $1`, [po.rows[0]!.id])).rejects.toThrow(/chk_po_acknowledged/);
    await pg.query(`UPDATE orders.purchase_order SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = gen_random_uuid() WHERE id = $1`, [po.rows[0]!.id]);

    const hold = await pg.query<{ id: string }>(`INSERT INTO finance.credit_hold (customer_organization_id, reason, placed_by) VALUES ($1, 'Overdue invoices', gen_random_uuid()) RETURNING id`, [customerOrg]);
    await expect(pg.query(`UPDATE finance.credit_hold SET released_at = now() WHERE id = $1`, [hold.rows[0]!.id])).rejects.toThrow(/chk_credit_hold_release/);
    await pg.query(`UPDATE finance.credit_hold SET released_at = now(), released_by = gen_random_uuid(), release_reason = 'paid' WHERE id = $1`, [hold.rows[0]!.id]);
  });
});
