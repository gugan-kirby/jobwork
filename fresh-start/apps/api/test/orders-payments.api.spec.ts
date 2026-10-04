import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCAN_WORKER_PRINCIPAL, SERVICE_TOKEN_HEADER, mintServiceToken } from '@jobwork/service-auth';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'orders-password-1';
const WEBHOOK_SECRET = 'test-payment-webhook-secret';

/**
 * IN-08 end to end (`FR-407`, `FR-501`, `FR-502`, `FR-803`, doc 19 §10 scenario 1 tail):
 * exact-bytes acceptance with authority and idempotency, one accepted option per offer set
 * under a race, purchase orders per awarded supplier, a verified webhook that settles the
 * advance and releases the order, replays that change nothing, overpayment kept as the
 * customer's credit, unknown money held in suspense until a maker-checker allocation, and
 * credit terms that release an order without an advance — with every journal balanced.
 */
describe('Acceptance, orders, purchase orders and payments (IN-08)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let customer: TestClient;
  let approver: TestClient;
  let limitedApprover: TestClient;
  let sourcing: TestClient;
  let finance: TestClient;
  let finance2: TestClient;
  let supplierA: TestClient;
  let supplierB: TestClient;

  let customerOrgId: string;
  let supplierOrgA: string;
  let supplierOrgB: string;
  let costSheetVersionId: string;
  let termsVersionId: string;
  let termsHash: string;
  let quoteCounter = 9000;
  let enquiryCounter = 8000;

  let orderId: string;
  let advanceInvoiceId: string;

  function totpCode(secret: string, email: string): string {
    return new OTPAuth.TOTP({ issuer: 'JobWork', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  }

  async function seedOrg(type: string, name: string): Promise<string> {
    const res = await pg.query<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ($1, $2, $2) RETURNING id`, [type, name]);
    return res.rows[0]!.id;
  }

  async function seedUser(orgId: string, email: string, roles: string[]): Promise<string> {
    const user = await pg.query<{ id: string }>(
      `INSERT INTO iam.user_account (email, password_hash, password_params_version, display_name, status, email_verified_at)
       VALUES ($1, $2, 1, $3, 'active', now()) RETURNING id`,
      [email, await hashPassword(PASSWORD), email.split('@')[0]],
    );
    const membership = await pg.query<{ id: string }>(`INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`, [user.rows[0]!.id, orgId]);
    await pg.query(`INSERT INTO iam.membership_role (membership_id, role_id) SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`, [membership.rows[0]!.id, roles]);
    return membership.rows[0]!.id;
  }

  async function signIn(email: string): Promise<TestClient> {
    const client = new TestClient(baseUrl);
    const res = await client.post('/api/v1/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(201);
    return client;
  }

  async function signInWithMfa(email: string): Promise<TestClient> {
    const first = await signIn(email);
    const enroll = await first.post('/api/v1/account/mfa/enroll');
    await first.post('/api/v1/account/mfa/activate', { code: totpCode(enroll.body['secret'] as string, email) });
    const fresh = new TestClient(baseUrl);
    await fresh.post('/api/v1/auth/login', { email, password: PASSWORD });
    const secret = await pg.query<{ mfa_totp_secret: string }>(`SELECT mfa_totp_secret FROM iam.user_account WHERE email = $1`, [email]);
    await fresh.post('/api/v1/auth/mfa', { code: totpCode(secret.rows[0]!.mfa_totp_secret, email) });
    return fresh;
  }

  /**
   * The IN-07 chain as fixture: an awarded round split 60/40 between two suppliers, an
   * approved cost sheet, and (per call) a fresh enquiry with one or more sent options.
   */
  async function seedAwardAndCostSheet(): Promise<void> {
    const enquiry = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.enquiry (customer_organization_id, title, status, reference, submitted_at, submitted_by)
       VALUES ($1, 'Pump bracket', 'approved_for_sourcing', 'ENQ-2026-7999', now(), gen_random_uuid()) RETURNING id`,
      [customerOrgId],
    );
    const requirement = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash) VALUES ($1, 1, 'reviewed', '{}'::jsonb, 'req') RETURNING id`,
      [enquiry.rows[0]!.id],
    );
    const rfq = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.rfq (enquiry_id, requirement_id, round_no, reference, status, currency, deadline_at, released_at)
       VALUES ($1, $2, 1, 'RFQ-2026-7999-R1', 'awarded', 'INR', now(), now()) RETURNING id`,
      [enquiry.rows[0]!.id, requirement.rows[0]!.id],
    );
    const item = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.rfq_item (rfq_id, line_no, part_name, description, quantity_breakpoints)
       VALUES ($1, 1, 'Pump bracket', 'Machined 6061', '[{"quantity":100,"unit":"piece","kind":"production"}]'::jsonb) RETURNING id`,
      [rfq.rows[0]!.id],
    );
    const award = await pg.query<{ id: string }>(
      `INSERT INTO commercial.award (rfq_id, status, proposed_by, currency, buy_total_minor) VALUES ($1, 'approved', gen_random_uuid(), 'INR', 900000) RETURNING id`,
      [rfq.rows[0]!.id],
    );
    const shares: Array<[string, number, number]> = [
      [supplierOrgA, 60, 9000],
      [supplierOrgB, 40, 9000],
    ];
    for (const [orgId, quantity, unitPrice] of shares) {
      const profile = await pg.query<{ id: string }>(`SELECT id FROM supplier.supplier_profile WHERE organization_id = $1`, [orgId]);
      const invitation = await pg.query<{ id: string }>(
        `INSERT INTO sourcing.rfq_supplier (rfq_id, supplier_profile_id, supplier_organization_id, status) VALUES ($1, $2, $3, 'responded') RETURNING id`,
        [rfq.rows[0]!.id, profile.rows[0]!.id, orgId],
      );
      const bid = await pg.query<{ id: string }>(
        `INSERT INTO sourcing.supplier_bid (rfq_id, rfq_supplier_id, supplier_organization_id, current_version_no) VALUES ($1, $2, $3, 1) RETURNING id`,
        [rfq.rows[0]!.id, invitation.rows[0]!.id, orgId],
      );
      const version = await pg.query<{ id: string }>(
        `INSERT INTO sourcing.supplier_bid_version (supplier_bid_id, version_no, currency, lines_total_minor, total_amount_minor, lead_time_days, validity_until, payment_terms, content_hash, status)
         VALUES ($1, 1, 'INR', 900000, 900000, 18, current_date + 30, '45 days from invoice', $2, 'selected') RETURNING id`,
        [bid.rows[0]!.id, randomBytes(32).toString('hex')],
      );
      await pg.query(
        `INSERT INTO commercial.award_line (award_id, rfq_item_id, bid_version_id, supplier_organization_id, bid_quantity, quantity, unit, unit_price_minor, setup_amount_minor, line_total_minor)
         VALUES ($1, $2, $3, $4, 100, $5, 'piece', $6, 0, $7)`,
        [award.rows[0]!.id, item.rows[0]!.id, version.rows[0]!.id, orgId, quantity, unitPrice, quantity * unitPrice],
      );
    }
    const sheet = await pg.query<{ id: string }>(
      `INSERT INTO commercial.cost_sheet (rfq_id, award_id, enquiry_id, customer_organization_id, status, current_version_no, created_by)
       VALUES ($1, $2, $3, $4, 'approved', 1, gen_random_uuid()) RETURNING id`,
      [rfq.rows[0]!.id, award.rows[0]!.id, enquiry.rows[0]!.id, customerOrgId],
    );
    const sheetVersion = await pg.query<{ id: string }>(
      `INSERT INTO commercial.cost_sheet_version (cost_sheet_id, version_no, currency, buy_total_minor, components, landed_total_minor, margin_minor, margin_bp, sell_total_minor, sell_lines, content_hash, status, created_by)
       VALUES ($1, 1, 'INR', 900000, '[]'::jsonb, 950000, 250000, 2083, 1200000, '[]'::jsonb, 'cs', 'approved', gen_random_uuid()) RETURNING id`,
      [sheet.rows[0]!.id],
    );
    costSheetVersionId = sheetVersion.rows[0]!.id;
  }

  interface SeededQuote {
    quoteId: string;
    versionNo: number;
    contentHash: string;
    aggregateVersion: number;
    totalMinor: number;
  }

  /** 100 × ₹120.00 = ₹1,20,000.00 + 18 % GST = ₹1,41,600.00 per option (unit price varies by option). */
  async function seedOffer(options: Array<'standard' | 'fast'>, schedule: { advanceBp: number; balanceTrigger: string } = { advanceBp: 5000, balanceTrigger: 'before_dispatch' }): Promise<SeededQuote[]> {
    enquiryCounter += 1;
    const enquiry = await pg.query<{ id: string }>(
      `INSERT INTO sourcing.enquiry (customer_organization_id, title, status, reference, submitted_at, submitted_by)
       VALUES ($1, 'Pump bracket', 'approved_for_sourcing', $2, now(), gen_random_uuid()) RETURNING id`,
      [customerOrgId, `ENQ-2026-${enquiryCounter}`],
    );
    const set = await pg.query<{ id: string }>(
      `INSERT INTO commercial.quote_offer_set (enquiry_id, customer_organization_id, created_by) VALUES ($1, $2, gen_random_uuid()) RETURNING id`,
      [enquiry.rows[0]!.id, customerOrgId],
    );
    const out: SeededQuote[] = [];
    for (const option of options) {
      quoteCounter += 1;
      const unitPrice = option === 'standard' ? 12_000 : 13_500;
      const subtotal = unitPrice * 100;
      const tax = Math.round(subtotal * 0.18);
      const total = subtotal + tax;
      const contentHash = randomBytes(32).toString('hex');
      const quote = await pg.query<{ id: string }>(
        `INSERT INTO commercial.customer_quote (offer_set_id, enquiry_id, customer_organization_id, option_label, reference, cost_sheet_version_id, status, current_version_no, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'sent', 1, gen_random_uuid()) RETURNING id`,
        [set.rows[0]!.id, enquiry.rows[0]!.id, customerOrgId, option, `QUO-2026-${quoteCounter}`, costSheetVersionId],
      );
      const version = await pg.query<{ id: string }>(
        `INSERT INTO commercial.quote_version (customer_quote_id, version_no, currency, subtotal_minor, tax_rate_bp, tax_minor, freight_minor, total_minor,
           delivery_lead_days, payment_terms, validity_until, terms_version_id, content_hash, status, sent_at, created_by, advance_bp, balance_trigger)
         VALUES ($1, 1, 'INR', $2, 1800, $3, 0, $4, 21, '50% advance, balance before dispatch', current_date + 14, $5, $6, 'sent', now(), gen_random_uuid(), $7, $8) RETURNING id`,
        [quote.rows[0]!.id, subtotal, tax, total, termsVersionId, contentHash, schedule.advanceBp, schedule.balanceTrigger],
      );
      await pg.query(
        `INSERT INTO commercial.quote_line (quote_version_id, line_no, description, quantity, unit, unit_price_minor, amount_minor) VALUES ($1, 1, 'Pump bracket, machined 6061', 100, 'piece', $2, $3)`,
        [version.rows[0]!.id, unitPrice, subtotal],
      );
      out.push({ quoteId: quote.rows[0]!.id, versionNo: 1, contentHash, aggregateVersion: 1, totalMinor: total });
    }
    return out;
  }

  function acceptBody(quote: SeededQuote, overrides: Record<string, unknown> = {}) {
    return { expectedVersion: quote.aggregateVersion, quoteVersionNo: quote.versionNo, contentHash: quote.contentHash, termsHash, acknowledgeTerms: true, ...overrides };
  }

  function accept(client: TestClient, quote: SeededQuote, overrides: Record<string, unknown> = {}) {
    return client.post(`/api/v1/quotations/${quote.quoteId}/accept`, acceptBody(quote, overrides));
  }

  async function postWithKey(client: TestClient, path: string, body: unknown, key: string) {
    // TestClient has no idempotency header; go through fetch with its cookies.
    const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': key };
    const cookies = ['jw_session', 'jw_csrf'].map((n) => [n, client.cookie(n)] as const).filter(([, v]) => v);
    headers['cookie'] = cookies.map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = client.cookie('jw_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  }

  function signedWebhook(input: { providerIntentId: string; amountMinor: number; transactionId?: string; deliveryId?: string; type?: string; currency?: string; signedAt?: number }) {
    const body = JSON.stringify({
      id: input.deliveryId ?? `evt_${randomUUID()}`,
      type: input.type ?? 'payment.captured',
      data: {
        intentId: input.providerIntentId,
        transactionId: input.transactionId ?? `txn_${randomUUID()}`,
        amountMinor: input.amountMinor,
        currency: input.currency ?? 'INR',
        occurredAt: new Date().toISOString(),
      },
    });
    const parsed = JSON.parse(body) as { id: string };
    const timestamp = String(input.signedAt ?? Math.floor(Date.now() / 1000));
    return {
      body,
      headers: {
        'content-type': 'application/json',
        'x-dev-signature': createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex'),
        'x-dev-timestamp': timestamp,
        'x-dev-delivery-id': parsed.id,
      },
    };
  }

  async function sendWebhook(hook: { body: string; headers: Record<string, string> }) {
    const res = await fetch(`${baseUrl}/api/v1/webhooks/payments/dev`, { method: 'POST', headers: hook.headers, body: hook.body });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  }

  async function unbalancedJournals(): Promise<number> {
    const res = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT journal_id FROM finance.journal_line GROUP BY journal_id HAVING sum(debit_minor) <> sum(credit_minor)
       ) x`,
    );
    return res.rows[0]!.n;
  }

  function keysOf(value: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        out.add(k);
        keysOf(v, out);
      }
    }
    return out;
  }

  const BUY_SIDE = /supplier|bid|purchase|award|cost|margin|vendor/i;

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_orders');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['PAYMENT_WEBHOOK_SECRET'] = WEBHOOK_SECRET;
    process.env['NODE_ENV'] = 'test';

    pg = new Client({ connectionString: db.url });
    await pg.connect();
    const terms = await pg.query<{ id: string; content_hash: string }>(`SELECT id, content_hash FROM commercial.terms_version ORDER BY version_no DESC LIMIT 1`);
    termsVersionId = terms.rows[0]!.id;
    termsHash = terms.rows[0]!.content_hash;

    customerOrgId = await seedOrg('customer', 'Kovai Pumps');
    const internalOrgId = await seedOrg('internal', 'JobWork Operations');
    supplierOrgA = await seedOrg('supplier', 'Anand Engineering');
    supplierOrgB = await seedOrg('supplier', 'Balaji Precision');
    for (const orgId of [supplierOrgA, supplierOrgB]) {
      await pg.query(
        `INSERT INTO supplier.supplier_profile
           (organization_id, region_class, status, decided_by, decided_at, submitted_by, trade_name, primary_contact_name, primary_contact_email, primary_contact_phone, summary)
         VALUES ($1, 'chennai_metro', 'active', gen_random_uuid(), now(), gen_random_uuid(), 'Works', 'Contact', 'contact@example.test', '+91 90000 00000', 'We machine things')`,
        [orgId],
      );
    }
    await seedUser(customerOrgId, 'buyer@kovai.test', ['customer_requester']);
    await seedUser(customerOrgId, 'approver@kovai.test', ['customer_approver']);
    const limited = await seedUser(customerOrgId, 'limited@kovai.test', ['customer_approver']);
    await pg.query(`INSERT INTO iam.approval_limit (membership_id, limit_type, amount_minor, currency) VALUES ($1, 'quote_acceptance', 1000000, 'INR')`, [limited]);
    await seedUser(internalOrgId, 'sourcing@jobwork.test', ['jobwork_sourcing']);
    await seedUser(internalOrgId, 'finance@jobwork.test', ['jobwork_finance']);
    await seedUser(internalOrgId, 'finance2@jobwork.test', ['jobwork_finance']);
    await seedUser(supplierOrgA, 'estimator@anand.test', ['org_admin', 'supplier_estimator']);
    await seedUser(supplierOrgB, 'estimator@balaji.test', ['org_admin', 'supplier_estimator']);
    await seedAwardAndCostSheet();

    ({ app, baseUrl } = await createTestApp());
    customer = await signIn('buyer@kovai.test');
    approver = await signIn('approver@kovai.test');
    limitedApprover = await signIn('limited@kovai.test');
    sourcing = await signInWithMfa('sourcing@jobwork.test');
    finance = await signInWithMfa('finance@jobwork.test');
    finance2 = await signInWithMfa('finance2@jobwork.test');
    supplierA = await signIn('estimator@anand.test');
    supplierB = await signIn('estimator@balaji.test');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  // ---------------------------------------------------------------- F-08.2 acceptance

  it('refuses acceptance without authority, over a limit, or against bytes the customer did not see', async () => {
    const [quote] = await seedOffer(['standard']);
    const requester = await accept(customer, quote!);
    expect(requester.status).toBe(403);

    const overLimit = await accept(limitedApprover, quote!);
    expect(overLimit.status).toBe(403);
    expect(overLimit.body['code']).toBe('APPROVAL_LIMIT_EXCEEDED');

    for (const [overrides, code] of [
      [{ contentHash: 'f'.repeat(64) }, 'QUOTE_CONTENT_MISMATCH'],
      [{ termsHash: 'e'.repeat(64) }, 'QUOTE_CONTENT_MISMATCH'],
      [{ quoteVersionNo: 2 }, 'QUOTE_CONTENT_MISMATCH'],
      [{ expectedVersion: 7 }, 'VERSION_CONFLICT'],
    ] as const) {
      const res = await accept(approver, quote!, overrides);
      expect(res.status).toBe(409);
      expect(res.body['code']).toBe(code);
    }
    const missingAck = await accept(approver, quote!, { acknowledgeTerms: false });
    expect(missingAck.status).toBe(400);

    // Accepted as it expires (doc 19 §4): validity is checked inside the transaction.
    const [late] = await seedOffer(['standard']);
    await pg.query(`ALTER TABLE commercial.quote_version DISABLE TRIGGER trg_quote_version_immutable`);
    await pg.query(`UPDATE commercial.quote_version SET validity_until = current_date - 2 WHERE customer_quote_id = $1`, [late!.quoteId]);
    await pg.query(`ALTER TABLE commercial.quote_version ENABLE TRIGGER trg_quote_version_immutable`);
    const expired = await accept(approver, late!);
    expect(expired.status).toBe(409);
    expect(expired.body['code']).toBe('QUOTE_EXPIRED');
    // Nothing persisted by any refusal.
    const evidence = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM commercial.acceptance WHERE customer_quote_id = $1`, [quote!.quoteId]);
    expect(evidence.rows[0]!.n).toBe(0);
  });

  it('binds the exact version, creates the order, snapshot and advance invoice, and withdraws the sibling — once per key', async () => {
    const [standard, fast] = await seedOffer(['standard', 'fast']);
    const key = `accept-${randomUUID()}`;
    const first = await postWithKey(approver, `/api/v1/quotations/${standard!.quoteId}/accept`, acceptBody(standard!), key);
    expect(first.status).toBe(201);
    orderId = first.body['orderId'] as string;
    expect(first.body['status']).toBe('payment_needed');
    expect(first.body['nextStep']).toMatchObject({ owner: 'you', label: 'Pay the advance' });

    // The same key returns the same result; nothing is created twice.
    const retry = await postWithKey(approver, `/api/v1/quotations/${standard!.quoteId}/accept`, acceptBody(standard!), key);
    expect(retry.status).toBe(201);
    expect(retry.body['orderId']).toBe(orderId);
    const orders = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders.sales_order WHERE customer_quote_id = $1`, [standard!.quoteId]);
    expect(orders.rows[0]!.n).toBe(1);

    // Evidence: exact hash, terms hash, the authority used.
    const evidence = await pg.query<{ content_hash: string; terms_hash: string; authority_snapshot: { roles: string[] }; idempotency_key: string }>(
      `SELECT content_hash, terms_hash, authority_snapshot, idempotency_key FROM commercial.acceptance WHERE customer_quote_id = $1`,
      [standard!.quoteId],
    );
    expect(evidence.rows[0]).toMatchObject({ content_hash: standard!.contentHash, terms_hash: termsHash, idempotency_key: key });
    expect(evidence.rows[0]!.authority_snapshot.roles).toContain('customer_approver');

    // The sibling option is closed with a reason.
    const sibling = await pg.query<{ status: string; decision_reason: string }>(`SELECT status, decision_reason FROM commercial.customer_quote WHERE id = $1`, [fast!.quoteId]);
    expect(sibling.rows[0]).toMatchObject({ status: 'withdrawn' });
    expect(sibling.rows[0]!.decision_reason).toMatch(/standard/);

    // 50 % advance invoiced at acceptance; advance + balance = the quotation, tax included.
    const invoices = first.body['invoices'] as Array<Record<string, unknown>>;
    expect(invoices).toHaveLength(1);
    advanceInvoiceId = invoices[0]!['invoiceId'] as string;
    expect(invoices[0]!['totalMinor']).toBe(standard!.totalMinor / 2);
    const installments = first.body['installments'] as Array<Record<string, unknown>>;
    expect(installments.map((i) => i['amountMinor'] as number).reduce((a, b) => a + b, 0)).toBe(standard!.totalMinor);

    // The customer's order carries nothing of the buy side.
    const leaked = [...keysOf(first.body)].filter((k) => BUY_SIDE.test(k));
    expect(leaked).toEqual([]);
    expect(JSON.stringify(first.body)).not.toMatch(/Anand|Balaji/);

    // A second acceptance with a new key is refused.
    const again = await postWithKey(approver, `/api/v1/quotations/${standard!.quoteId}/accept`, acceptBody(standard!, { expectedVersion: 3 }), `accept-${randomUUID()}`);
    expect(again.status).toBe(409);
    expect(await unbalancedJournals()).toBe(0);
  });

  it('lets exactly one of two options accepted at the same moment win', async () => {
    const [standard, fast] = await seedOffer(['standard', 'fast']);
    const [a, b] = await Promise.all([
      postWithKey(approver, `/api/v1/quotations/${standard!.quoteId}/accept`, acceptBody(standard!), `race-a-${randomUUID()}`),
      postWithKey(approver, `/api/v1/quotations/${fast!.quoteId}/accept`, acceptBody(fast!), `race-b-${randomUUID()}`),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const accepted = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM commercial.customer_quote q JOIN commercial.customer_quote s ON s.offer_set_id = q.offer_set_id
        WHERE q.id = $1 AND s.status = 'accepted'`,
      [standard!.quoteId],
    );
    expect(accepted.rows[0]!.n).toBe(1);
    const created = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders.sales_order WHERE customer_quote_id = ANY($1::uuid[])`, [[standard!.quoteId, fast!.quoteId]]);
    expect(created.rows[0]!.n).toBe(1);
  });

  // ---------------------------------------------------------------- F-08.3 purchase orders

  it('issues one purchase order per awarded supplier, visible only to that supplier, and takes its acknowledgment', async () => {
    const before = await sourcing.get(`/api/v1/sales-orders/${orderId}`);
    expect(before.status).toBe(200);
    const issued = await sourcing.post(`/api/v1/sales-orders/${orderId}/purchase-orders`, { expectedVersion: before.body['aggregateVersion'] });
    expect(issued.status).toBe(201);
    const pos = issued.body['purchaseOrders'] as Array<Record<string, unknown>>;
    expect(pos).toHaveLength(2);
    expect(pos.map((p) => p['totalMinor']).sort()).toEqual([360000, 540000]);
    expect(pos.every((p) => p['baselineStatus'] === 'pending_baseline')).toBe(true);

    const twice = await sourcing.post(`/api/v1/sales-orders/${orderId}/purchase-orders`, { expectedVersion: issued.body['aggregateVersion'] });
    expect(twice.status).toBe(409);

    // Finance cannot issue purchase orders; a customer cannot read the internal order.
    expect((await finance.post(`/api/v1/sales-orders/${orderId}/purchase-orders`, { expectedVersion: issued.body['aggregateVersion'] })).status).toBe(403);
    expect((await approver.get(`/api/v1/sales-orders/${orderId}`)).status).toBe(403);

    const mine = await supplierA.get('/api/v1/supplier/purchase-orders');
    const list = mine.body['purchaseOrders'] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]!['totalMinor']).toBe(540000);
    // The supplier sees its own price and lead time — no customer, no sell side.
    expect(JSON.stringify(mine.body)).not.toMatch(/Kovai|customer|sell|quotation/i);
    const poA = list[0]!['purchaseOrderId'] as string;
    expect((await supplierB.get(`/api/v1/supplier/purchase-orders/${poA}`)).status).toBe(404);

    const ack = await supplierA.post(`/api/v1/supplier/purchase-orders/${poA}/acknowledge`, { expectedVersion: list[0]!['aggregateVersion'], note: 'Material booked.' });
    expect(ack.status).toBe(201);
    expect(ack.body['status']).toBe('acknowledged');
    expect((await supplierA.post(`/api/v1/supplier/purchase-orders/${poA}/acknowledge`, { expectedVersion: ack.body['aggregateVersion'], note: '' })).status).toBe(409);
  });

  // ---------------------------------------------------------------- F-08.4 payments

  it('settles the advance only through a verified callback, releases the order, and ignores replays', async () => {
    const intent = await postWithKey(approver, `/api/v1/invoices/${advanceInvoiceId}/pay`, {}, `pay-${randomUUID()}`);
    expect(intent.status).toBe(201);
    expect(intent.body['amountMinor']).toBe(70800 * 10);
    // Asking again returns the same open intent instead of piling up new ones.
    const same = await postWithKey(approver, `/api/v1/invoices/${advanceInvoiceId}/pay`, {}, `pay-${randomUUID()}`);
    expect(same.body['paymentIntentId']).toBe(intent.body['paymentIntentId']);
    const provider = await pg.query<{ provider_intent_id: string }>(`SELECT provider_intent_id FROM finance.payment_intent WHERE id = $1`, [intent.body['paymentIntentId']]);
    const providerIntentId = provider.rows[0]!.provider_intent_id;

    // The browser coming back from checkout proves nothing: until a verified callback, it is pending.
    const waiting = await approver.get(`/api/v1/invoices/${advanceInvoiceId}`);
    expect(waiting.body['status']).toBe('unpaid');
    expect((waiting.body['pendingPayment'] as Record<string, unknown>)['paymentIntentId']).toBe(intent.body['paymentIntentId']);

    // A correctly signed callback from ten minutes ago is refused as a possible replay.
    const stale = await sendWebhook(signedWebhook({ providerIntentId, amountMinor: 708000, signedAt: Math.floor(Date.now() / 1000) - 600 }));
    expect(stale.status).toBe(401);

    // A forged callback is refused and moves no money.
    const forged = signedWebhook({ providerIntentId, amountMinor: 708000 });
    const rejected = await sendWebhook({ body: forged.body, headers: { ...forged.headers, 'x-dev-signature': 'a'.repeat(64) } });
    expect(rejected.status).toBe(401);
    const unpaid = await approver.get(`/api/v1/invoices/${advanceInvoiceId}`);
    expect(unpaid.body['status']).toBe('unpaid');
    // …and it did not burn the delivery id the genuine callback carries.
    const genuine = await sendWebhook(forged);
    expect(genuine.status).toBe(200);
    expect(genuine.body['outcome']).toBe('processed');

    const paid = await approver.get(`/api/v1/invoices/${advanceInvoiceId}`);
    expect(paid.body).toMatchObject({ status: 'paid', paidMinor: 708000, openMinor: 0 });
    const order = await approver.get(`/api/v1/orders/${orderId}`);
    expect(order.body['status']).toBe('technical_confirmation');
    const internal = await finance.get(`/api/v1/sales-orders/${orderId}`);
    expect(internal.body['status']).toBe('pending_technical_release');
    expect(internal.body['commercialReleaseBasis']).toBe('advance_paid');

    // The same delivery again, and the same transaction under a new delivery id: no second posting.
    expect((await sendWebhook(forged)).body['outcome']).toBe('duplicate');
    const txn = (JSON.parse(forged.body) as { data: { transactionId: string } }).data.transactionId;
    expect((await sendWebhook(signedWebhook({ providerIntentId, amountMinor: 708000, transactionId: txn }))).body['outcome']).toBe('duplicate');
    // Out of order: an "authorized" notice arriving after the capture changes nothing.
    expect((await sendWebhook(signedWebhook({ providerIntentId, amountMinor: 708000, type: 'payment.authorized' }))).body['outcome']).toBe('ignored');
    const after = await approver.get(`/api/v1/invoices/${advanceInvoiceId}`);
    expect(after.body['paidMinor']).toBe(708000);
    expect(await unbalancedJournals()).toBe(0);
  });

  it('keeps an overpayment as the customer’s visible credit, never a wallet', async () => {
    const order = await finance.get(`/api/v1/sales-orders/${orderId}`);
    const balance = (order.body['installments'] as Array<Record<string, unknown>>).find((i) => i['kind'] === 'balance')!;
    const issued = await finance.post(`/api/v1/sales-orders/${orderId}/invoices`, { expectedVersion: order.body['aggregateVersion'], installmentId: balance['installmentId'] });
    expect(issued.status).toBe(201);
    const balanceInvoice = (issued.body['invoices'] as Array<Record<string, unknown>>).find((i) => i['kind'] === 'balance')!;
    expect(balanceInvoice['totalMinor']).toBe(708000);

    const intent = await postWithKey(approver, `/api/v1/invoices/${balanceInvoice['invoiceId']}/pay`, {}, `pay-${randomUUID()}`);
    const provider = await pg.query<{ provider_intent_id: string }>(`SELECT provider_intent_id FROM finance.payment_intent WHERE id = $1`, [intent.body['paymentIntentId']]);
    const res = await sendWebhook(signedWebhook({ providerIntentId: provider.rows[0]!.provider_intent_id, amountMinor: 710000 }));
    expect(res.body['outcome']).toBe('processed');

    const payments = await approver.get('/api/v1/payments');
    expect(payments.status).toBe(200);
    expect(payments.body['unappliedCreditMinor']).toBe(2000);
    expect((payments.body['payments'] as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect([...keysOf(payments.body)].filter((k) => /wallet|balanceTopUp|addMoney/i.test(k))).toEqual([]);
    const invoice = await approver.get(`/api/v1/invoices/${balanceInvoice['invoiceId']}`);
    expect(invoice.body['status']).toBe('paid');
    expect(await unbalancedJournals()).toBe(0);
  });

  it('runs the dev checkout through the same verified path', async () => {
    const [quote] = await seedOffer(['standard']);
    const accepted = await postWithKey(approver, `/api/v1/quotations/${quote!.quoteId}/accept`, acceptBody(quote!), `accept-${randomUUID()}`);
    const invoiceId = (accepted.body['invoices'] as Array<Record<string, unknown>>)[0]!['invoiceId'] as string;
    const intent = await postWithKey(approver, `/api/v1/invoices/${invoiceId}/pay`, {}, `pay-${randomUUID()}`);
    expect(intent.body['simulated']).toBe(true);
    const failed = await approver.post(`/api/v1/payments/intents/${intent.body['paymentIntentId']}/simulate`, { outcome: 'failure' });
    expect(failed.body['status']).toBe('failed');
    const retry = await postWithKey(approver, `/api/v1/invoices/${invoiceId}/pay`, {}, `pay-${randomUUID()}`);
    expect(retry.body['paymentIntentId']).not.toBe(intent.body['paymentIntentId']);
    const ok = await approver.post(`/api/v1/payments/intents/${retry.body['paymentIntentId']}/simulate`, { outcome: 'success' });
    expect(ok.body['status']).toBe('captured');
    expect((await approver.get(`/api/v1/invoices/${invoiceId}`)).body['status']).toBe('paid');
    // Another organization cannot see, pay or simulate it.
    expect((await supplierA.get(`/api/v1/invoices/${invoiceId}`)).status).toBe(403);
  });

  // ---------------------------------------------------------------- F-08.5 reconciliation

  it('closes an intent nobody paid before it expired, through the service sweep only', async () => {
    const [quote] = await seedOffer(['standard']);
    const accepted = await postWithKey(approver, `/api/v1/quotations/${quote!.quoteId}/accept`, acceptBody(quote!), `accept-${randomUUID()}`);
    const invoiceId = (accepted.body['invoices'] as Array<Record<string, unknown>>)[0]!['invoiceId'] as string;
    const intent = await postWithKey(approver, `/api/v1/invoices/${invoiceId}/pay`, {}, `pay-${randomUUID()}`);
    await pg.query(`UPDATE finance.payment_intent SET expires_at = now() - interval '1 minute' WHERE id = $1`, [intent.body['paymentIntentId']]);

    // A user session cannot run the sweep; only the worker's service principal can.
    expect((await finance.post('/api/v1/internal/payments/reconcile-sweep')).status).toBe(401);
    const res = await fetch(`${baseUrl}/api/v1/internal/payments/reconcile-sweep`, {
      method: 'POST',
      headers: { [SERVICE_TOKEN_HEADER]: mintServiceToken('test-service-token-secret', SCAN_WORKER_PRINCIPAL.name) },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { expired: number }).expired).toBeGreaterThanOrEqual(1);
    const invoice = await approver.get(`/api/v1/invoices/${invoiceId}`);
    expect(invoice.body['pendingPayment']).toBeNull();
    expect(invoice.body['status']).toBe('unpaid');
  });

  it('holds unknown money in suspense until a second finance user approves its allocation', async () => {
    const [quote] = await seedOffer(['standard']);
    const accepted = await postWithKey(approver, `/api/v1/quotations/${quote!.quoteId}/accept`, acceptBody(quote!), `accept-${randomUUID()}`);
    const invoiceId = (accepted.body['invoices'] as Array<Record<string, unknown>>)[0]!['invoiceId'] as string;

    const stray = await sendWebhook(signedWebhook({ providerIntentId: 'dev_pi_nobody_knows', amountMinor: 708000 }));
    expect(stray.body['outcome']).toBe('suspense');
    const transactionId = stray.body['transactionId'] as string;

    const bank = await finance.post('/api/v1/finance/bank-transfers', { bankReference: 'UTR-2026-0001', amountMinor: 5000, occurredAt: new Date().toISOString() });
    expect(bank.status).toBe(201);
    const dup = await finance.post('/api/v1/finance/bank-transfers', { bankReference: 'utr-2026-0001', amountMinor: 5000, occurredAt: new Date().toISOString() });
    expect(dup.status).toBe(409);

    const queue = await finance.get('/api/v1/finance/reconciliation');
    expect((queue.body['suspense'] as Array<Record<string, unknown>>).map((t) => t['transactionId'])).toContain(transactionId);
    expect((await sourcing.get('/api/v1/finance/reconciliation')).status).toBe(403);

    const tooMuch = await finance.post('/api/v1/finance/allocations', { transactionId, invoiceId, amountMinor: 999999 });
    expect(tooMuch.status).toBe(422);
    const proposed = await finance.post('/api/v1/finance/allocations', { transactionId, invoiceId, amountMinor: 708000, note: 'Customer confirmed by phone' });
    expect(proposed.status).toBe(201);
    const pending = (proposed.body['pendingAllocations'] as Array<Record<string, unknown>>).find((p) => p['transactionId'] === transactionId)!;

    // The maker cannot be the checker.
    const self = await finance.post(`/api/v1/approvals/${pending['approvalRequestId']}/decide`, { decision: 'approved', reason: '' });
    expect(self.status).toBe(409);
    expect((await approver.get(`/api/v1/invoices/${invoiceId}`)).body['status']).toBe('unpaid');

    const checked = await finance2.post(`/api/v1/approvals/${pending['approvalRequestId']}/decide`, { decision: 'approved', reason: '' });
    expect(checked.status).toBe(201);
    expect((await approver.get(`/api/v1/invoices/${invoiceId}`)).body['status']).toBe('paid');
    const txn = await finance.get(`/api/v1/finance/transactions/${transactionId}`);
    expect(txn.body['status']).toBe('allocated');
    expect((txn.body['allocations'] as unknown[]).length).toBe(1);
    const order = await finance.get(`/api/v1/sales-orders/${accepted.body['orderId']}`);
    expect(order.body['status']).toBe('pending_technical_release');
    expect(await unbalancedJournals()).toBe(0);
  });

  // ---------------------------------------------------------------- F-08.6 credit

  it('releases an order on approved credit, and a hold blocks it with the reason', async () => {
    const set = await finance.post(`/api/v1/finance/credit/${customerOrgId}`, { limitMinor: 50_000_000, termsDays: 30, note: 'Annual review 2026' });
    expect(set.status).toBe(201);
    expect((await sourcing.post(`/api/v1/finance/credit/${customerOrgId}`, { limitMinor: 1, termsDays: 0 })).status).toBe(403);

    const [covered] = await seedOffer(['standard']);
    const accepted = await postWithKey(approver, `/api/v1/quotations/${covered!.quoteId}/accept`, acceptBody(covered!), `accept-${randomUUID()}`);
    expect(accepted.body['status']).toBe('technical_confirmation');
    const internal = await finance.get(`/api/v1/sales-orders/${accepted.body['orderId']}`);
    expect(internal.body['commercialReleaseBasis']).toBe('credit_covered');

    const held = await finance.post(`/api/v1/finance/credit/${customerOrgId}/holds`, { reason: 'Cheque returned unpaid' });
    expect(held.status).toBe(201);
    const [blocked] = await seedOffer(['standard']);
    const second = await postWithKey(approver, `/api/v1/quotations/${blocked!.quoteId}/accept`, acceptBody(blocked!), `accept-${randomUUID()}`);
    expect(second.body['status']).toBe('payment_needed');
    const blockedOrder = await finance.get(`/api/v1/sales-orders/${second.body['orderId']}`);
    expect(blockedOrder.body['gate']).toMatchObject({ pass: false, activeHolds: 1 });
    const refused = await finance.post(`/api/v1/sales-orders/${second.body['orderId']}/release-commercial`, { expectedVersion: blockedOrder.body['aggregateVersion'] });
    expect(refused.status).toBe(409);
    expect(refused.body['code']).toBe('COMMERCIAL_GATE_FAILED');
    expect(String(refused.body['detail'])).toMatch(/Cheque returned unpaid/);

    const holdId = ((held.body['credit'] as Record<string, unknown>)['activeHolds'] as Array<Record<string, unknown>>)[0]!['holdId'];
    const released = await finance.post(`/api/v1/finance/credit/${customerOrgId}/holds/${holdId}/release`, { reason: 'Replacement payment cleared' });
    expect(released.status).toBe(201);
    const ok = await finance.post(`/api/v1/sales-orders/${second.body['orderId']}/release-commercial`, { expectedVersion: blockedOrder.body['aggregateVersion'] });
    expect(ok.status).toBe(201);
    expect(ok.body['status']).toBe('pending_technical_release');
  });

  it('counts orders and unpaid invoices on the customer home and suspense on the finance board', async () => {
    const summary = await approver.get('/api/v1/portal/summary');
    const queues = new Map((summary.body['queues'] as Array<Record<string, unknown>>).map((q) => [q['key'], q['count']]));
    expect(queues.get('orders_in_progress')).toBeGreaterThanOrEqual(4);
    expect(queues.get('invoices_unpaid')).toBeGreaterThanOrEqual(1);
    const board = await finance.get('/api/v1/operations/summary');
    const keys = (board.body['queues'] as Array<Record<string, unknown>>).map((q) => q['key']);
    expect(keys).toContain('payments_unmatched');
    expect(keys).toContain('orders_awaiting_release');
    const orders = await approver.get('/api/v1/orders');
    expect((orders.body['orders'] as unknown[]).length).toBeGreaterThanOrEqual(4);
    expect([...keysOf(orders.body)].filter((k) => BUY_SIDE.test(k))).toEqual([]);
  });
});
