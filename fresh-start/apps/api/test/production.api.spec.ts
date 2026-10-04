import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { baselineHash } from '../src/modules/orders/domain/production';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'production-password-1';
const WEBHOOK_SECRET = 'test-payment-webhook-secret';
type Body = Record<string, unknown>;

/**
 * IN-09 end to end (doc 24 IN-09 exit, doc 19 §5): accepted and paid order → POs →
 * baseline (conflict blocked, hash reproducible, frozen) → transmittals with exact-version
 * grants → an early start recorded as containment → release refused until every gate is
 * green → milestones with evidence, reuse flag, rejection, backdate rules, verifier
 * separation → delay keeps the plan → completion → the customer sees only curated progress.
 */
describe('Baseline, production release, milestones (IN-09)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let customer: TestClient;
  let engineering: TestClient;
  let sourcing: TestClient;
  let quality: TestClient;
  let supplierA: TestClient;
  let supplierB: TestClient;

  let customerOrgId: string;
  let supplierOrgA: string;
  let supplierOrgB: string;
  let orderId: string;
  let poA: string;
  let poB: string;
  let drawingV: string;
  let oldDrawingV: string;
  let specV: string;
  let photoV: string;
  let baselineId: string;
  let wpA: string;

  function totp(secret: string, email: string): string {
    return new OTPAuth.TOTP({ issuer: 'JobWork', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  }
  const one = async <T = Body>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;

  async function seedOrg(type: string, name: string): Promise<string> {
    return (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ($1, $2, $2) RETURNING id`, [type, name])).id;
  }

  async function seedUser(orgId: string, email: string, roles: string[]): Promise<void> {
    const user = await one<{ id: string }>(
      `INSERT INTO iam.user_account (email, password_hash, password_params_version, display_name, status, email_verified_at) VALUES ($1, $2, 1, $3, 'active', now()) RETURNING id`,
      [email, await hashPassword(PASSWORD), email.split('@')[0]],
    );
    const m = await one<{ id: string }>(`INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`, [user.id, orgId]);
    await pg.query(`INSERT INTO iam.membership_role (membership_id, role_id) SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`, [m.id, roles]);
  }

  async function signIn(email: string, mfa = false): Promise<TestClient> {
    const first = new TestClient(baseUrl);
    expect((await first.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(201);
    if (!mfa) return first;
    const enroll = await first.post('/api/v1/account/mfa/enroll');
    await first.post('/api/v1/account/mfa/activate', { code: totp(enroll.body['secret'] as string, email) });
    const fresh = new TestClient(baseUrl);
    await fresh.post('/api/v1/auth/login', { email, password: PASSWORD });
    const secret = await one<{ mfa_totp_secret: string }>(`SELECT mfa_totp_secret FROM iam.user_account WHERE email = $1`, [email]);
    await fresh.post('/api/v1/auth/mfa', { code: totp(secret.mfa_totp_secret, email) });
    return fresh;
  }

  async function seedVersion(orgId: string, type: string, title: string, opts: { scan?: string; fileId?: string } = {}): Promise<{ versionId: string; fileId: string; sha: string }> {
    let fileId = opts.fileId;
    let sha = '';
    if (!fileId) {
      sha = randomBytes(32).toString('hex');
      fileId = (await one<{ id: string }>(
        `INSERT INTO dms.file_object (storage_key, byte_size, declared_media_type, sha256, scan_state, owning_organization_id) VALUES ($1, 2048, 'application/pdf', $2, $3, $4) RETURNING id`,
        [`clean/${randomBytes(8).toString('hex')}`, sha, opts.scan ?? 'clean', orgId],
      )).id;
    } else {
      sha = (await one<{ sha256: string }>(`SELECT sha256 FROM dms.file_object WHERE id = $1`, [fileId])).sha256;
    }
    const doc = await one<{ id: string }>(`INSERT INTO dms.document (owning_organization_id, logical_type, title, current_version_no) VALUES ($1, $2, $3, 1) RETURNING id`, [orgId, type, title]);
    const v = await one<{ id: string }>(
      `INSERT INTO dms.document_version (document_id, version_no, file_object_id, original_filename, status) VALUES ($1, 1, $2, $3, 'available') RETURNING id`,
      [doc.id, fileId, `${title.toLowerCase().replace(/ /g, '-')}.pdf`],
    );
    return { versionId: v.id, fileId, sha };
  }

  function signedWebhook(providerIntentId: string, amountMinor: number) {
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'payment.captured', data: { intentId: providerIntentId, transactionId: `txn_${randomUUID()}`, amountMinor, currency: 'INR', occurredAt: new Date().toISOString() } });
    const ts = String(Math.floor(Date.now() / 1000));
    return { body, headers: { 'content-type': 'application/json', 'x-dev-signature': createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex'), 'x-dev-timestamp': ts, 'x-dev-delivery-id': JSON.parse(body).id as string } };
  }

  async function production(): Promise<{ baselines: Body[]; workPackages: Body[] }> {
    const res = await engineering.get(`/api/v1/sales-orders/${orderId}/production`);
    expect(res.status).toBe(200);
    return res.body as unknown as { baselines: Body[]; workPackages: Body[] };
  }

  async function wp(workPackageId: string): Promise<Body> {
    return (await production()).workPackages.find((w) => w['workPackageId'] === workPackageId)!;
  }

  function milestones(w: Body): Body[] {
    return w['milestones'] as Body[];
  }

  async function supplierView(client: TestClient, poId: string): Promise<Body> {
    const res = await client.get(`/api/v1/supplier/purchase-orders/${poId}/production`);
    return res.body;
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_production');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['PAYMENT_WEBHOOK_SECRET'] = WEBHOOK_SECRET;
    process.env['NODE_ENV'] = 'test';
    pg = new Client({ connectionString: db.url });
    await pg.connect();

    customerOrgId = await seedOrg('customer', 'Kovai Pumps');
    const internal = await seedOrg('internal', 'JobWork Operations');
    supplierOrgA = await seedOrg('supplier', 'Anand Engineering');
    supplierOrgB = await seedOrg('supplier', 'Balaji Precision');
    for (const orgId of [supplierOrgA, supplierOrgB]) {
      await pg.query(
        `INSERT INTO supplier.supplier_profile (organization_id, region_class, status, decided_by, decided_at, submitted_by, trade_name, primary_contact_name, primary_contact_email, primary_contact_phone, summary)
         VALUES ($1, 'chennai_metro', 'active', gen_random_uuid(), now(), gen_random_uuid(), 'Works', 'Contact', 'c@example.test', '+91 90000 00000', 'Machining')`,
        [orgId],
      );
    }
    await seedUser(customerOrgId, 'approver@kovai.test', ['customer_approver']);
    await seedUser(internal, 'engineering@jobwork.test', ['jobwork_engineering']);
    await seedUser(internal, 'sourcing@jobwork.test', ['jobwork_sourcing']);
    await seedUser(internal, 'quality@jobwork.test', ['jobwork_quality']);
    await seedUser(supplierOrgA, 'production@anand.test', ['org_admin', 'supplier_production']);
    await seedUser(supplierOrgB, 'production@balaji.test', ['org_admin', 'supplier_production']);

    // The IN-07 chain as fixture: enquiry with documents, a 60/40 approved award, an approved cost sheet, a sent quote.
    const enquiry = await one<{ id: string }>(`INSERT INTO sourcing.enquiry (customer_organization_id, title, status, reference, submitted_at, submitted_by) VALUES ($1, 'Pump bracket', 'approved_for_sourcing', 'ENQ-2026-6001', now(), gen_random_uuid()) RETURNING id`, [customerOrgId]);
    drawingV = (await seedVersion(customerOrgId, 'drawing_2d', 'Bracket drawing rev C')).versionId;
    oldDrawingV = (await seedVersion(customerOrgId, 'drawing_2d', 'Bracket drawing rev B')).versionId;
    specV = (await seedVersion(customerOrgId, 'specification', 'Anodising spec')).versionId;
    photoV = (await seedVersion(customerOrgId, 'image', 'Old part photo')).versionId;
    await pg.query(`INSERT INTO sourcing.enquiry_document (enquiry_id, document_version_id, role) VALUES ($1, $2, 'governing'), ($1, $3, 'reference'), ($1, $4, 'reference'), ($1, $5, 'assisted_photo')`, [enquiry.id, drawingV, oldDrawingV, specV, photoV]);
    const req = await one<{ id: string }>(`INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash) VALUES ($1, 1, 'reviewed', '{}'::jsonb, 'r') RETURNING id`, [enquiry.id]);
    const rfq = await one<{ id: string }>(`INSERT INTO sourcing.rfq (enquiry_id, requirement_id, round_no, reference, status, currency, deadline_at, released_at) VALUES ($1, $2, 1, 'RFQ-2026-6001-R1', 'awarded', 'INR', now(), now()) RETURNING id`, [enquiry.id, req.id]);
    const item = await one<{ id: string }>(`INSERT INTO sourcing.rfq_item (rfq_id, line_no, part_name, quantity_breakpoints) VALUES ($1, 1, 'Pump bracket', '[{"quantity":100,"unit":"piece","kind":"production"}]'::jsonb) RETURNING id`, [rfq.id]);
    const award = await one<{ id: string }>(`INSERT INTO commercial.award (rfq_id, status, proposed_by, currency, buy_total_minor) VALUES ($1, 'approved', gen_random_uuid(), 'INR', 900000) RETURNING id`, [rfq.id]);
    for (const [orgId, qty] of [[supplierOrgA, 60], [supplierOrgB, 40]] as const) {
      const profile = await one<{ id: string }>(`SELECT id FROM supplier.supplier_profile WHERE organization_id = $1`, [orgId]);
      const inv = await one<{ id: string }>(`INSERT INTO sourcing.rfq_supplier (rfq_id, supplier_profile_id, supplier_organization_id, status) VALUES ($1, $2, $3, 'responded') RETURNING id`, [rfq.id, profile.id, orgId]);
      const bid = await one<{ id: string }>(`INSERT INTO sourcing.supplier_bid (rfq_id, rfq_supplier_id, supplier_organization_id, current_version_no) VALUES ($1, $2, $3, 1) RETURNING id`, [rfq.id, inv.id, orgId]);
      const v = await one<{ id: string }>(`INSERT INTO sourcing.supplier_bid_version (supplier_bid_id, version_no, currency, lines_total_minor, total_amount_minor, lead_time_days, validity_until, content_hash, status) VALUES ($1, 1, 'INR', 900000, 900000, 18, current_date + 30, $2, 'selected') RETURNING id`, [bid.id, randomBytes(32).toString('hex')]);
      await pg.query(`INSERT INTO commercial.award_line (award_id, rfq_item_id, bid_version_id, supplier_organization_id, bid_quantity, quantity, unit, unit_price_minor, line_total_minor) VALUES ($1, $2, $3, $4, 100, $5, 'piece', 9000, $6)`, [award.id, item.id, v.id, orgId, qty, qty * 9000]);
    }
    const sheet = await one<{ id: string }>(`INSERT INTO commercial.cost_sheet (rfq_id, award_id, enquiry_id, customer_organization_id, status, current_version_no, created_by) VALUES ($1, $2, $3, $4, 'approved', 1, gen_random_uuid()) RETURNING id`, [rfq.id, award.id, enquiry.id, customerOrgId]);
    const csv = await one<{ id: string }>(`INSERT INTO commercial.cost_sheet_version (cost_sheet_id, version_no, currency, buy_total_minor, components, landed_total_minor, margin_minor, margin_bp, sell_total_minor, sell_lines, content_hash, status, created_by) VALUES ($1, 1, 'INR', 900000, '[]', 950000, 250000, 2083, 1200000, '[]', 'cs', 'approved', gen_random_uuid()) RETURNING id`, [sheet.id]);
    const terms = await one<{ id: string; content_hash: string }>(`SELECT id, content_hash FROM commercial.terms_version ORDER BY version_no DESC LIMIT 1`);
    const set = await one<{ id: string }>(`INSERT INTO commercial.quote_offer_set (enquiry_id, customer_organization_id, created_by) VALUES ($1, $2, gen_random_uuid()) RETURNING id`, [enquiry.id, customerOrgId]);
    const quote = await one<{ id: string }>(`INSERT INTO commercial.customer_quote (offer_set_id, enquiry_id, customer_organization_id, option_label, reference, cost_sheet_version_id, status, current_version_no, created_by) VALUES ($1, $2, $3, 'standard', 'QUO-2026-6001', $4, 'sent', 1, gen_random_uuid()) RETURNING id`, [set.id, enquiry.id, customerOrgId, csv.id]);
    const contentHash = randomBytes(32).toString('hex');
    const qv = await one<{ id: string }>(
      `INSERT INTO commercial.quote_version (customer_quote_id, version_no, currency, subtotal_minor, tax_rate_bp, tax_minor, total_minor, delivery_lead_days, validity_until, terms_version_id, content_hash, status, sent_at, created_by)
       VALUES ($1, 1, 'INR', 1200000, 1800, 216000, 1416000, 21, current_date + 14, $2, $3, 'sent', now(), gen_random_uuid()) RETURNING id`,
      [quote.id, terms.id, contentHash],
    );
    await pg.query(`INSERT INTO commercial.quote_line (quote_version_id, line_no, description, quantity, unit, unit_price_minor, amount_minor) VALUES ($1, 1, 'Pump bracket', 100, 'piece', 12000, 1200000)`, [qv.id]);

    ({ app, baseUrl } = await createTestApp());
    customer = await signIn('approver@kovai.test');
    engineering = await signIn('engineering@jobwork.test', true);
    sourcing = await signIn('sourcing@jobwork.test', true);
    quality = await signIn('quality@jobwork.test', true);
    supplierA = await signIn('production@anand.test');
    supplierB = await signIn('production@balaji.test');

    // Accept, pay the advance through a verified callback, issue POs, supplier A acknowledges its PO.
    const accepted = await customer.post(`/api/v1/quotations/${quote.id}/accept`, { expectedVersion: 1, quoteVersionNo: 1, contentHash, termsHash: terms.content_hash, acknowledgeTerms: true });
    expect(accepted.status).toBe(201);
    orderId = accepted.body['orderId'] as string;
    const invoiceId = (accepted.body['invoices'] as Body[])[0]!['invoiceId'] as string;
    const intent = await customer.post(`/api/v1/invoices/${invoiceId}/pay`);
    const pi = await one<{ provider_intent_id: string }>(`SELECT provider_intent_id FROM finance.payment_intent WHERE id = $1`, [intent.body['paymentIntentId']]);
    const hook = signedWebhook(pi.provider_intent_id, 708000);
    expect((await fetch(`${baseUrl}/api/v1/webhooks/payments/dev`, { method: 'POST', headers: hook.headers, body: hook.body })).status).toBe(200);
    const so = await sourcing.get(`/api/v1/sales-orders/${orderId}`);
    expect(so.body['status']).toBe('pending_technical_release');
    const issued = await sourcing.post(`/api/v1/sales-orders/${orderId}/purchase-orders`, { expectedVersion: so.body['aggregateVersion'] });
    const pos = issued.body['purchaseOrders'] as Body[];
    poA = pos.find((p) => p['supplierOrganizationId'] === supplierOrgA)!['purchaseOrderId'] as string;
    poB = pos.find((p) => p['supplierOrganizationId'] === supplierOrgB)!['purchaseOrderId'] as string;
    const mine = await supplierA.get(`/api/v1/supplier/purchase-orders/${poA}`);
    expect((await supplierA.post(`/api/v1/supplier/purchase-orders/${poA}/acknowledge`, { expectedVersion: mine.body['aggregateVersion'], note: '' })).status).toBe(201);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  // ---------------------------------------------------------------- F-09.2 baseline

  it('offers only clean manufacturing documents, blocks conflicting governing drawings, and freezes a reproducible hash', async () => {
    const candidates = (await engineering.get(`/api/v1/sales-orders/${orderId}/baseline-candidates`)).body['candidates'] as Body[];
    expect(candidates.find((c) => c['documentVersionId'] === photoV)).toMatchObject({ selectable: false });
    expect(candidates.find((c) => c['documentVersionId'] === drawingV)).toMatchObject({ selectable: true, source: 'governing' });
    // A customer cannot read the internal production surface.
    expect((await customer.get(`/api/v1/sales-orders/${orderId}/baseline-candidates`)).status).toBe(403);
    // A photo is refused outright.
    expect((await engineering.post(`/api/v1/sales-orders/${orderId}/baselines`, { items: [{ documentVersionId: photoV, purpose: 'reference' }] })).status).toBe(422);

    // Two governing drawings at one priority: assembled, but release is blocked (BR-ENG-06).
    const clash = await engineering.post(`/api/v1/sales-orders/${orderId}/baselines`, {
      items: [
        { documentVersionId: drawingV, purpose: 'governing' },
        { documentVersionId: oldDrawingV, purpose: 'governing' },
        { documentVersionId: specV, purpose: 'reference' },
      ],
    });
    expect(clash.status).toBe(201);
    const draft = (clash.body['baselines'] as Body[])[0]!;
    expect((draft['conflicts'] as string[]).length).toBe(1);
    baselineId = draft['baselineId'] as string;
    const blocked = await engineering.post(`/api/v1/baselines/${baselineId}/release`, { expectedVersion: draft['aggregateVersion'] });
    expect(blocked.status).toBe(409);
    expect(blocked.body['code']).toBe('BASELINE_CONFLICT');

    // Resolve by making the old revision a reference; the same draft is replaced, not a new one.
    const fixed = await engineering.post(`/api/v1/sales-orders/${orderId}/baselines`, {
      items: [
        { documentVersionId: drawingV, purpose: 'governing' },
        { documentVersionId: oldDrawingV, purpose: 'reference' },
        { documentVersionId: specV, purpose: 'reference' },
      ],
    });
    const fixedDraft = (fixed.body['baselines'] as Body[])[0]!;
    expect(fixedDraft['baselineId']).toBe(baselineId);
    expect(fixedDraft['conflicts']).toEqual([]);
    const released = await engineering.post(`/api/v1/baselines/${baselineId}/release`, { expectedVersion: fixedDraft['aggregateVersion'] });
    expect(released.status).toBe(201);
    const baseline = (released.body['baselines'] as Body[]).find((b) => b['baselineId'] === baselineId)!;
    expect(baseline['status']).toBe('released');
    // The hash is doc 07 §13 over exactly these versions and bytes — recomputable by anyone.
    const items = baseline['items'] as Array<{ documentId: string; documentVersionId: string; fileSha256: string; purpose: 'governing' | 'reference'; governingPriority: number }>;
    expect(baseline['manifestHash']).toBe(baselineHash(items));
    // Released means frozen: a second release is refused and the items cannot be touched.
    expect((await engineering.post(`/api/v1/baselines/${baselineId}/release`, { expectedVersion: baseline['aggregateVersion'] })).status).toBe(409);
    await expect(pg.query(`DELETE FROM dms.baseline_item WHERE baseline_id = $1`, [baselineId])).rejects.toThrow(/frozen/);
    // IN-13 F-13.1: a successor is assembled freely but never released outside a change.
    const successor = await engineering.post(`/api/v1/sales-orders/${orderId}/baselines`, { items: items.map((i) => ({ documentVersionId: i.documentVersionId, purpose: i.purpose })) });
    expect(successor.status).toBe(201);
    const draftSuccessor = (successor.body['baselines'] as Body[]).find((b) => b['status'] === 'draft')!;
    const silent = await engineering.post(`/api/v1/baselines/${draftSuccessor['baselineId']}/release`, { expectedVersion: draftSuccessor['aggregateVersion'] });
    expect(silent.status).toBe(409);
    expect(silent.body['code']).toBe('BASELINE_CHANGE_REQUIRED');
    expect((await one<{ status: string }>(`SELECT status FROM dms.baseline WHERE id = $1`, [baselineId])).status).toBe('released');
    await expect(pg.query(`UPDATE dms.baseline SET supersedes_baseline_id = $1 WHERE id = $2`, [baselineId, draftSuccessor['baselineId']])).rejects.toThrow(/chk_baseline_supersedes_by_change/);
  });

  // ---------------------------------------------------------------- F-09.3 release gate

  it('records an early start as containment and keeps release red until every gate is green', async () => {
    const planned = await sourcing.post(`/api/v1/purchase-orders/${poA}/work-package`, { plannedStart: '2026-10-06', plannedFinish: '2026-10-26' });
    expect(planned.status).toBe(201);
    const pkg = planned.body['workPackages'] as Body[];
    wpA = pkg.find((w) => w['purchaseOrderId'] === poA)!['workPackageId'] as string;
    let w = await wp(wpA);
    expect(milestones(w)).toHaveLength(5);
    const technical = (w['gates'] as Body[]).find((g) => g['key'] === 'technical')!;
    expect(technical['pass']).toBe(false);
    expect((technical['reasons'] as string[]).join(' ')).toMatch(/not been transmitted/);

    // Release with red gates is refused, with the reasons.
    const red = await sourcing.post(`/api/v1/work-packages/${wpA}/release`, { expectedVersion: w['aggregateVersion'] });
    expect(red.status).toBe(409);
    expect(red.body['code']).toBe('RELEASE_GATE_RED');

    // The supplier tries to start anyway: refused, and the attempt is on record.
    const first = milestones(w)[0]!;
    const early = await supplierA.post(`/api/v1/supplier/milestones/${first['milestoneId']}/start`, { expectedVersion: first['aggregateVersion'] });
    expect(early.status).toBe(409);
    expect(early.body['code']).toBe('WORK_PACKAGE_NOT_RELEASED');
    w = await wp(wpA);
    expect((w['containment'] as Body[])[0]).toMatchObject({ kind: 'unauthorized_start' });
    expect(milestones(w)[0]!['status']).toBe('not_ready');

    // Transmit: one per PO, exact-version grants, PO marked baseline released.
    const sent = await engineering.post(`/api/v1/sales-orders/${orderId}/transmittals`, { baselineId });
    expect(sent.status).toBe(201);
    const grants = await pg.query(`SELECT document_version_id FROM dms.audience_grant WHERE organization_id = $1 AND revoked_at IS NULL`, [supplierOrgA]);
    expect(grants.rows.map((r) => r.document_version_id).sort()).toEqual([drawingV, oldDrawingV, specV].sort());
    expect((await engineering.post(`/api/v1/sales-orders/${orderId}/transmittals`, { baselineId })).status).toBe(409);

    const view = await supplierView(supplierA, poA);
    const transmittal = view['transmittal'] as Body;
    expect((transmittal['items'] as Body[]).length).toBe(3);
    expect(JSON.stringify(view)).not.toMatch(/Kovai|customer|sell/i);
    // Supplier B cannot read A's production record.
    expect((await supplierB.get(`/api/v1/supplier/purchase-orders/${poA}/production`)).status).toBe(404);

    // Still red: the transmittal is not acknowledged, and there is no quality plan.
    w = await wp(wpA);
    expect((w['gates'] as Body[]).filter((g) => !g['pass']).map((g) => g['key']).sort()).toEqual(['compliance', 'technical']);
    const acked = await supplierA.post(`/api/v1/supplier/transmittals/${transmittal['transmittalId']}/acknowledge`, { expectedVersion: transmittal['aggregateVersion'], note: 'Drawing pack received.' });
    expect(acked.status).toBe(201);
    expect((acked.body['transmittal'] as Body)['status']).toBe('acknowledged');
    await sourcing.post(`/api/v1/purchase-orders/${poA}/work-package`, { plannedStart: '2026-10-06', plannedFinish: '2026-10-26', qualityPlanPresent: true });
    w = await wp(wpA);
    expect(w['allGreen']).toBe(true);

    const ok = await sourcing.post(`/api/v1/work-packages/${wpA}/release`, { expectedVersion: w['aggregateVersion'] });
    expect(ok.status).toBe(201);
    w = await wp(wpA);
    expect(w['status']).toBe('released');
    const snapshot = w['releaseSnapshot'] as Body;
    expect((snapshot['baseline'] as Body)['manifestHash']).toBe((await one<{ manifest_hash: string }>(`SELECT manifest_hash FROM dms.baseline WHERE id = $1`, [baselineId])).manifest_hash);
    expect((snapshot['gates'] as Body[]).every((g) => g['pass'])).toBe(true);
    // The work package records the baseline it works to (BR-ENG-04).
    expect(w['baselinesUsed']).toEqual([{ baselineId, number: expect.stringMatching(/^BL-/), transmittalNumber: expect.any(String), effectiveFrom: expect.any(String) }]);
    expect(milestones(w)[0]!['status']).toBe('ready');
    // A released plan is frozen.
    expect((await sourcing.post(`/api/v1/purchase-orders/${poA}/work-package`, { plannedStart: '2026-10-07', plannedFinish: '2026-10-27', qualityPlanPresent: true })).status).toBe(409);
    expect((await customer.get(`/api/v1/orders/${orderId}`)).body['status']).toBe('manufacturing_in_progress');
  });

  // ---------------------------------------------------------------- F-09.4 milestones

  it('takes evidence without verifying it, refuses supplier backdating, and verifies only with clean files and a separate verifier', async () => {
    let w = await wp(wpA);
    let m1 = milestones(w)[0]!;
    expect((await supplierA.post(`/api/v1/supplier/milestones/${m1['milestoneId']}/start`, { expectedVersion: m1['aggregateVersion'] })).status).toBe(201);
    m1 = milestones(await wp(wpA))[0]!;
    expect(m1['status']).toBe('in_progress');

    const photo = await seedVersion(supplierOrgA, 'image', 'Material receipt photo', { scan: 'scanning' });
    const stale = await supplierA.post(`/api/v1/supplier/milestones/${m1['milestoneId']}/evidence`, {
      expectedVersion: m1['aggregateVersion'],
      items: [{ documentVersionId: photo.versionId, observedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }],
    });
    expect(stale.status).toBe(403);
    expect(stale.body['code']).toBe('BACKDATE_NOT_PERMITTED');
    // Someone else's file is not evidence.
    expect((await supplierA.post(`/api/v1/supplier/milestones/${m1['milestoneId']}/evidence`, { expectedVersion: m1['aggregateVersion'], items: [{ documentVersionId: drawingV }] })).status).toBe(422);

    const submitted = await supplierA.post(`/api/v1/supplier/milestones/${m1['milestoneId']}/evidence`, { expectedVersion: m1['aggregateVersion'], items: [{ documentVersionId: photo.versionId, note: 'Bar stock with mill certificate' }] });
    expect(submitted.status).toBe(201);
    w = await wp(wpA);
    m1 = milestones(w)[0]!;
    expect(m1['status']).toBe('evidence_submitted');
    // Evidence names the baseline the supplier acknowledged, not merely the latest released.
    const stamped = await one<{ matches: boolean }>(
      `SELECT bool_and(e.baseline_id = t.baseline_id) AS matches
         FROM orders.milestone_evidence e
         JOIN dms.transmittal t ON t.purchase_order_id = $1 AND t.acknowledged_at IS NOT NULL
        WHERE e.milestone_id = $2`,
      [poA, m1['milestoneId']],
    );
    expect(stamped.matches).toBe(true);
    expect((await quality.get('/api/v1/production/verification-queue')).body['milestones']).toHaveLength(1);
    // Quality works from the production view alone: order header and POs, no commercial detail.
    const qaView = await quality.get(`/api/v1/sales-orders/${orderId}/production`);
    expect(qaView.status).toBe(200);
    expect((qaView.body['purchaseOrders'] as Body[]).length).toBe(2);
    expect(JSON.stringify(qaView.body['order'])).not.toMatch(/totalMinor|acceptance|unitPrice/);
    expect((await quality.get(`/api/v1/sales-orders/${orderId}`)).status).toBe(403);

    // Sourcing has no verifier authority; quality cannot verify a file still being scanned.
    expect((await sourcing.post(`/api/v1/milestones/${m1['milestoneId']}/verify`, { expectedVersion: m1['aggregateVersion'], decision: 'verified' })).status).toBe(403);
    const scanning = await quality.post(`/api/v1/milestones/${m1['milestoneId']}/verify`, { expectedVersion: m1['aggregateVersion'], decision: 'verified' });
    expect(scanning.status).toBe(409);
    expect(scanning.body['code']).toBe('EVIDENCE_NOT_CLEAN');
    await pg.query(`UPDATE dms.file_object SET scan_state = 'clean' WHERE id = $1`, [photo.fileId]);

    // Backdating the actual date needs a reason.
    const yesterday = new Date(Date.now() + 330 * 60_000 - 2 * 86_400_000).toISOString().slice(0, 10);
    const noReason = await quality.post(`/api/v1/milestones/${m1['milestoneId']}/verify`, { expectedVersion: m1['aggregateVersion'], decision: 'verified', actualDate: yesterday });
    expect(noReason.status).toBe(403);
    expect(noReason.body['code']).toBe('BACKDATE_NOT_PERMITTED');
    const verified = await quality.post(`/api/v1/milestones/${m1['milestoneId']}/verify`, { expectedVersion: m1['aggregateVersion'], decision: 'verified', actualDate: yesterday, backdateReason: 'Material arrived two days ago; photo uploaded late.' });
    expect(verified.status).toBe(201);
    w = await wp(wpA);
    expect(milestones(w)[0]).toMatchObject({ status: 'verified', actualDate: yesterday });
    expect(milestones(w)[1]!['status']).toBe('ready');

    // The customer sees the curated checkpoint — and nothing about who made it or how.
    const order = await customer.get(`/api/v1/orders/${orderId}`);
    expect(order.body['progress']).toEqual([expect.objectContaining({ label: 'Material received' })]);
    const text = JSON.stringify(order.body);
    expect(text).not.toMatch(/Anand|Balaji|WP-2026|PO-2026|TR-2026|evidence_submitted|in_production|supplier/i);
  });

  it('flags reused evidence for review instead of rejecting it, and lets a rejection be answered', async () => {
    let m2 = milestones(await wp(wpA))[1]!;
    await supplierA.post(`/api/v1/supplier/milestones/${m2['milestoneId']}/start`, { expectedVersion: m2['aggregateVersion'] });
    m2 = milestones(await wp(wpA))[1]!;
    // Same bytes as the material photo, offered again under a new document.
    const firstEvidence = await one<{ file_object_id: string }>(
      `SELECT dv.file_object_id FROM orders.milestone_evidence e JOIN dms.document_version dv ON dv.id = e.document_version_id LIMIT 1`,
    );
    const reused = await seedVersion(supplierOrgA, 'certificate', 'FAI report', { fileId: firstEvidence.file_object_id });
    const res = await supplierA.post(`/api/v1/supplier/milestones/${m2['milestoneId']}/evidence`, { expectedVersion: m2['aggregateVersion'], items: [{ documentVersionId: reused.versionId }] });
    expect(res.status).toBe(201);
    m2 = milestones(await wp(wpA))[1]!;
    expect((m2['evidence'] as Body[])[0]).toMatchObject({ flagged: true });
    expect(m2['status']).toBe('evidence_submitted');

    const rejected = await quality.post(`/api/v1/milestones/${m2['milestoneId']}/verify`, { expectedVersion: m2['aggregateVersion'], decision: 'rejected_evidence', reason: 'This is the material photo again; upload the FAI report.' });
    expect(rejected.status).toBe(201);
    m2 = milestones(await wp(wpA))[1]!;
    expect(m2['status']).toBe('rejected_evidence');
    const report = await seedVersion(supplierOrgA, 'certificate', 'FAI report v2');
    expect((await supplierA.post(`/api/v1/supplier/milestones/${m2['milestoneId']}/evidence`, { expectedVersion: m2['aggregateVersion'], items: [{ documentVersionId: report.versionId }] })).status).toBe(201);
    m2 = milestones(await wp(wpA))[1]!;
    expect((await quality.post(`/api/v1/milestones/${m2['milestoneId']}/verify`, { expectedVersion: m2['aggregateVersion'], decision: 'verified' })).status).toBe(201);
  });

  it('keeps the original plan when a delay is reported and tells the customer only that the schedule is under review', async () => {
    let m3 = milestones(await wp(wpA))[2]!;
    const planned = m3['plannedDate'] as string;
    const later = new Date(new Date(`${planned}T00:00:00Z`).getTime() + 5 * 86_400_000).toISOString().slice(0, 10);
    const delay = await supplierA.post(`/api/v1/milestones/${m3['milestoneId']}/delay`, { expectedVersion: m3['aggregateVersion'], forecastDate: later, reasonCode: 'machine', reason: 'Spindle bearing replacement on VMC-2' });
    expect(delay.status).toBe(201);
    expect(delay.body).toMatchObject({ plannedDate: planned, forecastDate: later });
    expect((delay.body['forecasts'] as Body[]).length).toBe(1);
    // Supplier B cannot touch A's milestone.
    m3 = milestones(await wp(wpA))[2]!;
    expect((await supplierB.post(`/api/v1/milestones/${m3['milestoneId']}/delay`, { expectedVersion: m3['aggregateVersion'], forecastDate: later, reasonCode: 'other', reason: 'nope' })).status).toBe(404);

    const order = await customer.get(`/api/v1/orders/${orderId}`);
    expect(order.body['scheduleUnderReview']).toBe(true);
    const production = (order.body['timeline'] as Body[]).find((s) => s['key'] === 'production')!;
    expect(production['detail']).toMatch(/Schedule under review/);
    expect(JSON.stringify(order.body)).not.toMatch(/Spindle|VMC|bearing/i);
  });

  it('completes the order’s production only when every work package is done', async () => {
    // Finish A by waiving the remaining checkpoints (quality, with a reason).
    for (let i = 2; i < 5; i += 1) {
      const m = milestones(await wp(wpA))[i]!;
      expect((await sourcing.post(`/api/v1/milestones/${m['milestoneId']}/waive`, { expectedVersion: m['aggregateVersion'], reason: 'Covered by the final inspection report.' })).status).toBe(403);
      const res = await quality.post(`/api/v1/milestones/${m['milestoneId']}/waive`, { expectedVersion: m['aggregateVersion'], reason: 'Covered by the final inspection report on file.' });
      expect(res.status).toBe(201);
    }
    expect((await wp(wpA))['status']).toBe('completed');
    expect((await sourcing.get(`/api/v1/sales-orders/${orderId}`)).body['status']).not.toBe('ready_supplier_dispatch');

    // B: acknowledge PO and transmittal, plan, release, finish.
    const po = await supplierB.get(`/api/v1/supplier/purchase-orders/${poB}`);
    await supplierB.post(`/api/v1/supplier/purchase-orders/${poB}/acknowledge`, { expectedVersion: po.body['aggregateVersion'], note: '' });
    const t = (await supplierView(supplierB, poB))['transmittal'] as Body;
    await supplierB.post(`/api/v1/supplier/transmittals/${t['transmittalId']}/acknowledge`, { expectedVersion: t['aggregateVersion'], note: '' });
    const planned = await sourcing.post(`/api/v1/purchase-orders/${poB}/work-package`, {
      plannedStart: '2026-10-06',
      plannedFinish: '2026-10-20',
      qualityPlanPresent: true,
      milestones: [{ title: 'Parts machined and inspected', customerLabel: 'Production complete', plannedDate: '2026-10-20', evidencePolicy: 'none', minEvidence: 0 }],
    });
    const wpB = (planned.body['workPackages'] as Body[]).find((w) => w['purchaseOrderId'] === poB)!;
    expect((await sourcing.post(`/api/v1/work-packages/${wpB['workPackageId']}/release`, { expectedVersion: wpB['aggregateVersion'] })).status).toBe(201);
    let only = milestones(await wp(wpB['workPackageId'] as string))[0]!;
    await supplierB.post(`/api/v1/supplier/milestones/${only['milestoneId']}/start`, { expectedVersion: only['aggregateVersion'] });
    only = milestones(await wp(wpB['workPackageId'] as string))[0]!;
    expect((await supplierB.post(`/api/v1/supplier/milestones/${only['milestoneId']}/evidence`, { expectedVersion: only['aggregateVersion'], items: [{ documentVersionId: (await seedVersion(supplierOrgB, 'image', 'Batch photo')).versionId }] })).status).toBe(201);
    only = milestones(await wp(wpB['workPackageId'] as string))[0]!;
    expect((await quality.post(`/api/v1/milestones/${only['milestoneId']}/verify`, { expectedVersion: only['aggregateVersion'], decision: 'verified' })).status).toBe(201);

    expect((await sourcing.get(`/api/v1/sales-orders/${orderId}`)).body['status']).toBe('ready_supplier_dispatch');
    const order = await customer.get(`/api/v1/orders/${orderId}`);
    expect(order.body['status']).toBe('final_checks');
    expect((order.body['progress'] as Body[]).map((p) => p['label'])).toEqual(['Material received', 'First part approved', 'Production complete']);
  });

  it('shows engineering and quality their production queues', async () => {
    const eng = (await engineering.get('/api/v1/operations/summary')).body['queues'] as Body[];
    expect(eng.map((q) => q['key'])).toEqual(expect.arrayContaining(['baselines_to_release', 'work_packages_to_release']));
    const qa = (await quality.get('/api/v1/operations/summary')).body['queues'] as Body[];
    expect(qa.map((q) => q['key'])).toContain('milestones_to_verify');
  });
});
