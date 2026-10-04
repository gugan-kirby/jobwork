import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { Client } from 'pg';
import { hashPassword } from '../../src/modules/iam/domain/password';
import { TestClient } from './http';

export const WORLD_PASSWORD = 'world-password-123';
export const WORLD_WEBHOOK_SECRET = 'test-payment-webhook-secret';

type Body = Record<string, unknown>;

export type ActorKey = 'customerA' | 'customerB' | 'supplier1' | 'supplier2' | 'sourcing' | 'sales' | 'finance' | 'quality' | 'admin';

export interface World {
  clients: Record<ActorKey, TestClient> & { anonymous: TestClient };
  orgs: { internal: string; customerA: string; customerB: string; supplier1: string; supplier2: string };
  users: { customerA: string };
  memberships: { customerA: string };
  supplierProfiles: { supplier1: string; supplier2: string };
  enquiryId: string;
  enquiryReference: string;
  drawingVersionId: string;
  rfqId: string;
  awardId: string;
  costSheetId: string;
  quoteId: string;
  orderId: string;
  invoiceId: string;
  intentId: string;
  purchaseOrderId: string;
}

/**
 * One deal end to end, for suites that need every kind of record to exist at once (the
 * cross-tenant matrix, IN-12's pilot scenarios). Customer A's enquiry is sourced from
 * supplier 1 only; customer B and supplier 2 are bystanders with real accounts and their
 * own organizations — exactly the parties a leak would reach.
 *
 * The deep commercial chain (requirement, RFQ, bid, award, cost sheet, quote) is seeded as
 * rows, as the IN-09 suite does; the transitions that carry the money and the contract —
 * acceptance, a verified payment callback, purchase orders, the supplier's acknowledgment
 * — run through the real API.
 */
