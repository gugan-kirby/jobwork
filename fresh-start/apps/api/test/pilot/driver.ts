import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { signRequest } from '@jobwork/object-store';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { NOTIFIED_EVENT_TYPES } from '@jobwork/contracts';
import { mintServiceToken, SCAN_WORKER_PRINCIPAL, SERVICE_TOKEN_HEADER } from '@jobwork/service-auth';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { expect } from 'vitest';
import { hashPassword } from '../../src/modules/iam/domain/password';
import { createTestApp } from '../helpers/boot';
import { TestClient } from '../helpers/http';

/**
 * IN-12 F-12.1 pilot driver. Each scenario (doc 19 §10) walks the Phase 1 path through
 * the real HTTP API, from the customer's draft to the supplier's acknowledged purchase
 * order, and checks what doc 19 requires of every scenario: data versions, authority,
 * audit/outbox, projections, notifications, failure recovery and final consistency.
 *
 * Seeded as rows, because they are the stage and not the play: organizations, people and
 * their roles (internal accounts have no self-service path), MFA secrets, supplier
 * eligibility (onboarding is IN-04's suite), and the customer's clean drawing (upload and
 * scan are the DMS suites'; the object store is not what a pilot scenario proves).
 * Everything after that is a request a person would make.
 */

export type Body = Record<string, unknown>;
type Res = { status: number; body: Body };

const PASSWORD = 'pilot-password-1';
const SERVICE_SECRET = 'test-service-token-secret';
export const WEBHOOK_SECRET = 'test-payment-webhook-secret';
export const CARRIER_SECRET = 'test-carrier-webhook-secret';

export type Actor =
  | 'buyer'
  | 'approver'
  | 'outsider'
  | 'supplierA'
  | 'supplierB'
  | 'engineering'
  | 'sourcing'
  | 'sourcing2'
  | 'sales'
  | 'sales2'
  | 'finance'
  | 'finance2'
  | 'quality'
  | 'quality2'
  | 'logistics'
  | 'admin';

const PEOPLE: Record<Actor, { email: string; org: 'customer' | 'outsider' | 'supplierA' | 'supplierB' | 'internal'; roles: string[]; mfa: boolean }> = {
  buyer: { email: 'buyer@kovai.test', org: 'customer', roles: ['customer_requester'], mfa: false },
  approver: { email: 'approver@kovai.test', org: 'customer', roles: ['customer_approver'], mfa: false },
  outsider: { email: 'buyer@madurai.test', org: 'outsider', roles: ['customer_requester', 'customer_approver'], mfa: false },
  supplierA: { email: 'estimator@anand.test', org: 'supplierA', roles: ['org_admin', 'supplier_estimator'], mfa: false },
  supplierB: { email: 'estimator@balaji.test', org: 'supplierB', roles: ['org_admin', 'supplier_estimator'], mfa: false },
  engineering: { email: 'engineering@jobwork.test', org: 'internal', roles: ['jobwork_engineering'], mfa: true },
  sourcing: { email: 'sourcing@jobwork.test', org: 'internal', roles: ['jobwork_sourcing'], mfa: true },
  sourcing2: { email: 'sourcing2@jobwork.test', org: 'internal', roles: ['jobwork_sourcing'], mfa: true },
  sales: { email: 'sales@jobwork.test', org: 'internal', roles: ['jobwork_sales'], mfa: true },
  sales2: { email: 'sales2@jobwork.test', org: 'internal', roles: ['jobwork_sales'], mfa: true },
  finance: { email: 'finance@jobwork.test', org: 'internal', roles: ['jobwork_finance'], mfa: true },
  finance2: { email: 'finance2@jobwork.test', org: 'internal', roles: ['jobwork_finance'], mfa: true },
  quality: { email: 'quality@jobwork.test', org: 'internal', roles: ['jobwork_quality'], mfa: true },
  quality2: { email: 'quality2@jobwork.test', org: 'internal', roles: ['jobwork_quality'], mfa: true },
  logistics: { email: 'logistics@jobwork.test', org: 'internal', roles: ['jobwork_logistics'], mfa: true },
  admin: { email: 'admin@jobwork.test', org: 'internal', roles: ['platform_admin', 'security_admin'], mfa: true },
};

