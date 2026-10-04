import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'customer-portal-password-1';
const SESSION_COOKIE = 'jw_session';

/**
 * F-CX: the customer's own surface. These cases guard the three things the audit found
 * missing — an address the enquiry can actually name, work the customer can withdraw or
 * repeat without asking JobWork, and a summary that counts only their own organization.
 */
describe('Customer portal (F-CX)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let customer: TestClient;
  let otherCustomer: TestClient;
  let sourcing: TestClient;
  let millingId: string;
  let aluminiumId: string;
  let customerOrgId: string;
  let otherOrgId: string;

  function totpCode(secret: string, email: string): string {
    return new OTPAuth.TOTP({
      issuer: 'JobWork',
      label: email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    }).generate();
  }

  async function seedOrg(type: string, name: string): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ($1, $2, $2) RETURNING id`,
      [type, name],
    );
    return res.rows[0]!.id;
  }

  async function seedUser(orgId: string, email: string, roles: string[]): Promise<void> {
    const user = await pg.query<{ id: string }>(
      `INSERT INTO iam.user_account
         (email, password_hash, password_params_version, display_name, status, email_verified_at)
       VALUES ($1, $2, 1, 'Member', 'active', now()) RETURNING id`,
      [email, await hashPassword(PASSWORD)],
    );
    const membership = await pg.query<{ id: string }>(
      `INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`,
      [user.rows[0]!.id, orgId],
    );
    await pg.query(
      `INSERT INTO iam.membership_role (membership_id, role_id)
       SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`,
      [membership.rows[0]!.id, roles],
    );
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
    await first.post('/api/v1/account/mfa/activate', {
      code: totpCode(enroll.body['secret'] as string, email),
    });
    const fresh = new TestClient(baseUrl);
    await fresh.post('/api/v1/auth/login', { email, password: PASSWORD });
    const secret = await pg.query<{ mfa_totp_secret: string }>(
      `SELECT mfa_totp_secret FROM iam.user_account WHERE email = $1`,
      [email],
    );
    await fresh.post('/api/v1/auth/mfa', { code: totpCode(secret.rows[0]!.mfa_totp_secret, email) });
    return fresh;
  }

  /** A scan-clean document version the organization owns, so a draft can be submitted. */
  async function seedDocument(orgId: string): Promise<string> {
    const doc = await pg.query<{ id: string }>(
      `INSERT INTO dms.document (owning_organization_id, logical_type, title)
       VALUES ($1, 'drawing_2d', 'Bracket drawing') RETURNING id`,
      [orgId],
    );
    const file = await pg.query<{ id: string }>(
      `INSERT INTO dms.file_object
         (storage_key, byte_size, declared_media_type, sha256, scan_state, owning_organization_id)
       VALUES ($1, 2048, 'application/pdf', $2, 'clean', $3) RETURNING id`,
      [`clean/${randomBytes(8).toString('hex')}`, randomBytes(32).toString('hex'), orgId],
    );
    const version = await pg.query<{ id: string }>(
      `INSERT INTO dms.document_version
         (document_id, version_no, file_object_id, original_filename, status, created_by)
       VALUES ($1, 1, $2, 'bracket.pdf', 'available', gen_random_uuid()) RETURNING id`,
      [doc.rows[0]!.id, file.rows[0]!.id],
    );
    return version.rows[0]!.id;
  }

  /** A draft complete enough to submit — the whole requirement, as doc 06 §3 asks. */
  async function draft(
    client: TestClient,
    title: string,
    extra: Record<string, unknown> = {},
    orgId = customerOrgId,
  ): Promise<Record<string, unknown>> {
    const res = await client.post('/api/v1/enquiries/draft', {
      title,
      applicationNote: 'Mounts the drive motor on a centrifugal pump skid.',
      confidentiality: 'confidential',
      assistedIntake: false,
      requiredByDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      partialDelivery: 'not_allowed',
      packagingNote: '',
      items: [
        {
          lineNo: 1,
          partName: 'Bracket',
          description: 'Machined aluminium bracket',
          processCapabilityId: millingId,
          materialCapabilityId: aluminiumId,
          materialGrade: '6061-T6',
          quantityBreakpoints: [{ quantity: 10, unit: 'piece', kind: 'production' }],
          toleranceClass: 'IT8',
          criticalTolerance: { value: 0.05, unit: 'mm' },
          inspectionLevel: 'dimensional_report',
        },
      ],
      documents: [{ documentVersionId: await seedDocument(orgId), role: 'governing', lineNo: 1 }],
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body as Record<string, unknown>;
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_customer');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['SESSION_COOKIE_NAME'] = SESSION_COOKIE;
    process.env['NODE_ENV'] = 'test';

    pg = new Client({ connectionString: db.url });
    await pg.connect();
    customerOrgId = await seedOrg('customer', 'Kovai Hydraulics');
    otherOrgId = await seedOrg('customer', 'Rival Pumps');
    const internalOrgId = await seedOrg('internal', 'JobWork Operations');
    await seedUser(customerOrgId, 'buyer@kovai.test', ['customer_requester']);
    await seedUser(otherOrgId, 'buyer@rival.test', ['customer_requester']);
    await seedUser(internalOrgId, 'sourcing@jobwork.test', ['jobwork_sourcing']);

    const capabilities = await pg.query<{ id: string; code: string }>(
      `SELECT id, code FROM supplier.capability
        WHERE code IN ('cnc_milling', 'material_aluminium')`,
    );
    millingId = capabilities.rows.find((row) => row.code === 'cnc_milling')!.id;
    aluminiumId = capabilities.rows.find((row) => row.code === 'material_aluminium')!.id;

    ({ app, baseUrl } = await createTestApp());
    customer = await signIn('buyer@kovai.test');
    otherCustomer = await signIn('buyer@rival.test');
    sourcing = await signInWithMfa('sourcing@jobwork.test');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('keeps an address book scoped to the organization that owns it', async () => {
    const created = await customer.post('/api/v1/organizations/me/sites', {
      label: 'Ambattur plant',
      addressLine1: '4 SIDCO Industrial Estate',
      city: 'Chennai',
      state: 'Tamil Nadu',
      postalCode: '600098',
      contactName: 'Stores',
      contactPhone: '+91 90000 33333',
    });
    expect(created.status).toBe(201);
    const siteId = created.body['siteId'] as string;

    const mine = await customer.get('/api/v1/organizations/me/sites');
    expect((mine.body['sites'] as unknown[]).length).toBe(1);

    // Another customer sees nothing of it, and cannot archive it.
    const theirs = await otherCustomer.get('/api/v1/organizations/me/sites');
    expect(theirs.body['sites']).toEqual([]);
    expect((await otherCustomer.post(`/api/v1/organizations/me/sites/${siteId}/archive`, {})).status).toBe(
      404,
    );

    // Editing keeps the id; archiving hides it from the default list but not from history.
    const edited = await customer.post('/api/v1/organizations/me/sites', {
      siteId,
      label: 'Ambattur plant',
      addressLine1: '4 SIDCO Industrial Estate, Gate 2',
      city: 'Chennai',
      state: 'Tamil Nadu',
      postalCode: '600098',
    });
    expect(edited.body['siteId']).toBe(siteId);
    expect(edited.body['addressLine1']).toContain('Gate 2');

    expect((await customer.post(`/api/v1/organizations/me/sites/${siteId}/archive`, {})).status).toBe(
      201,
    );
    expect((await customer.get('/api/v1/organizations/me/sites')).body['sites']).toEqual([]);
    const withArchived = await customer.get('/api/v1/organizations/me/sites?includeArchived=true');
    expect((withArchived.body['sites'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      siteId,
      status: 'archived',
    });
  });

  it('lets an enquiry name a delivery address, and only its own', async () => {
    const site = await customer.post('/api/v1/organizations/me/sites', {
      label: 'Delivery gate',
      addressLine1: '12 Anna Salai',
      city: 'Chennai',
      state: 'Tamil Nadu',
      postalCode: '600002',
    });
    const siteId = site.body['siteId'] as string;

    const mine = await draft(customer, 'Ships somewhere real', { deliverySiteId: siteId });
    expect(mine['deliverySiteId']).toBe(siteId);

    // A site belonging to somebody else is refused, and says so in the customer's words.
    const refused = await otherCustomer.post('/api/v1/enquiries/draft', {
      title: 'Ships to a stranger',
      applicationNote: '',
      confidentiality: 'confidential',
      assistedIntake: false,
      partialDelivery: 'not_allowed',
      packagingNote: '',
      items: [],
      documents: [],
      deliverySiteId: siteId,
    });
    // 422, not 404: the address exists, it is simply not theirs to ship to.
    expect(refused.status).toBe(422);
    expect(refused.body['code']).toBe('DELIVERY_SITE_NOT_USABLE');
  });

  it('lets a customer withdraw what they raised and repeat what they ordered', async () => {
    const unwanted = await draft(customer, 'Raised by mistake');
    const discarded = await customer.post(
      `/api/v1/enquiries/${unwanted['enquiryId'] as string}/cancel`,
      { expectedVersion: unwanted['aggregateVersion'], reason: 'Duplicate of last week' },
    );
    expect(discarded.status).toBe(201);
    expect(discarded.body['status']).toBe('cancelled');

    const wanted = await draft(customer, 'Ordered before');
    const submitted = await customer.post(
      `/api/v1/enquiries/${wanted['enquiryId'] as string}/submit`,
      { expectedVersion: wanted['aggregateVersion'] },
    );
    expect(submitted.status).toBe(201);

    const copy = await customer.post(
      `/api/v1/enquiries/${submitted.body['enquiryId'] as string}/copy`,
      {},
    );
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ status: 'draft', reference: null });
    expect(copy.body['copiedFromEnquiryId']).toBe(submitted.body['enquiryId']);
    expect((copy.body['items'] as unknown[]).length).toBe(1);

    // Another customer can neither copy nor cancel work that is not theirs.
    expect(
      (await otherCustomer.post(`/api/v1/enquiries/${submitted.body['enquiryId'] as string}/copy`, {}))
        .status,
    ).toBe(404);
  });

  it('keeps withdrawn work out of the list without losing it', async () => {
    const doomed = await draft(customer, 'Withdrawn from the list');
    await customer.post(`/api/v1/enquiries/${doomed['enquiryId'] as string}/cancel`, {
      expectedVersion: doomed['aggregateVersion'],
      reason: 'Changed our minds',
    });

    const defaultList = await customer.get('/api/v1/enquiries');
    const titles = (defaultList.body['enquiries'] as Array<Record<string, unknown>>).map(
      (enquiry) => enquiry['title'],
    );
    expect(titles).not.toContain('Withdrawn from the list');

    // Kept, not deleted: the customer can still go and look.
    const withCancelled = await customer.get('/api/v1/enquiries?includeCancelled=true');
    const allTitles = (withCancelled.body['enquiries'] as Array<Record<string, unknown>>).map(
      (enquiry) => enquiry['title'],
    );
    expect(allTitles).toContain('Withdrawn from the list');
  });

  it('summarises the caller\'s own queue and nobody else\'s', async () => {
    const summary = await customer.get('/api/v1/portal/summary');
    expect(summary.status).toBe(200);
    const queues = summary.body['queues'] as Array<Record<string, unknown>>;
    const byKey = new Map(queues.map((queue) => [queue['key'], queue]));

    const drafts = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sourcing.enquiry e
         JOIN iam.organization o ON o.id = e.customer_organization_id
        WHERE o.display_name = 'Kovai Hydraulics' AND e.status = 'draft'`,
    );
    expect(byKey.get('drafts_unfinished')!['count']).toBe(Number(drafts.rows[0]!.n));
    expect(byKey.get('enquiries_in_progress')!['count']).toBeGreaterThanOrEqual(1);

    // The other customer's numbers are their own.
    const theirs = await otherCustomer.get('/api/v1/portal/summary');
    const theirQueues = theirs.body['queues'] as Array<Record<string, unknown>>;
    expect(theirQueues.find((queue) => queue['key'] === 'enquiries_in_progress')!['count']).toBe(0);

    // Internal staff have the operations summary; this one is not theirs to read.
    expect((await sourcing.get('/api/v1/portal/summary')).status).toBe(403);
  });

  it('counts a question as waiting the moment it is asked, and stops when answered', async () => {
    const enquiry = await draft(customer, 'Will be questioned');
    const submitted = await customer.post(
      `/api/v1/enquiries/${enquiry['enquiryId'] as string}/submit`,
      { expectedVersion: enquiry['aggregateVersion'] },
    );
    const enquiryId = submitted.body['enquiryId'] as string;

    const triaged = await sourcing.post(`/api/v1/intake/${enquiryId}/triage`, {
      expectedVersion: submitted.body['aggregateVersion'],
    });
    expect(triaged.status).toBe(201);
    // The customer's own view is a curated projection with no aggregate version in it —
    // that is the point of the projection — so the reviewer reads the version to send.
    const asked = await sourcing.post(`/api/v1/intake/${enquiryId}/clarifications`, {
      expectedVersion: triaged.body['aggregateVersion'],
      questions: [{ topic: 'material', question: 'Which aluminium grade?' }],
    });
    expect(asked.status).toBe(201);

    const waiting = await customer.get('/api/v1/portal/summary');
    const questions = (waiting.body['queues'] as Array<Record<string, unknown>>).find(
      (queue) => queue['key'] === 'questions_awaiting_answer',
    )!;
    expect(questions['count']).toBe(1);
    expect(questions['oldestWaitingSince']).not.toBeNull();

    const detail = await customer.get(`/api/v1/enquiries/${enquiryId}`);
    const clarifications = detail.body['clarifications'] as Array<Record<string, unknown>>;
    await customer.post(`/api/v1/enquiries/${enquiryId}/clarifications`, {
      answers: [
        { clarificationId: clarifications[0]!['clarificationId'], answer: '6061-T6, mill certified.' },
      ],
    });

    const settled = await customer.get('/api/v1/portal/summary');
    expect(
      (settled.body['queues'] as Array<Record<string, unknown>>).find(
        (queue) => queue['key'] === 'questions_awaiting_answer',
      )!['count'],
    ).toBe(0);
  });
});