export async function buildWorld(pg: Client, baseUrl: string): Promise<World> {
  const one = async <T = Body>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;
  const org = async (type: string, name: string): Promise<string> =>
    (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ($1, $2, $2) RETURNING id`, [type, name])).id;
  const user = async (orgId: string, email: string, roles: string[]): Promise<{ userId: string; membershipId: string }> => {
    const u = await one<{ id: string }>(
      `INSERT INTO iam.user_account (email, password_hash, password_params_version, display_name, status, email_verified_at) VALUES ($1, $2, 1, $3, 'active', now()) RETURNING id`,
      [email, await hashPassword(WORLD_PASSWORD), email.split('@')[0]],
    );
    const m = await one<{ id: string }>(`INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`, [u.id, orgId]);
    await pg.query(`INSERT INTO iam.membership_role (membership_id, role_id) SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`, [m.id, roles]);
    return { userId: u.id, membershipId: m.id };
  };
  const totp = (secret: string, email: string): string =>
    new OTPAuth.TOTP({ issuer: 'JobWork', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const signIn = async (email: string, mfa: boolean): Promise<TestClient> => {
    const first = new TestClient(baseUrl);
    const res = await first.post('/api/v1/auth/login', { email, password: WORLD_PASSWORD });
    if (res.status !== 201) throw new Error(`sign-in failed for ${email}: ${res.status}`);
    if (!mfa) return first;
    const enroll = await first.post('/api/v1/account/mfa/enroll');
    await first.post('/api/v1/account/mfa/activate', { code: totp(enroll.body['secret'] as string, email) });
    const fresh = new TestClient(baseUrl);
    await fresh.post('/api/v1/auth/login', { email, password: WORLD_PASSWORD });
    const secret = await one<{ mfa_totp_secret: string }>(`SELECT mfa_totp_secret FROM iam.user_account WHERE email = $1`, [email]);
    await fresh.post('/api/v1/auth/mfa', { code: totp(secret.mfa_totp_secret, email) });
    return fresh;
  };

  const orgs = {
    internal: await org('internal', 'JobWork Operations'),
    customerA: await org('customer', 'Kovai Pumps'),
    customerB: await org('customer', 'Madurai Motors'),
    supplier1: await org('supplier', 'Anand Engineering'),
    supplier2: await org('supplier', 'Balaji Precision'),
  };
  const profile = async (orgId: string): Promise<string> =>
    (await one<{ id: string }>(
      `INSERT INTO supplier.supplier_profile (organization_id, region_class, status, decided_by, decided_at, submitted_by, trade_name, primary_contact_name, primary_contact_email, primary_contact_phone, summary)
       VALUES ($1, 'chennai_metro', 'active', gen_random_uuid(), now(), gen_random_uuid(), 'Works', 'Contact', 'c@example.test', '+91 90000 00000', 'Machining') RETURNING id`,
      [orgId],
    )).id;
  const supplierProfiles = { supplier1: await profile(orgs.supplier1), supplier2: await profile(orgs.supplier2) };

  const a = await user(orgs.customerA, 'approver@kovai.test', ['customer_requester', 'customer_approver']);
  await user(orgs.customerB, 'approver@madurai.test', ['customer_requester', 'customer_approver']);
  await user(orgs.supplier1, 'works@anand.test', ['org_admin', 'supplier_estimator', 'supplier_production']);
  await user(orgs.supplier2, 'works@balaji.test', ['org_admin', 'supplier_estimator', 'supplier_production']);
  await user(orgs.internal, 'sourcing@jobwork.test', ['jobwork_sourcing']);
  await user(orgs.internal, 'sales@jobwork.test', ['jobwork_sales']);
  await user(orgs.internal, 'finance@jobwork.test', ['jobwork_finance']);
  await user(orgs.internal, 'quality@jobwork.test', ['jobwork_quality']);
  await user(orgs.internal, 'admin@jobwork.test', ['platform_admin']);

  // Customer A's enquiry with its governing drawing.
  const enquiry = await one<{ id: string }>(
    `INSERT INTO sourcing.enquiry (customer_organization_id, title, status, reference, submitted_at, submitted_by) VALUES ($1, 'Pump bracket', 'approved_for_sourcing', 'ENQ-2026-7001', now(), $2) RETURNING id`,
    [orgs.customerA, a.userId],
  );
  const file = await one<{ id: string }>(
    `INSERT INTO dms.file_object (storage_key, byte_size, declared_media_type, sha256, scan_state, owning_organization_id) VALUES ($1, 2048, 'application/pdf', $2, 'clean', $3) RETURNING id`,
    [`clean/${randomBytes(8).toString('hex')}`, randomBytes(32).toString('hex'), orgs.customerA],
  );
  const doc = await one<{ id: string }>(`INSERT INTO dms.document (owning_organization_id, logical_type, title, current_version_no) VALUES ($1, 'drawing_2d', 'Bracket drawing rev C', 1) RETURNING id`, [orgs.customerA]);
  const drawing = await one<{ id: string }>(
    `INSERT INTO dms.document_version (document_id, version_no, file_object_id, original_filename, status) VALUES ($1, 1, $2, 'bracket-rev-c.pdf', 'available') RETURNING id`,
    [doc.id, file.id],
  );
  await pg.query(`INSERT INTO sourcing.enquiry_document (enquiry_id, document_version_id, role) VALUES ($1, $2, 'governing')`, [enquiry.id, drawing.id]);

  // Sourced from supplier 1 alone.
  const req = await one<{ id: string }>(`INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash) VALUES ($1, 1, 'reviewed', '{}'::jsonb, 'r') RETURNING id`, [enquiry.id]);
  const rfq = await one<{ id: string }>(
    `INSERT INTO sourcing.rfq (enquiry_id, requirement_id, round_no, reference, status, currency, deadline_at, released_at) VALUES ($1, $2, 1, 'RFQ-2026-7001-R1', 'awarded', 'INR', now(), now()) RETURNING id`,
    [enquiry.id, req.id],
  );
  const item = await one<{ id: string }>(`INSERT INTO sourcing.rfq_item (rfq_id, line_no, part_name, quantity_breakpoints) VALUES ($1, 1, 'Pump bracket', '[{"quantity":100,"unit":"piece","kind":"production"}]'::jsonb) RETURNING id`, [rfq.id]);
  const award = await one<{ id: string }>(`INSERT INTO commercial.award (rfq_id, status, proposed_by, currency, buy_total_minor) VALUES ($1, 'approved', gen_random_uuid(), 'INR', 900000) RETURNING id`, [rfq.id]);
  const invitation = await one<{ id: string }>(
    `INSERT INTO sourcing.rfq_supplier (rfq_id, supplier_profile_id, supplier_organization_id, status) VALUES ($1, $2, $3, 'responded') RETURNING id`,
    [rfq.id, supplierProfiles.supplier1, orgs.supplier1],
  );
  const bid = await one<{ id: string }>(`INSERT INTO sourcing.supplier_bid (rfq_id, rfq_supplier_id, supplier_organization_id, current_version_no) VALUES ($1, $2, $3, 1) RETURNING id`, [rfq.id, invitation.id, orgs.supplier1]);
  const bidVersion = await one<{ id: string }>(
    `INSERT INTO sourcing.supplier_bid_version (supplier_bid_id, version_no, currency, lines_total_minor, total_amount_minor, lead_time_days, validity_until, content_hash, status) VALUES ($1, 1, 'INR', 900000, 900000, 18, current_date + 30, $2, 'selected') RETURNING id`,
    [bid.id, randomBytes(32).toString('hex')],
  );
  await pg.query(
    `INSERT INTO commercial.award_line (award_id, rfq_item_id, bid_version_id, supplier_organization_id, bid_quantity, quantity, unit, unit_price_minor, line_total_minor) VALUES ($1, $2, $3, $4, 100, 100, 'piece', 9000, 900000)`,
    [award.id, item.id, bidVersion.id, orgs.supplier1],
  );
  const sheet = await one<{ id: string }>(
    `INSERT INTO commercial.cost_sheet (rfq_id, award_id, enquiry_id, customer_organization_id, status, current_version_no, created_by) VALUES ($1, $2, $3, $4, 'approved', 1, gen_random_uuid()) RETURNING id`,
    [rfq.id, award.id, enquiry.id, orgs.customerA],
  );
  const sheetVersion = await one<{ id: string }>(
    `INSERT INTO commercial.cost_sheet_version (cost_sheet_id, version_no, currency, buy_total_minor, components, landed_total_minor, margin_minor, margin_bp, sell_total_minor, sell_lines, content_hash, status, created_by) VALUES ($1, 1, 'INR', 900000, '[]', 950000, 250000, 2083, 1200000, '[]', 'cs', 'approved', gen_random_uuid()) RETURNING id`,
    [sheet.id],
  );
  const terms = await one<{ id: string; content_hash: string }>(`SELECT id, content_hash FROM commercial.terms_version ORDER BY version_no DESC LIMIT 1`);
  const offerSet = await one<{ id: string }>(`INSERT INTO commercial.quote_offer_set (enquiry_id, customer_organization_id, created_by) VALUES ($1, $2, gen_random_uuid()) RETURNING id`, [enquiry.id, orgs.customerA]);
  const quote = await one<{ id: string }>(
    `INSERT INTO commercial.customer_quote (offer_set_id, enquiry_id, customer_organization_id, option_label, reference, cost_sheet_version_id, status, current_version_no, created_by) VALUES ($1, $2, $3, 'standard', 'QUO-2026-7001', $4, 'sent', 1, gen_random_uuid()) RETURNING id`,
    [offerSet.id, enquiry.id, orgs.customerA, sheetVersion.id],
  );
  const contentHash = randomBytes(32).toString('hex');
  const quoteVersion = await one<{ id: string }>(
    `INSERT INTO commercial.quote_version (customer_quote_id, version_no, currency, subtotal_minor, tax_rate_bp, tax_minor, total_minor, delivery_lead_days, validity_until, terms_version_id, content_hash, status, sent_at, created_by)
     VALUES ($1, 1, 'INR', 1200000, 1800, 216000, 1416000, 21, current_date + 14, $2, $3, 'sent', now(), gen_random_uuid()) RETURNING id`,
    [quote.id, terms.id, contentHash],
  );
  await pg.query(`INSERT INTO commercial.quote_line (quote_version_id, line_no, description, quantity, unit, unit_price_minor, amount_minor) VALUES ($1, 1, 'Pump bracket', 100, 'piece', 12000, 1200000)`, [quoteVersion.id]);

  const clients = {
    anonymous: new TestClient(baseUrl),
    customerA: await signIn('approver@kovai.test', false),
    customerB: await signIn('approver@madurai.test', false),
    supplier1: await signIn('works@anand.test', false),
    supplier2: await signIn('works@balaji.test', false),
    sourcing: await signIn('sourcing@jobwork.test', true),
    sales: await signIn('sales@jobwork.test', true),
    finance: await signIn('finance@jobwork.test', true),
    quality: await signIn('quality@jobwork.test', true),
    admin: await signIn('admin@jobwork.test', true),
  };

  // The contract: acceptance, the advance paid through a verified callback, a purchase order acknowledged.
  const accepted = await clients.customerA.post(`/api/v1/quotations/${quote.id}/accept`, { expectedVersion: 1, quoteVersionNo: 1, contentHash, termsHash: terms.content_hash, acknowledgeTerms: true });
  if (accepted.status !== 201) throw new Error(`acceptance failed: ${JSON.stringify(accepted.body)}`);
  const orderId = accepted.body['orderId'] as string;
  const invoiceId = (accepted.body['invoices'] as Body[])[0]!['invoiceId'] as string;
  const intent = await clients.customerA.post(`/api/v1/invoices/${invoiceId}/pay`);
  const intentId = intent.body['paymentIntentId'] as string;
  const pi = await one<{ provider_intent_id: string; amount_minor: string }>(`SELECT provider_intent_id, amount_minor FROM finance.payment_intent WHERE id = $1`, [intentId]);
  const body = JSON.stringify({
    id: `evt_${randomUUID()}`,
    type: 'payment.captured',
    data: { intentId: pi.provider_intent_id, transactionId: `txn_${randomUUID()}`, amountMinor: Number(pi.amount_minor), currency: 'INR', occurredAt: new Date().toISOString() },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const hook = await fetch(`${baseUrl}/api/v1/webhooks/payments/dev`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dev-signature': createHmac('sha256', WORLD_WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex'),
      'x-dev-timestamp': ts,
      'x-dev-delivery-id': JSON.parse(body).id as string,
    },
    body,
  });
  if (hook.status !== 200) throw new Error(`payment callback refused: ${hook.status}`);
  const so = await clients.sourcing.get(`/api/v1/sales-orders/${orderId}`);
  const issued = await clients.sourcing.post(`/api/v1/sales-orders/${orderId}/purchase-orders`, { expectedVersion: so.body['aggregateVersion'] });
  const purchaseOrderId = (issued.body['purchaseOrders'] as Body[])[0]!['purchaseOrderId'] as string;
  const po = await clients.supplier1.get(`/api/v1/supplier/purchase-orders/${purchaseOrderId}`);
  await clients.supplier1.post(`/api/v1/supplier/purchase-orders/${purchaseOrderId}/acknowledge`, { expectedVersion: po.body['aggregateVersion'], note: '' });

  // A conversation on each side of the deal.
  await clients.customerA.post(`/api/v1/conversations/enquiry/${enquiry.id}/messages`, { audience: 'customer', body: 'Please confirm the anodising colour.' });
  await clients.supplier1.post(`/api/v1/conversations/purchase_order/${purchaseOrderId}/messages`, { audience: 'supplier', body: 'Material arrives on Monday.' });

  return {
    clients,
    orgs,
    users: { customerA: a.userId },
    memberships: { customerA: a.membershipId },
    supplierProfiles,
    enquiryId: enquiry.id,
    enquiryReference: 'ENQ-2026-7001',
    drawingVersionId: drawing.id,
    rfqId: rfq.id,
    awardId: award.id,
    costSheetId: sheet.id,
    quoteId: quote.id,
    orderId,
    invoiceId,
    intentId,
    purchaseOrderId,
  };
}