/** Fails with the response body, so a broken step names itself. */
export function ok(res: Res, status: number, step: string): Body {
  if (res.status !== status) throw new Error(`${step}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export const daysFromNow = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export class Pilot {
  db!: TestDatabase;
  app!: NestFastifyApplication;
  baseUrl!: string;
  pg!: Client;
  as = {} as Record<Actor, TestClient>;
  orgs = {} as Record<'customer' | 'outsider' | 'supplierA' | 'supplierB' | 'internal', string>;
  /** IN-16: JobWork's receiving hub and each supplier's works site. */
  sites = {} as Record<'hub' | 'supplierA' | 'supplierB', string>;
  memberships = {} as Record<Actor, string>;
  users = {} as Record<Actor, string>;
  profiles = {} as Record<'supplierA' | 'supplierB', string>;
  capabilities = {} as { milling: string; aluminium: string };
  drawingVersionId!: string;

  static async start(name: string): Promise<Pilot> {
    const p = new Pilot();
    p.db = await createTestDatabase(`jobwork_pilot_${name}`);
    process.env['DATABASE_URL'] = p.db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = SERVICE_SECRET;
    process.env['PAYMENT_WEBHOOK_SECRET'] = WEBHOOK_SECRET;
    process.env['CARRIER_WEBHOOK_SECRET'] = CARRIER_SECRET;
    process.env['NODE_ENV'] = 'test';
    p.pg = new Client({ connectionString: p.db.url });
    await p.pg.connect();
    await p.seed();
    ({ app: p.app, baseUrl: p.baseUrl } = await createTestApp());
    for (const actor of Object.keys(PEOPLE) as Actor[]) p.as[actor] = await p.signIn(actor);
    return p;
  }

  async stop(): Promise<void> {
    await this.app?.close();
    await this.pg?.end();
    await this.db?.drop();
  }

  // ------------------------------------------------------------------ stage (rows)

  async one<T = Body>(sql: string, args: unknown[] = []): Promise<T> {
    return (await this.pg.query(sql, args)).rows[0] as T;
  }

  async rows<T = Body>(sql: string, args: unknown[] = []): Promise<T[]> {
    return (await this.pg.query(sql, args)).rows as T[];
  }

  private async seed(): Promise<void> {
    const caps = await this.rows<{ id: string; code: string }>(`SELECT id, code FROM supplier.capability WHERE code IN ('cnc_milling', 'material_aluminium')`);
    this.capabilities = { milling: caps.find((c) => c.code === 'cnc_milling')!.id, aluminium: caps.find((c) => c.code === 'material_aluminium')!.id };
    const org = async (type: string, name: string): Promise<string> =>
      (await this.one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ($1, $2, $2) RETURNING id`, [type, name])).id;
    this.orgs = {
      internal: await org('internal', 'JobWork Operations'),
      customer: await org('customer', 'Kovai Pumps'),
      outsider: await org('customer', 'Madurai Motors'),
      supplierA: await org('supplier', 'Anand Engineering'),
      supplierB: await org('supplier', 'Balaji Precision'),
    };
    for (const [actor, person] of Object.entries(PEOPLE) as Array<[Actor, (typeof PEOPLE)[Actor]]>) {
      const user = await this.one<{ id: string }>(
        `INSERT INTO iam.user_account (email, password_hash, password_params_version, display_name, status, email_verified_at) VALUES ($1, $2, 1, $3, 'active', now()) RETURNING id`,
        [person.email, await hashPassword(PASSWORD), person.email.split('@')[0]],
      );
      const m = await this.one<{ id: string }>(`INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`, [user.id, this.orgs[person.org]]);
      await this.pg.query(`INSERT INTO iam.membership_role (membership_id, role_id) SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`, [m.id, person.roles]);
      this.users[actor] = user.id;
      this.memberships[actor] = m.id;
    }
    const site = async (orgId: string, label: string, city: string): Promise<string> =>
      (await this.one<{ id: string }>(
        `INSERT INTO iam.organization_site (organization_id, label, kind, address_line1, city, state, postal_code, contact_name, contact_phone) VALUES ($1, $2, 'works', 'Plot 7, Industrial Estate', $3, 'Tamil Nadu', '600032', 'Stores', '+91 90000 00001') RETURNING id`,
        [orgId, label, city],
      )).id;
    this.sites = {
      hub: await site(this.orgs.internal, 'JobWork receiving hub', 'Chennai'),
      supplierA: await site(this.orgs.supplierA, 'Anand works', 'Coimbatore'),
      supplierB: await site(this.orgs.supplierB, 'Balaji works', 'Hosur'),
    };
    for (const supplier of ['supplierA', 'supplierB'] as const) {
      const name = supplier === 'supplierA' ? 'Anand Engineering' : 'Balaji Precision';
      const profile = await this.one<{ id: string }>(
        `INSERT INTO supplier.supplier_profile (organization_id, region_class, status, decided_by, decided_at, submitted_by, trade_name, primary_contact_name, primary_contact_email, primary_contact_phone, summary)
         VALUES ($1, 'chennai_metro', 'active', gen_random_uuid(), now(), gen_random_uuid(), $2, 'Contact', 'contact@example.test', '+91 90000 00000', 'We machine things') RETURNING id`,
        [this.orgs[supplier], name],
      );
      this.profiles[supplier] = profile.id;
      for (const capabilityId of [this.capabilities.milling, this.capabilities.aluminium]) {
        await this.pg.query(`INSERT INTO supplier.supplier_capability (supplier_profile_id, capability_id, version_no) VALUES ($1, $2, 1)`, [profile.id, capabilityId]);
      }
      for (const kind of ['gst', 'pan', 'bank_account']) {
        await this.pg.query(
          `INSERT INTO supplier.verification_item (supplier_profile_id, kind, version_no, status, submitted_by, submitted_at, reviewed_by, reviewed_at, expires_at)
           VALUES ($1, $2, 1, 'verified', gen_random_uuid(), now(), gen_random_uuid(), now(), now() + interval '200 days')`,
          [profile.id, kind],
        );
      }
    }
    this.drawingVersionId = await this.cleanDrawing(this.orgs.customer);
  }

  /** One more eligible supplier, signed in: for bursts that need many at once. */
  async extraSupplier(name: string, email: string): Promise<{ orgId: string; profileId: string; client: TestClient }> {
    const orgId = (await this.one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('supplier', $1, $1) RETURNING id`, [name])).id;
    const user = await this.one<{ id: string }>(
      `INSERT INTO iam.user_account (email, password_hash, password_params_version, display_name, status, email_verified_at) VALUES ($1, $2, 1, $3, 'active', now()) RETURNING id`,
      [email, await hashPassword(PASSWORD), name],
    );
    const m = await this.one<{ id: string }>(`INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`, [user.id, orgId]);
    await this.pg.query(`INSERT INTO iam.membership_role (membership_id, role_id) SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`, [m.id, ['org_admin', 'supplier_estimator']]);
    const profileId = (await this.one<{ id: string }>(
      `INSERT INTO supplier.supplier_profile (organization_id, region_class, status, decided_by, decided_at, submitted_by, trade_name, primary_contact_name, primary_contact_email, primary_contact_phone, summary)
       VALUES ($1, 'chennai_metro', 'active', gen_random_uuid(), now(), gen_random_uuid(), $2, 'Contact', 'contact@example.test', '+91 90000 00000', 'We machine things') RETURNING id`,
      [orgId, name],
    )).id;
    for (const capabilityId of [this.capabilities.milling, this.capabilities.aluminium]) {
      await this.pg.query(`INSERT INTO supplier.supplier_capability (supplier_profile_id, capability_id, version_no) VALUES ($1, $2, 1)`, [profileId, capabilityId]);
    }
    for (const kind of ['gst', 'pan', 'bank_account']) {
      await this.pg.query(
        `INSERT INTO supplier.verification_item (supplier_profile_id, kind, version_no, status, submitted_by, submitted_at, reviewed_by, reviewed_at, expires_at)
         VALUES ($1, $2, 1, 'verified', gen_random_uuid(), now(), gen_random_uuid(), now(), now() + interval '200 days')`,
        [profileId, kind],
      );
    }
    const client = new TestClient(this.baseUrl);
    ok(await client.post('/api/v1/auth/login', { email, password: PASSWORD }), 201, `sign in ${email}`);
    return { orgId, profileId, client };
  }

  /** A scanned-clean drawing the given organization owns. */
  async cleanDrawing(orgId: string): Promise<string> {
    const doc = await this.one<{ id: string }>(`INSERT INTO dms.document (owning_organization_id, logical_type, title) VALUES ($1, 'drawing_2d', 'Bracket drawing') RETURNING id`, [orgId]);
    const file = await this.one<{ id: string }>(
      `INSERT INTO dms.file_object (storage_key, byte_size, declared_media_type, sha256, scan_state, owning_organization_id) VALUES ($1, 2048, 'application/pdf', $2, 'clean', $3) RETURNING id`,
      [`clean/${randomBytes(8).toString('hex')}`, randomBytes(32).toString('hex'), orgId],
    );
    const version = await this.one<{ id: string }>(
      `INSERT INTO dms.document_version (document_id, version_no, file_object_id, original_filename, status, created_by) VALUES ($1, 1, $2, 'bracket.pdf', 'available', gen_random_uuid()) RETURNING id`,
      [doc.id, file.id],
    );
    // As finalize would: the document points at its current version, so a later upload is version 2.
    await this.pg.query(`UPDATE dms.document SET current_version_no = 1 WHERE id = $1`, [doc.id]);
    return version.id;
  }

  private totp(secret: string, email: string): string {
    return new OTPAuth.TOTP({ issuer: 'JobWork', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  }

  async signIn(actor: Actor): Promise<TestClient> {
    const { email, mfa } = PEOPLE[actor];
    const first = new TestClient(this.baseUrl);
    ok(await first.post('/api/v1/auth/login', { email, password: PASSWORD }), 201, `sign in ${actor}`);
    if (!mfa) return first;
    const secret = await this.one<{ mfa_totp_secret: string | null }>(`SELECT mfa_totp_secret FROM iam.user_account WHERE email = $1`, [email]);
    if (!secret.mfa_totp_secret) {
      const enroll = ok(await first.post('/api/v1/account/mfa/enroll'), 201, `enroll ${actor}`);
      ok(await first.post('/api/v1/account/mfa/activate', { code: this.totp(enroll['secret'] as string, email) }), 201, `activate ${actor}`);
      return first;
    }
    ok(await first.post('/api/v1/auth/mfa', { code: this.totp(secret.mfa_totp_secret, email) }), 201, `mfa ${actor}`);
    return first;
  }

  // ------------------------------------------------------------------ intake

  draftBody(overrides: Body = {}, item: Body = {}): Body {
    return {
      title: 'Pump mounting bracket',
      applicationNote: 'Mounts the drive motor on a centrifugal pump skid.',
      requiredByDate: daysFromNow(60),
      items: [
        {
          lineNo: 1,
          partName: 'Bracket',
          description: 'Machined aluminium bracket',
          processCapabilityId: this.capabilities.milling,
          materialCapabilityId: this.capabilities.aluminium,
          materialGrade: '6061-T6',
          quantityBreakpoints: [{ quantity: 100, unit: 'piece', kind: 'production' }],
          toleranceClass: 'IT8',
          inspectionLevel: 'dimensional_report',
          ...item,
        },
      ],
      documents: [{ documentVersionId: this.drawingVersionId, role: 'governing', lineNo: 1 }],
      ...overrides,
    };
  }

  /** Customer drafts and submits; returns the submitted enquiry. */
  async submitEnquiry(overrides: Body = {}, item: Body = {}): Promise<{ enquiryId: string; reference: string; version: number }> {
    const draft = ok(await this.as.buyer.post('/api/v1/enquiries/draft', this.draftBody(overrides, item)), 201, 'draft enquiry');
    const submitted = ok(
      await this.as.buyer.post(`/api/v1/enquiries/${draft['enquiryId']}/submit`, { expectedVersion: draft['aggregateVersion'] }),
      201,
      'submit enquiry',
    );
    return { enquiryId: draft['enquiryId'] as string, reference: submitted['reference'] as string, version: submitted['aggregateVersion'] as number };
  }

  async intake(enquiryId: string): Promise<Body> {
    return ok(await this.as.engineering.get(`/api/v1/intake/${enquiryId}`), 200, 'read intake');
  }

  async enquiryVersion(enquiryId: string): Promise<number> {
    return ((await this.intake(enquiryId))['enquiry'] as Body)['aggregateVersion'] as number;
  }

  async triage(enquiryId: string): Promise<Body> {
    return ok(await this.as.engineering.post(`/api/v1/intake/${enquiryId}/triage`, { expectedVersion: await this.enquiryVersion(enquiryId) }), 201, 'triage');
  }

  async approveForSourcing(enquiryId: string): Promise<Body> {
    return ok(await this.as.engineering.post(`/api/v1/intake/${enquiryId}/approve`, { expectedVersion: await this.enquiryVersion(enquiryId) }), 201, 'approve for sourcing');
  }

  /** Submitted → under review → approved for sourcing. */
  async approvedEnquiry(item: Body = {}): Promise<{ enquiryId: string; reference: string }> {
    const { enquiryId, reference } = await this.submitEnquiry({}, item);
    await this.triage(enquiryId);
    await this.approveForSourcing(enquiryId);
    return { enquiryId, reference };
  }

  // ------------------------------------------------------------------ sourcing

  async rfq(rfqId: string): Promise<Body> {
    return ok(await this.as.sourcing.get(`/api/v1/rfqs/${rfqId}`), 200, 'read rfq');
  }

  async rfqVersion(rfqId: string): Promise<number> {
    return ((await this.rfq(rfqId))['rfq'] as Body)['aggregateVersion'] as number;
  }

  /** Create, invite, release; returns the round and its first line as the suppliers see it. */
  async openRound(enquiryId: string, suppliers: Array<'supplierA' | 'supplierB'> = ['supplierA', 'supplierB']): Promise<{ rfqId: string; itemId: string }> {
    const created = ok(
      await this.as.sourcing.post('/api/v1/rfqs', { enquiryId, deadlineAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), lateBidPolicy: 'reject', instructions: 'Quote per piece at 100 off.' }),
      201,
      'create rfq',
    );
    const rfqId = created['rfqId'] as string;
    for (const supplier of suppliers) {
      ok(await this.as.sourcing.post(`/api/v1/rfqs/${rfqId}/invitations`, { supplierProfileId: this.profiles[supplier] }), 201, `invite ${supplier}`);
    }
    ok(await this.as.sourcing.post(`/api/v1/rfqs/${rfqId}/release`, { expectedVersion: await this.rfqVersion(rfqId) }), 201, 'release rfq');
    // The worker sends invitations within seconds of release; recipients are resolved then.
    await this.dispatchNotifications();
    const seen = ok(await this.as[suppliers[0]!].get(`/api/v1/supplier/rfqs/${rfqId}`), 200, 'supplier reads rfq');
    return { rfqId, itemId: (seen['items'] as Body[])[0]!['rfqItemId'] as string };
  }

  bidBody(itemId: string, unitPriceMinor: number, extra: Body = {}): Body {
    return {
      currency: 'INR',
      taxTreatment: 'gst_extra',
      lines: [{ rfqItemId: itemId, lineNo: 1, quantity: 100, unit: 'piece', unitPriceMinor, setupAmountMinor: 500000, note: '' }],
      nreAmountMinor: 0,
      freightAmountMinor: 250000,
      leadTimeDays: 21,
      validityUntil: daysFromNow(30),
      feasibility: 'feasible',
      assumptions: 'Material from our stock.',
      exclusions: 'Surface treatment not included.',
      paymentTerms: '30 days from invoice',
      note: '',
      ...extra,
    };
  }

  async bid(supplier: 'supplierA' | 'supplierB', rfqId: string, itemId: string, unitPriceMinor: number, extra: Body = {}): Promise<{ bidVersionId: string; versionNo: number; contentHash: string }> {
    const b = ok(await this.as[supplier].post(`/api/v1/supplier/rfqs/${rfqId}/bid/submit`, this.bidBody(itemId, unitPriceMinor, extra)), 201, `${supplier} bids`);
    return { bidVersionId: b['bidVersionId'] as string, versionNo: b['versionNo'] as number, contentHash: b['contentHash'] as string };
  }

  async closeRound(rfqId: string): Promise<Body> {
    return ok(await this.as.sourcing.post(`/api/v1/rfqs/${rfqId}/close`, { expectedVersion: await this.rfqVersion(rfqId) }), 201, 'close rfq');
  }

  // ------------------------------------------------------------------ commercial

  async evaluate(rfqId: string): Promise<{ evaluationId: string; rows: Body[] }> {
    const e = ok(await this.as.sourcing.post(`/api/v1/rfqs/${rfqId}/evaluations`, { scenario: { inspectionPackagingMinor: 0, financingRiskBp: 0, nreAllocation: 'value' } }), 201, 'evaluate');
    return { evaluationId: e['evaluationId'] as string, rows: e['rows'] as Body[] };
  }

  /** Proposes the whole quantity to one bid version. */
  async proposeAward(rfqId: string, itemId: string, evaluationId: string, bidVersionId: string, extra: Body = {}): Promise<Res> {
    return this.as.sourcing.post('/api/v1/awards', {
      rfqId,
      evaluationId,
      items: [{ rfqItemId: itemId, targetQuantity: 100, lines: [{ bidVersionId, bidQuantity: 100, quantity: 100 }] }],
      rationale: 'Lowest normalized landed cost with the lead time the customer needs.',
      ...extra,
    });
  }

  async decide(actor: Actor, approvalRequestId: string, decision: 'approved' | 'rejected' = 'approved', reason = ''): Promise<Res> {
    return this.as[actor].post(`/api/v1/approvals/${approvalRequestId}/decide`, { decision, reason });
  }

  /** Cost sheet on an approved award, sent for approval and approved by someone else. */
  async approvedCostSheet(awardId: string): Promise<{ costSheetId: string; costSheetVersionId: string; version: Body }> {
    const sheet = ok(
      await this.as.sales.post(`/api/v1/awards/${awardId}/cost-sheet`, {
        components: [{ code: 'freight_outbound', label: 'Freight to customer', amountMinor: 30000, basis: 'courier estimate' }],
        targetMarginBp: 1500,
        note: 'Pilot standard margin.',
      }),
      201,
      'build cost sheet',
    );
    const costSheetId = sheet['costSheetId'] as string;
    const requested = ok(await this.as.sales.post(`/api/v1/cost-sheets/${costSheetId}/request-approval`, {}), 201, 'request cost sheet approval');
    const approvalId = (requested['versions'] as Body[])[0]!['approvalRequestId'] as string;
    ok(await this.decide('finance', approvalId), 201, 'approve cost sheet');
    const approved = ok(await this.as.sales.get(`/api/v1/cost-sheets/${costSheetId}`), 200, 'read cost sheet');
    const version = (approved['versions'] as Body[]).find((v) => v['status'] === 'approved')!;
    return { costSheetId, costSheetVersionId: version['costSheetVersionId'] as string, version };
  }

  quoteContent(extra: Body = {}): Body {
    return { deliveryLeadDays: 21, paymentTerms: '50% advance, balance before dispatch', validityUntil: daysFromNow(14), advanceBp: 5000, balanceTrigger: 'before_dispatch', taxRateBp: 1800, freightMinor: 0, ...extra };
  }

  async quoteVersion(quoteId: string): Promise<number> {
    return ok(await this.as.sales.get(`/api/v1/quotes/${quoteId}`), 200, 'read quote')['aggregateVersion'] as number;
  }

  /** Request approval → a second sales user approves → send. */
  async approveAndSend(quoteId: string): Promise<Body> {
    const requested = ok(await this.as.sales.post(`/api/v1/quotes/${quoteId}/request-approval`, { expectedVersion: await this.quoteVersion(quoteId) }), 201, 'request quote approval');
    const approvalId = (requested['versions'] as Body[])[0]!['approvalRequestId'] as string;
    ok(await this.decide('sales2', approvalId), 201, 'approve quote');
    return ok(await this.as.sales.post(`/api/v1/quotes/${quoteId}/send`, { expectedVersion: await this.quoteVersion(quoteId) }), 201, 'send quote');
  }

  async sentQuote(costSheetVersionId: string, content: Body = {}, optionLabel = 'standard'): Promise<string> {
    const q = ok(await this.as.sales.post('/api/v1/quotes', { costSheetVersionId, optionLabel, content: this.quoteContent(content) }), 201, 'draft quote');
    await this.approveAndSend(q['quoteId'] as string);
    return q['quoteId'] as string;
  }

  /** What the customer approver needs to accept exactly what they saw. */
  async acceptanceBody(quoteId: string): Promise<Body> {
    const seen = ok(await this.as.approver.get(`/api/v1/quotations/${quoteId}`), 200, 'customer reads quotation');
    return {
      expectedVersion: seen['aggregateVersion'],
      quoteVersionNo: seen['versionNo'],
      contentHash: seen['contentHash'],
      termsHash: (seen['terms'] as Body)['hash'],
      acknowledgeTerms: true,
    };
  }

  async accept(quoteId: string, key = `accept-${randomUUID()}`, body?: Body): Promise<Res> {
    return this.as.approver.post(`/api/v1/quotations/${quoteId}/accept`, body ?? (await this.acceptanceBody(quoteId)), { headers: { 'idempotency-key': key } });
  }

  // ------------------------------------------------------------------ orders

  async issuePurchaseOrders(orderId: string): Promise<Body[]> {
    const so = ok(await this.as.sourcing.get(`/api/v1/sales-orders/${orderId}`), 200, 'read sales order');
    const issued = ok(await this.as.sourcing.post(`/api/v1/sales-orders/${orderId}/purchase-orders`, { expectedVersion: so['aggregateVersion'] }), 201, 'issue purchase orders');
    return issued['purchaseOrders'] as Body[];
  }

  async acknowledgePurchaseOrder(supplier: 'supplierA' | 'supplierB', purchaseOrderId: string): Promise<Body> {
    const po = ok(await this.as[supplier].get(`/api/v1/supplier/purchase-orders/${purchaseOrderId}`), 200, 'supplier reads PO');
    return ok(await this.as[supplier].post(`/api/v1/supplier/purchase-orders/${purchaseOrderId}/acknowledge`, { expectedVersion: po['aggregateVersion'], note: 'Material booked.' }), 201, 'acknowledge PO');
  }

  /**
   * The whole sourcing-to-PO path for an approved enquiry: both suppliers bid, the cheaper
   * one is awarded, quoted, accepted, ordered and acknowledged.
   */
  async sourceToPurchaseOrder(enquiryId: string): Promise<SourcedDeal> {
    const { rfqId, itemId } = await this.openRound(enquiryId);
    const bidA = await this.bid('supplierA', rfqId, itemId, 4850);
    const bidB = await this.bid('supplierB', rfqId, itemId, 5250);
    return this.awardToPurchaseOrder({ rfqId, itemId, winner: bidA, loser: bidB });
  }

  async awardToPurchaseOrder(round: { rfqId: string; itemId: string; winner: { bidVersionId: string }; loser?: { bidVersionId: string } }, awardExtra: Body = {}, approver: Actor = 'sales'): Promise<SourcedDeal> {
    const closed = await this.closeRound(round.rfqId);
    expect(closed['status']).toBe('evaluation');
    const { evaluationId, rows } = await this.evaluate(round.rfqId);
    const award = ok(await this.proposeAward(round.rfqId, round.itemId, evaluationId, round.winner.bidVersionId, awardExtra), 201, 'propose award');
    ok(await this.decide(approver, award['approvalRequestId'] as string), 201, 'approve award');
    return { ...round, evaluationRows: rows, award, ...(await this.approvedAwardToPurchaseOrder(award['awardId'] as string)) };
  }

  /** Approved award → cost sheet → quote → acceptance → PO acknowledged by supplier A. */
  async approvedAwardToPurchaseOrder(awardId: string): Promise<Omit<SourcedDeal, 'rfqId' | 'itemId' | 'winner' | 'loser' | 'evaluationRows' | 'award'>> {
    const sheet = await this.approvedCostSheet(awardId);
    const quoteId = await this.sentQuote(sheet.costSheetVersionId);
    const accept = { key: `accept-${randomUUID()}`, body: await this.acceptanceBody(quoteId) };
    const accepted = ok(await this.accept(quoteId, accept.key, accept.body), 201, 'accept quote');
    const orderId = accepted['orderId'] as string;
    const pos = await this.issuePurchaseOrders(orderId);
    const purchaseOrderId = pos[0]!['purchaseOrderId'] as string;
    await this.acknowledgePurchaseOrder('supplierA', purchaseOrderId);
    return { awardId, costSheet: sheet, quoteId, accept, order: accepted, orderId, purchaseOrders: pos, purchaseOrderId };
  }

  // ------------------------------------------------------------------ evidence

  /** Audit actions recorded against a subject, oldest first. */
  async auditTrail(subjectId: string): Promise<Array<{ action: string; actor_id: string | null; subject_version: number | null; reason: string | null }>> {
    return this.rows(`SELECT action, actor_id, subject_version, reason FROM platform.audit_event WHERE subject_id = $1 ORDER BY occurred_at, id`, [subjectId]);
  }

  async auditActions(subjectId: string): Promise<string[]> {
    return (await this.auditTrail(subjectId)).map((a) => a.action);
  }

  /** Outbox event types written for an aggregate, oldest first. */
  async events(aggregateId: string): Promise<string[]> {
    return (await this.rows<{ event_type: string }>(`SELECT event_type FROM platform.outbox_event WHERE aggregate_id = $1 ORDER BY occurred_at, id`, [aggregateId])).map((e) => e.event_type);
  }

  /** What the worker would do: dispatch every notified event not yet dispatched. */
  async dispatchNotifications(): Promise<number> {
    const pending = await this.rows<{ id: string }>(
      `SELECT e.id FROM platform.outbox_event e
        WHERE e.event_type = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM communication.notification n WHERE n.source_event_id = e.id)
        ORDER BY e.occurred_at, e.id`,
      [[...NOTIFIED_EVENT_TYPES]],
    );
    for (const { id } of pending) {
      const res = await fetch(`${this.baseUrl}/api/v1/internal/notifications/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SERVICE_TOKEN_HEADER]: mintServiceToken(SERVICE_SECRET, SCAN_WORKER_PRINCIPAL.name) },
        body: JSON.stringify({ eventId: id }),
      });
      if (res.status !== 201) throw new Error(`dispatch ${id}: ${res.status} ${await res.text()}`);
    }
    return pending.length;
  }

  /** In-app notices a person has received: template key and title. */
  async notices(actor: Actor): Promise<Array<{ template_key: string; title: string; body: string }>> {
    return this.rows(`SELECT template_key, title, body FROM communication.notification WHERE recipient_user_id = $1 ORDER BY created_at`, [this.users[actor]]);
  }

  /** Asserts none of the given strings appear anywhere in a response or notice. */
  expectNothingOf(subject: unknown, forbidden: string[], where: string): void {
    const text = JSON.stringify(subject);
    for (const word of forbidden) {
      if (text.includes(word)) throw new Error(`${where} leaks "${word}"`);
    }
  }

  /** A call only the worker may make (service token), e.g. the expiry or deadline sweeps. */
  async service(path: string, body?: Body): Promise<Res> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method: 'POST',
      headers: {
        [SERVICE_TOKEN_HEADER]: mintServiceToken(SERVICE_SECRET, SCAN_WORKER_PRINCIPAL.name),
        origin: 'http://localhost:3000',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Body) : {} };
  }

  // ----------------------------------------------------------------- production (IN-13)

  /** The customer pays the advance through the dev gateway: the order is commercially released. */
  async payAdvance(deal: SourcedDeal): Promise<void> {
    const invoiceId = ((deal.order['invoices'] as Body[])[0]!['invoiceId']) as string;
    const intent = ok(await this.as.approver.post(`/api/v1/invoices/${invoiceId}/pay`), 201, 'start payment');
    const row = await this.one<{ provider_intent_id: string; amount_minor: string }>(`SELECT provider_intent_id, amount_minor FROM finance.payment_intent WHERE id = $1`, [intent['paymentIntentId']]);
    const paid = await this.paymentCallback({ type: 'payment.captured', intentId: row.provider_intent_id, transactionId: `txn_${randomUUID()}`, amountMinor: Number(row.amount_minor) });
    if (paid.body['outcome'] !== 'processed') throw new Error(`advance not processed: ${JSON.stringify(paid.body)}`);
  }

  async productionView(orderId: string): Promise<Body> {
    return ok(await this.as.engineering.get(`/api/v1/sales-orders/${orderId}/production`), 200, 'production view');
  }

  async supplierProduction(supplier: 'supplierA' | 'supplierB', purchaseOrderId: string): Promise<Body> {
    return ok(await this.as[supplier].get(`/api/v1/supplier/purchase-orders/${purchaseOrderId}/production`), 200, 'supplier production view');
  }

  /**
   * A sourced deal taken into production: advance paid, the drawing baselined, transmitted
   * and acknowledged, the work package planned and released, the first milestone started
   * with evidence submitted.
   */
  async intoProduction(deal: SourcedDeal): Promise<{ baselineId: string; workPackageId: string; milestoneId: string; evidenceVersionId: string; qualityPlanId: string }> {
    await this.payAdvance(deal);
    const assembled = ok(await this.as.engineering.post(`/api/v1/sales-orders/${deal.orderId}/baselines`, { items: [{ documentVersionId: this.drawingVersionId, purpose: 'governing' }] }), 201, 'assemble baseline');
    const draft = (assembled['baselines'] as Body[]).find((b) => b['status'] === 'draft')!;
    ok(await this.as.engineering.post(`/api/v1/baselines/${draft['baselineId']}/release`, { expectedVersion: draft['aggregateVersion'] }), 201, 'release baseline');
    ok(await this.as.engineering.post(`/api/v1/sales-orders/${deal.orderId}/transmittals`, { baselineId: draft['baselineId'] }), 201, 'issue transmittals');
    const sv = await this.supplierProduction('supplierA', deal.purchaseOrderId);
    const transmittal = sv['transmittal'] as Body;
    ok(await this.as.supplierA.post(`/api/v1/supplier/transmittals/${transmittal['transmittalId']}/acknowledge`, { expectedVersion: transmittal['aggregateVersion'], note: 'Drawing pack received.' }), 201, 'acknowledge transmittal');
    ok(await this.as.sourcing.post(`/api/v1/purchase-orders/${deal.purchaseOrderId}/work-package`, { plannedStart: daysFromNow(1), plannedFinish: daysFromNow(21) }), 201, 'plan work package');
    let wp = ((await this.productionView(deal.orderId))['workPackages'] as Body[]).find((w) => w['purchaseOrderId'] === deal.purchaseOrderId)!;
    const qualityPlanId = await this.approvedQualityPlan(wp['workPackageId'] as string);
    wp = ((await this.productionView(deal.orderId))['workPackages'] as Body[]).find((w) => w['purchaseOrderId'] === deal.purchaseOrderId)!;
    ok(await this.as.sourcing.post(`/api/v1/work-packages/${wp['workPackageId']}/release`, { expectedVersion: wp['aggregateVersion'] }), 201, 'release work package');
    const first = ((await this.supplierProduction('supplierA', deal.purchaseOrderId))['workPackage'] as Body)['milestones'] as Body[];
    ok(await this.as.supplierA.post(`/api/v1/supplier/milestones/${first[0]!['milestoneId']}/start`, { expectedVersion: first[0]!['aggregateVersion'] }), 201, 'start milestone');
    const evidenceVersionId = await this.cleanDrawing(this.orgs.supplierA);
    const started = ((await this.supplierProduction('supplierA', deal.purchaseOrderId))['workPackage'] as Body)['milestones'] as Body[];
    ok(await this.as.supplierA.post(`/api/v1/supplier/milestones/${started[0]!['milestoneId']}/evidence`, { expectedVersion: started[0]!['aggregateVersion'], items: [{ documentVersionId: evidenceVersionId }] }), 201, 'submit evidence');
    return { baselineId: draft['baselineId'] as string, workPackageId: wp['workPackageId'] as string, milestoneId: started[0]!['milestoneId'] as string, evidenceVersionId, qualityPlanId };
  }

  /**
   * IN-14: JobWork quality writes the work package's plan from the launch template, with two
   * drawing characteristics (a critical bore and a major length), and approves it.
   */
  async approvedQualityPlan(workPackageId: string): Promise<string> {
    const draft = ok(await this.as.quality.post('/api/v1/quality-plans', { workPackageId, templateCode: 'cnc_machined_part' }), 201, 'create quality plan');
    const drawing = [
      { kind: 'variable', drawingReference: '7', name: 'Bore diameter', criticality: 'critical', unit: 'mm', nominal: '12', lower: { value: '11.98', inclusive: true }, upper: { value: '12.02', inclusive: true }, stages: ['fai', 'final'], method: 'Bore gauge', instrumentKind: 'bore_gauge' },
      { kind: 'variable', drawingReference: '12', name: 'Overall length', criticality: 'major', unit: 'mm', nominal: '80', lower: { value: '79.9', inclusive: true }, upper: { value: '80.1', inclusive: true }, stages: ['fai'], method: 'Vernier caliper', instrumentKind: 'caliper' },
    ];
    const saved = ok(
      await this.as.quality.post(`/api/v1/quality-plans/${draft['planId']}/draft`, { expectedVersion: draft['aggregateVersion'], stages: draft['stages'], characteristics: [...(draft['characteristics'] as Body[]), ...drawing] }),
      201,
      'save quality plan',
    );
    ok(await this.as.quality.post(`/api/v1/quality-plans/${draft['planId']}/approve`, { expectedVersion: saved['aggregateVersion'] }), 201, 'approve quality plan');
    return draft['planId'] as string;
  }

  /**
   * IN-14: one inspection of `lot` by supplier A, reviewed and decided by JobWork quality. Every
   * characteristic measures in tolerance except the bore, which is `bore` mm (passes to 12.02).
   */
  async inspection(workPackageId: string, stage: 'fai' | 'final', lot: string, instrumentId: string, bore = '12.006'): Promise<Body> {
    let i = ok(await this.as.quality.post('/api/v1/inspections', { workPackageId, stage, lot }), 201, `plan ${stage}`);
    i = ok(await this.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/start`, { expectedVersion: i['aggregateVersion'] }), 201, 'start inspection');
    const samples = Array.from({ length: i['sampleSize'] as number }, (_, k) => k + 1);
    const value = (name: string): Body =>
      name.startsWith('Visual')
        ? { measurement: { value: 'conforming', unit: null, declaredPrecision: null } }
        : name.startsWith('Surface')
          ? { measurement: { value: '1.6', unit: 'um', declaredPrecision: 1 }, instrumentId }
          : name === 'Bore diameter'
            ? { measurement: { value: bore, unit: 'mm', declaredPrecision: 3 }, instrumentId }
            : { measurement: { value: '80.00', unit: 'mm', declaredPrecision: 2 }, instrumentId };
    i = ok(
      await this.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/results`, {
        expectedVersion: i['aggregateVersion'],
        inspectedAt: new Date().toISOString(),
        samples: samples.map((n) => ({ sampleNo: n, lot })),
        results: samples.flatMap((n) => (i['characteristics'] as Body[]).map((c) => ({ sampleNo: n, characteristicId: c['characteristicId'], ...value(c['name'] as string) }))),
      }),
      201,
      'submit results',
    );
    i = ok(await this.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/review`, { expectedVersion: i['aggregateVersion'] }), 201, 'review');
    const pass = Number(bore) <= 12.02;
    return ok(await this.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/decide`, { expectedVersion: i['aggregateVersion'], decision: pass ? 'passed' : 'failed', reason: pass ? '' : 'Bore oversize' }), 201, 'decide');
  }

  /** IN-14: a calibrated bore gauge of supplier A's. */
  async calibratedGauge(): Promise<string> {
    const made = ok(await this.as.supplierA.post('/api/v1/supplier/instruments', { assetTag: `BG-${randomUUID().slice(0, 8)}`, kind: 'Bore gauge', unit: 'mm' }), 201, 'instrument');
    ok(
      await this.as.supplierA.post(`/api/v1/supplier/instruments/${made['instrumentId']}/calibrations`, { performedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), dueAt: new Date(Date.now() + 300 * 86_400_000).toISOString(), outcome: 'pass', certificateDocumentVersionId: await this.cleanDrawing(this.orgs.supplierA) }),
      201,
      'calibrate',
    );
    return made['instrumentId'] as string;
  }

  /**
   * IN-15: lots of a work package in production inspected (FAI on the first), its milestones
   * verified or waived, and each lot quality released on its own. Returns the gauge.
   */
  async releasedLots(deal: SourcedDeal, workPackageId: string, lots: Array<{ lot: string; quantity: string }>): Promise<string> {
    const gauge = await this.calibratedGauge();
    for (const [n, { lot }] of lots.entries()) {
      if (n === 0) await this.inspection(workPackageId, 'fai', lot, gauge);
      await this.inspection(workPackageId, 'final', lot, gauge);
    }
    for (;;) {
      const wp = ((await this.productionView(deal.orderId))['workPackages'] as Body[]).find((w) => w['workPackageId'] === workPackageId)!;
      const m = (wp['milestones'] as Body[]).find((x) => x['status'] !== 'verified' && x['status'] !== 'waived');
      if (!m) break;
      if (m['status'] === 'evidence_submitted') ok(await this.as.quality.post(`/api/v1/milestones/${m['milestoneId']}/verify`, { expectedVersion: m['aggregateVersion'], decision: 'verified' }), 201, 'verify milestone');
      else ok(await this.as.quality.post(`/api/v1/milestones/${m['milestoneId']}/waive`, { expectedVersion: m['aggregateVersion'], reason: 'Covered by the final inspection on record.' }), 201, 'waive milestone');
    }
    for (const { lot, quantity } of lots) ok(await this.as.quality.post('/api/v1/quality-releases', { workPackageId, quantity, lots: [lot], serials: [] }), 201, `release ${lot}`);
    return gauge;
  }

  /** IN-16: a leg-1 shipment from supplier A planned, submitted, released by logistics and picked up. */
  async shippedToJobWork(purchaseOrderId: string, packages: Body[], trackingReference = `LR-${randomUUID().slice(0, 8)}`): Promise<Body> {
    let s = ok(
      await this.as.supplierA.post('/api/v1/supplier/shipments', { purchaseOrderId, originSiteId: this.sites.supplierA, packages, documents: { challanNumber: 'DC-201', eWaybillNumber: '1811 0000 0001' } }),
      201,
      'plan shipment',
    );
    s = ok(await this.as.supplierA.post(`/api/v1/supplier/shipments/${s['shipmentId']}/submit`, { expectedVersion: s['aggregateVersion'] }), 201, 'submit shipment');
    s = ok(await this.as.logistics.post(`/api/v1/shipments/${s['shipmentId']}/release`, { expectedVersion: s['aggregateVersion'] }), 201, 'release shipment');
    return ok(await this.as.supplierA.post(`/api/v1/supplier/shipments/${s['shipmentId']}/pickup`, { expectedVersion: s['aggregateVersion'], carrierMode: 'carrier', carrierName: 'Safe Carriers', trackingReference }), 201, 'pickup');
  }

  /**
   * A new version of an existing document, uploaded and scanned the way the product does
   * it: initiate with the document id, PUT the bytes, finalize, then the scanner's verdict.
   * Needs the object store.
   */
  async uploadRevision(client: TestClient, documentId: string, filename: string): Promise<{ documentVersionId: string; versionNo: number }> {
    const env = { endpoint: process.env['OBJECT_STORE_ENDPOINT'] ?? 'http://localhost:9000', accessKeyId: process.env['OBJECT_STORE_ACCESS_KEY'] ?? 'minioadmin', secretAccessKey: process.env['OBJECT_STORE_SECRET_KEY'] ?? 'minioadmin', region: process.env['OBJECT_STORE_REGION'] ?? 'us-east-1' };
    for (const bucket of [process.env['OBJECT_STORE_BUCKET_QUARANTINE'] ?? 'jobwork-quarantine', process.env['OBJECT_STORE_BUCKET_CLEAN'] ?? 'jobwork-clean']) {
      const signed = signRequest({ accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey, region: env.region }, { endpoint: env.endpoint, objectPath: bucket, method: 'PUT' });
      const res = await fetch(signed.url, { method: 'PUT', headers: signed.headers });
      if (!res.ok && res.status !== 409) throw new Error(`object store not reachable: ${res.status}`);
    }
    const bytes = Buffer.from(`%PDF-1.4\n% ${filename} ${randomUUID()}\n%%EOF\n`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const init = ok(await client.post('/api/v1/documents/uploads', { purpose: 'drawing_2d', filename, declaredMediaType: 'application/pdf', byteSize: bytes.length, sha256, documentId }), 201, 'initiate revision upload');
    const grant = init['grant'] as { method: string; url: string; headers: Record<string, string> };
    const put = await fetch(grant.url, { method: grant.method, headers: grant.headers, body: bytes });
    if (!put.ok) throw new Error(`revision PUT failed: ${put.status}`);
    const fin = ok(await client.post(`/api/v1/documents/uploads/${init['uploadSessionId']}/finalize`, { byteSize: bytes.length, sha256 }), 201, 'finalize revision');
    const file = await this.one<{ id: string }>(`SELECT file_object_id AS id FROM dms.document_version WHERE id = $1`, [fin['documentVersionId']]);
    ok(await this.service(`/internal/documents/scans/${file.id}/begin`), 201, 'scan begin');
    ok(await this.service(`/internal/documents/scans/${file.id}/result`, { verdict: 'clean', reason: 'clean', detectedMediaType: 'application/pdf', scanner: { name: 'test-scanner', version: '1' } }), 201, 'scan result');
    return { documentVersionId: fin['documentVersionId'] as string, versionNo: fin['versionNo'] as number };
  }

  /** Signs and posts a provider callback the way the dev gateway does. */
  async paymentCallback(event: { id?: string; type: string; intentId: string; transactionId: string; amountMinor: number }, opts: { ageSeconds?: number } = {}): Promise<Res> {
    const id = event.id ?? `evt_${randomUUID()}`;
    const body = JSON.stringify({ id, type: event.type, data: { intentId: event.intentId, transactionId: event.transactionId, amountMinor: event.amountMinor, currency: 'INR', occurredAt: new Date().toISOString() } });
    const ts = String(Math.floor(Date.now() / 1000) - (opts.ageSeconds ?? 0));
    const res = await fetch(`${this.baseUrl}/api/v1/webhooks/payments/dev`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dev-signature': createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex'),
        'x-dev-timestamp': ts,
        'x-dev-delivery-id': id,
      },
      body,
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Body) : {} };
  }
}

export interface SourcedDeal {
  rfqId: string;
  itemId: string;
  winner: { bidVersionId: string };
  loser?: { bidVersionId: string } | undefined;
  evaluationRows: Body[];
  awardId: string;
  award: Body;
  costSheet: { costSheetId: string; costSheetVersionId: string; version: Body };
  quoteId: string;
  /** The exact acceptance request, so a scenario can replay it. */
  accept: { key: string; body: Body };
  order: Body;
  orderId: string;
  purchaseOrders: Body[];
  purchaseOrderId: string;
}
