import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { registerPgTypeParsers } from '../src/pg-types';

registerPgTypeParsers();

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_quotedb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * The commercial schema's teeth (F-07.1): a quote version the customer could have seen
 * never changes content, only one option in an offer set can be accepted, the requester
 * of an approval never decides it, and a decision is never rewritten.
 */
describe('commercial schema constraints (F-07.1)', () => {
  let pg: Client;
  let customerOrg: string;
  let enquiryId: string;
  let termsVersionId: string;

  async function offerSet(): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO commercial.quote_offer_set (enquiry_id, customer_organization_id, created_by)
       VALUES ($1, $2, gen_random_uuid()) RETURNING id`,
      [enquiryId, customerOrg],
    );
    return res.rows[0]!.id;
  }

  async function quote(offerSetId: string, option: string, status = 'draft'): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO commercial.customer_quote
         (offer_set_id, enquiry_id, customer_organization_id, option_label, status, reference, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, gen_random_uuid()) RETURNING id`,
      [offerSetId, enquiryId, customerOrg, option, status, status === 'draft' ? null : `QUO-2026-${randomBytes(2).toString('hex')}`],
    );
    return res.rows[0]!.id;
  }

  async function version(quoteId: string, versionNo: number, status = 'draft'): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO commercial.quote_version
         (customer_quote_id, version_no, currency, subtotal_minor, tax_rate_bp, tax_minor, freight_minor,
          total_minor, delivery_lead_days, payment_terms, validity_until, terms_version_id, content_hash,
          status, created_by)
       VALUES ($1, $2, 'INR', 485000, 1800, 87300, 0, 572300, 7, '50% advance', current_date + 14, $3,
               $4, $5, gen_random_uuid()) RETURNING id`,
      [quoteId, versionNo, termsVersionId, `hash-${versionNo}-${randomBytes(2).toString('hex')}`, status],
    );
    await pg.query(
      `INSERT INTO commercial.quote_line
         (quote_version_id, line_no, description, quantity, unit, unit_price_minor, amount_minor)
       VALUES ($1, 1, 'Bracket support', 100, 'piece', 4850, 485000)`,
      [res.rows[0]!.id],
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
    const enquiry = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.enquiry (customer_organization_id, status) VALUES ($1, 'draft') RETURNING id`,
      [customerOrg],
    );
    enquiryId = enquiry.rows[0]!.id;
    const terms = await pg.query<{ id: string }>(
      `SELECT id FROM commercial.terms_version ORDER BY created_at LIMIT 1`,
    );
    termsVersionId = terms.rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('seeds one active policy version per kind and the launch terms', async () => {
    const policies = await pg.query<{ kind: string; n: number }>(
      `SELECT p.kind, count(v.*)::int AS n
         FROM commercial.approval_policy p
         JOIN commercial.approval_policy_version v ON v.policy_id = p.id AND v.status = 'active'
        GROUP BY p.kind ORDER BY p.kind`,
    );
    expect(policies.rows).toEqual([
      { kind: 'allocation', n: 1 },
      { kind: 'award', n: 1 },
      { kind: 'bill_exception', n: 1 },
      { kind: 'case_resolution', n: 1 },
      { kind: 'change', n: 1 },
      { kind: 'cost_sheet', n: 1 },
      { kind: 'deviation', n: 1 },
      { kind: 'dispatch_override', n: 1 },
      { kind: 'quote', n: 1 },
    ]);
    const terms = await pg.query<{ content_hash: string; body: string }>(
      `SELECT content_hash, body FROM commercial.terms_version`,
    );
    expect(terms.rows[0]!.content_hash).toHaveLength(64);
    expect(terms.rows[0]!.body).toContain('principal');
  });

  it('lets a draft version change and freezes it the moment it leaves draft', async () => {
    const set = await offerSet();
    const q = await quote(set, 'standard');
    const v1 = await version(q, 1, 'draft');

    // A draft is a working document.
    await pg.query(`UPDATE commercial.quote_version SET total_minor = 600000 WHERE id = $1`, [v1]);
    await pg.query(`UPDATE commercial.quote_line SET unit_price_minor = 5000 WHERE quote_version_id = $1`, [v1]);

    // Leaving draft is a disposition change and is allowed...
    await pg.query(`UPDATE commercial.quote_version SET status = 'internal_approval' WHERE id = $1`, [v1]);
    // ...after which content is evidence.
    await expect(
      pg.query(`UPDATE commercial.quote_version SET total_minor = 1 WHERE id = $1`, [v1]),
    ).rejects.toThrow(/content is immutable/);
    await expect(
      pg.query(`UPDATE commercial.quote_line SET unit_price_minor = 1 WHERE quote_version_id = $1`, [v1]),
    ).rejects.toThrow(/frozen version/);
    await expect(pg.query(`DELETE FROM commercial.quote_version WHERE id = $1`, [v1])).rejects.toThrow(
      /cannot be deleted/,
    );
    // The disposition still moves.
    await pg.query(`UPDATE commercial.quote_version SET status = 'sent', sent_at = now() WHERE id = $1`, [v1]);
    const read = await pg.query<{ status: string }>(`SELECT status FROM commercial.quote_version WHERE id = $1`, [v1]);
    expect(read.rows[0]!.status).toBe('sent');
  });

  it('demands a reference once the customer could see the quote', async () => {
    const set = await offerSet();
    await expect(
      pg.query(
        `INSERT INTO commercial.customer_quote
           (offer_set_id, enquiry_id, customer_organization_id, option_label, status, created_by)
         VALUES ($1, $2, $3, 'fast', 'sent', gen_random_uuid())`,
        [set, enquiryId, customerOrg],
      ),
    ).rejects.toThrow(/chk_quote_reference_when_sent/);
  });

  it('allows exactly one accepted option per offer set', async () => {
    const set = await offerSet();
    const standard = await quote(set, 'standard', 'sent');
    const fast = await quote(set, 'fast', 'sent');
    await pg.query(`UPDATE commercial.customer_quote SET status = 'accepted' WHERE id = $1`, [standard]);
    await expect(
      pg.query(`UPDATE commercial.customer_quote SET status = 'accepted' WHERE id = $1`, [fast]),
    ).rejects.toThrow(/uq_offer_set_single_acceptance/);
    // The same option label cannot appear twice in a set either.
    await expect(quote(set, 'fast')).rejects.toThrow(/duplicate key/);
  });

  it('keeps the requester out of the decision and the decision out of reach of edits', async () => {
    const policy = await pg.query<{ id: string }>(
      `SELECT id FROM commercial.approval_policy_version WHERE status = 'active' LIMIT 1`,
    );
    const requester = '00000000-0000-4000-8000-000000000001';
    const request = await pg.query<{ id: string }>(
      `INSERT INTO commercial.approval_request
         (kind, subject_type, subject_id, subject_hash, policy_version_id, requested_by, required_roles)
       VALUES ('quote', 'quote_version', gen_random_uuid(), 'h', $1, $2, '{jobwork_sales}') RETURNING id`,
      [policy.rows[0]!.id, requester],
    );
    const id = request.rows[0]!.id;
    await expect(
      pg.query(
        `INSERT INTO commercial.approval_decision (request_id, decision, decided_by, authority_snapshot)
         VALUES ($1, 'approved', $2, '{}'::jsonb)`,
        [id, requester],
      ),
    ).rejects.toThrow(/cannot decide it/);

    // A negative decision must say why.
    await expect(
      pg.query(
        `INSERT INTO commercial.approval_decision (request_id, decision, decided_by, authority_snapshot)
         VALUES ($1, 'rejected', gen_random_uuid(), '{}'::jsonb)`,
        [id],
      ),
    ).rejects.toThrow(/chk_decision_negative_reason/);

    const decision = await pg.query<{ id: string }>(
      `INSERT INTO commercial.approval_decision (request_id, decision, decided_by, authority_snapshot)
       VALUES ($1, 'approved', gen_random_uuid(), '{"roles":["jobwork_sales"]}'::jsonb) RETURNING id`,
      [id],
    );
    await expect(
      pg.query(`UPDATE commercial.approval_decision SET decision = 'rejected' WHERE id = $1`, [decision.rows[0]!.id]),
    ).rejects.toThrow(/immutable/);
  });

  it('freezes a cost sheet version once approval is requested', async () => {
    const rfq = await pg.query<{ id: string }>(
      `WITH r AS (
         INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash)
         VALUES ($1, 1, 'intake', '{}'::jsonb, 'h') RETURNING id
       )
       INSERT INTO sourcing.rfq (enquiry_id, requirement_id, round_no, currency, status, deadline_at, released_at)
       SELECT $1, r.id, 1, 'INR', 'evaluation', now(), now() FROM r
       RETURNING id`,
      [enquiryId],
    );
    const award = await pg.query<{ id: string }>(
      `INSERT INTO commercial.award (rfq_id, proposed_by, currency) VALUES ($1, gen_random_uuid(), 'INR') RETURNING id`,
      [rfq.rows[0]!.id],
    );
    const sheet = await pg.query<{ id: string }>(
      `INSERT INTO commercial.cost_sheet (rfq_id, award_id, enquiry_id, customer_organization_id, created_by)
       VALUES ($1, $2, $3, $4, gen_random_uuid()) RETURNING id`,
      [rfq.rows[0]!.id, award.rows[0]!.id, enquiryId, customerOrg],
    );
    const v = await pg.query<{ id: string }>(
      `INSERT INTO commercial.cost_sheet_version
         (cost_sheet_id, version_no, currency, buy_total_minor, components, landed_total_minor,
          margin_minor, margin_bp, sell_total_minor, sell_lines, content_hash, created_by)
       VALUES ($1, 1, 'INR', 100, '[]'::jsonb, 100, 20, 1667, 120, '[]'::jsonb, 'h', gen_random_uuid())
       RETURNING id`,
      [sheet.rows[0]!.id],
    );
    await pg.query(`UPDATE commercial.cost_sheet_version SET margin_minor = 30 WHERE id = $1`, [v.rows[0]!.id]);
    await pg.query(`UPDATE commercial.cost_sheet_version SET status = 'pending_approval' WHERE id = $1`, [v.rows[0]!.id]);
    await expect(
      pg.query(`UPDATE commercial.cost_sheet_version SET margin_minor = 40 WHERE id = $1`, [v.rows[0]!.id]),
    ).rejects.toThrow(/frozen/);
  });
});
