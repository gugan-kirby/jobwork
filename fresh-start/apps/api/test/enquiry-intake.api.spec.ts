import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'enquiry-test-password-1';

describe('Enquiry intake and triage (IN-05)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let customerOrgId: string;
  let otherCustomerOrgId: string;
  let customer: TestClient;
  let otherCustomer: TestClient;
  let sourcing: TestClient;

  let millingId: string;
  let aluminiumId: string;

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

  async function seedOrg(type: 'customer' | 'internal', name: string): Promise<string> {
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
    await fresh.post('/api/v1/auth/mfa', {
      code: totpCode(secret.rows[0]!.mfa_totp_secret, email),
    });
    return fresh;
  }

  /** A scan-clean document version the customer organization owns. */
  async function seedDocument(
    orgId: string,
    logicalType: 'cad_3d' | 'drawing_2d' | 'image' | 'specification',
  ): Promise<string> {
    const doc = await pg.query<{ id: string }>(
      `INSERT INTO dms.document (owning_organization_id, logical_type, title)
       VALUES ($1, $2, $3) RETURNING id`,
      [orgId, logicalType, `${logicalType} sample`],
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
       VALUES ($1, 1, $2, 'part.pdf', 'available', gen_random_uuid()) RETURNING id`,
      [doc.rows[0]!.id, file.rows[0]!.id],
    );
    return version.rows[0]!.id;
  }

  function completeDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      title: 'Pump mounting bracket',
      applicationNote: 'Mounts the drive motor on a centrifugal pump skid.',
      requiredByDate: '2026-11-30',
      items: [
        {
          lineNo: 1,
          partName: 'Bracket',
          description: 'Machined aluminium bracket',
          processCapabilityId: millingId,
          materialCapabilityId: aluminiumId,
          materialGrade: '6061-T6',
          quantityBreakpoints: [
            { quantity: 10, unit: 'piece', kind: 'prototype' },
            { quantity: 500, unit: 'piece', kind: 'production' },
          ],
          toleranceClass: 'IT8',
          criticalTolerance: { value: 0.05, unit: 'mm' },
          inspectionLevel: 'dimensional_report',
        },
      ],
      ...overrides,
    };
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_enquiry');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['NODE_ENV'] = 'test';

    pg = new Client({ connectionString: db.url });
    await pg.connect();
    customerOrgId = await seedOrg('customer', 'Kovai Pumps');
    otherCustomerOrgId = await seedOrg('customer', 'Rival Machines');
    const internalOrgId = await seedOrg('internal', 'JobWork Operations');
    await seedUser(customerOrgId, 'buyer@kovai.test', ['customer_requester']);
    await seedUser(otherCustomerOrgId, 'buyer@rival.test', ['customer_requester']);
    await seedUser(internalOrgId, 'sourcing@jobwork.test', ['jobwork_sourcing']);

    const capabilities = await pg.query<{ id: string; code: string }>(
      `SELECT id, code FROM supplier.capability WHERE code IN ('cnc_milling', 'material_aluminium')`,
    );
    millingId = capabilities.rows.find((r) => r.code === 'cnc_milling')!.id;
    aluminiumId = capabilities.rows.find((r) => r.code === 'material_aluminium')!.id;

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

  // ---------------------------------------------------------------- F-05.2

  it('refuses to submit without the mandatory category fields, naming each field path', async () => {
    const draft = await customer.post('/api/v1/enquiries/draft', {
      title: '',
      items: [{ lineNo: 1, partName: '', quantityBreakpoints: [] }],
    });
    expect(draft.status).toBe(201);
    const enquiryId = draft.body['enquiryId'] as string;

    const submit = await customer.post(`/api/v1/enquiries/${enquiryId}/submit`, {
      expectedVersion: draft.body['aggregateVersion'] as number,
    });
    expect(submit.status).toBe(422);
    expect(submit.body['code']).toBe('ENQUIRY_INCOMPLETE');

    const paths = (submit.body['errors'] as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('title');
    expect(paths).toContain('items[1].partName');
    expect(paths).toContain('items[1].quantityBreakpoints');
    expect(paths).toContain('items[1].processCapabilityId');
    expect(paths).toContain('items[1].materialCapabilityId');
    expect(paths).toContain('documents');
    expect(paths).toContain('requiredByDate');

    // Nothing was frozen and nothing was numbered: a refused submit leaves no trace
    // that a later citation could point at.
    const revisions = await pg.query(`SELECT 1 FROM sourcing.requirement WHERE enquiry_id = $1`, [
      enquiryId,
    ]);
    expect(revisions.rowCount).toBe(0);
    const row = await pg.query<{ status: string; reference: string | null }>(
      `SELECT status, reference FROM sourcing.enquiry WHERE id = $1`,
      [enquiryId],
    );
    expect(row.rows[0]!.status).toBe('draft');
    expect(row.rows[0]!.reference).toBeNull();
  });

  it('lets two people edit one draft only if the second one sees the first ones change', async () => {
    const created = await customer.post('/api/v1/enquiries/draft', { title: 'Shared draft' });
    const enquiryId = created.body['enquiryId'] as string;
    const staleVersion = created.body['aggregateVersion'] as number;

    // Two wizards open on the same draft, both holding version N.
    const first = await customer.post(`/api/v1/enquiries/${enquiryId}/draft`, {
      title: 'Edited by the buyer',
      expectedVersion: staleVersion,
    });
    expect(first.status).toBe(201);

    const second = await customer.post(`/api/v1/enquiries/${enquiryId}/draft`, {
      title: 'Edited by a colleague',
      expectedVersion: staleVersion,
    });
    expect(second.status).toBe(409);
    expect(second.body['code']).toBe('VERSION_CONFLICT');
    // The message has to tell them what to do, not merely that something went wrong.
    expect(second.body['detail']).toContain('Reload');

    const stored = await pg.query<{ title: string }>(
      `SELECT title FROM sourcing.enquiry WHERE id = $1`,
      [enquiryId],
    );
    expect(stored.rows[0]!.title).toBe('Edited by the buyer');

    // Reloading and retrying against the current version succeeds.
    const retry = await customer.post(`/api/v1/enquiries/${enquiryId}/draft`, {
      title: 'Edited by a colleague',
      expectedVersion: first.body['aggregateVersion'] as number,
    });
    expect(retry.status).toBe(201);
  });

  it('freezes an immutable intake revision and allocates a reference at submit', async () => {
    const drawing = await seedDocument(customerOrgId, 'drawing_2d');
    const created = await customer.post('/api/v1/enquiries/draft', {
      ...completeDraft(),
      documents: [{ documentVersionId: drawing, role: 'governing', lineNo: 1 }],
    });
    const enquiryId = created.body['enquiryId'] as string;

    const submitted = await customer.post(`/api/v1/enquiries/${enquiryId}/submit`, {
      expectedVersion: created.body['aggregateVersion'] as number,
    });
    expect(submitted.status).toBe(201);
    expect(submitted.body['status']).toBe('submitted');
    expect(submitted.body['reference']).toMatch(/^ENQ-\d{4}-\d{4}$/);
    expect(submitted.body['submittedRevisionNo']).toBe(1);

    const revision = await pg.query<{ kind: string; content_hash: string; snapshot: { items: unknown[] } }>(
      `SELECT kind, content_hash, snapshot FROM sourcing.requirement
        WHERE enquiry_id = $1 AND revision_no = 1`,
      [enquiryId],
    );
    expect(revision.rows[0]!.kind).toBe('intake');
    expect(revision.rows[0]!.content_hash).toHaveLength(64);
    expect(revision.rows[0]!.snapshot.items).toHaveLength(1);

    // The frozen revision is beyond reach of any later write, by trigger.
    await expect(
      pg.query(`UPDATE sourcing.requirement SET snapshot = '{}'::jsonb WHERE enquiry_id = $1`, [
        enquiryId,
      ]),
    ).rejects.toThrow(/immutable/);

    // A submitted enquiry is no longer a draft to be edited.
    const edit = await customer.post(`/api/v1/enquiries/${enquiryId}/draft`, {
      title: 'Sneaky change',
      expectedVersion: submitted.body['aggregateVersion'] as number,
    });
    expect(edit.status).toBe(409);
    expect(edit.body['code']).toBe('DRAFT_NOT_EDITABLE');
  });

  it('accepts the assisted path on a photo alone but still demands a part and a quantity', async () => {
    const photo = await seedDocument(customerOrgId, 'image');
    const created = await customer.post('/api/v1/enquiries/draft', {
      title: 'Broken cover plate — please advise',
      assistedIntake: true,
      requiredByDate: '2026-12-15',
      items: [
        {
          lineNo: 1,
          partName: 'Cover plate',
          description: 'Photo of the failed part, no drawing available',
          quantityBreakpoints: [{ quantity: 4, unit: 'piece', kind: 'production' }],
        },
      ],
      documents: [{ documentVersionId: photo, role: 'assisted_photo' }],
    });
    const enquiryId = created.body['enquiryId'] as string;

    const submitted = await customer.post(`/api/v1/enquiries/${enquiryId}/submit`, {
      expectedVersion: created.body['aggregateVersion'] as number,
    });
    // No process, no material, no drawing — and it is accepted, because assisted
    // intake is exactly the case where the customer cannot supply those.
    expect(submitted.status).toBe(201);
    expect(submitted.body['assistedIntake']).toBe(true);

    // The relaxation is bounded: with no quantity at all it is still refused.
    const vague = await customer.post('/api/v1/enquiries/draft', {
      title: 'Something like this',
      assistedIntake: true,
      requiredByDate: '2026-12-15',
      items: [{ lineNo: 1, partName: 'Thing', quantityBreakpoints: [] }],
      documents: [{ documentVersionId: await seedDocument(customerOrgId, 'image'), role: 'assisted_photo' }],
    });
    const refused = await customer.post(`/api/v1/enquiries/${vague.body['enquiryId'] as string}/submit`, {
      expectedVersion: vague.body['aggregateVersion'] as number,
    });
    expect(refused.status).toBe(422);
    expect(
      (refused.body['errors'] as Array<{ path: string }>).map((e) => e.path),
    ).toContain('items[1].quantityBreakpoints');
  });

  it('copies an enquiry back to draft without its dates or its reference', async () => {
    const drawing = await seedDocument(customerOrgId, 'drawing_2d');
    const created = await customer.post('/api/v1/enquiries/draft', {
      ...completeDraft({ title: 'Reorder me' }),
      documents: [{ documentVersionId: drawing, role: 'governing', lineNo: 1 }],
    });
    const sourceId = created.body['enquiryId'] as string;
    await customer.post(`/api/v1/enquiries/${sourceId}/submit`, {
      expectedVersion: created.body['aggregateVersion'] as number,
    });

    const copy = await customer.post(`/api/v1/enquiries/${sourceId}/copy`, {});
    expect(copy.status).toBe(201);
    expect(copy.body['status']).toBe('draft');
    expect(copy.body['reference']).toBeNull();
    expect(copy.body['copiedFromEnquiryId']).toBe(sourceId);
    // Last year's required-by date must not be inherited into this year's order.
    expect(copy.body['requiredByDate']).toBeNull();
    expect(copy.body['items']).toHaveLength(1);
    expect(copy.body['documents']).toHaveLength(1);

    // The copy has to go through submit itself: it has frozen nothing.
    const revisions = await pg.query(
      `SELECT 1 FROM sourcing.requirement WHERE enquiry_id = $1`,
      [copy.body['enquiryId'] as string],
    );
    expect(revisions.rowCount).toBe(0);
  });

  // ---------------------------------------------------------------- F-MX.1 job types

  it('defaults a plain enquiry to job work on customer-supplied material and says so to the customer', async () => {
    const created = await customer.post('/api/v1/enquiries/draft', completeDraft());
    expect(created.status).toBe(201);
    expect(created.body['jobType']).toBe('job_work');
    expect(created.body['materialSupply']).toBe('customer_supplied');

    const asNewModel = await customer.post(
      `/api/v1/enquiries/${created.body['enquiryId'] as string}/draft`,
      { ...completeDraft(), jobType: 'new_model', expectedVersion: created.body['aggregateVersion'] },
    );
    expect(asNewModel.body['materialSupply']).toBe('to_be_sourced');

    const list = await customer.get('/api/v1/enquiries');
    const mine = (list.body['enquiries'] as Array<Record<string, unknown>>).find(
      (e) => e['enquiryId'] === created.body['enquiryId'],
    )!;
    expect(mine['jobType']).toBe('new_model');
    expect(mine['jobTypeLabel']).toBe('New model');
  });

  it('refuses to submit a correction without its change reference and description', async () => {
    const drawing = await seedDocument(customerOrgId, 'drawing_2d');
    const created = await customer.post('/api/v1/enquiries/draft', {
      ...completeDraft({ title: 'Bracket rev B' }),
      jobType: 'correction_ecn',
      documents: [{ documentVersionId: drawing, role: 'governing', lineNo: 1 }],
    });
    const enquiryId = created.body['enquiryId'] as string;

    const refused = await customer.post(`/api/v1/enquiries/${enquiryId}/submit`, {
      expectedVersion: created.body['aggregateVersion'] as number,
    });
    expect(refused.status).toBe(422);
    const paths = (refused.body['errors'] as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('changeReference');
    expect(paths).toContain('changeDescription');

    const completed = await customer.post(`/api/v1/enquiries/${enquiryId}/draft`, {
      ...completeDraft({ title: 'Bracket rev B' }),
      jobType: 'correction_ecn',
      changeReference: 'ECN-0042',
      changeDescription: 'Slot width 8 mm → 8.5 mm; added chamfer on mounting face.',
      documents: [{ documentVersionId: drawing, role: 'governing', lineNo: 1 }],
      expectedVersion: created.body['aggregateVersion'],
    });
    const submitted = await customer.post(`/api/v1/enquiries/${enquiryId}/submit`, {
      expectedVersion: completed.body['aggregateVersion'] as number,
    });
    expect(submitted.status).toBe(201);
    expect(submitted.body['jobType']).toBe('correction_ecn');

    // The change is part of what was asked for, so it is inside the frozen revision.
    const revision = await pg.query<{ snapshot: Record<string, unknown> }>(
      `SELECT snapshot FROM sourcing.requirement WHERE enquiry_id = $1 AND revision_no = 1`,
      [enquiryId],
    );
    expect(revision.rows[0]!.snapshot['jobType']).toBe('correction_ecn');
    expect(revision.rows[0]!.snapshot['changeReference']).toBe('ECN-0042');
  });

  it('lets a correction point only at the customers own enquiry', async () => {
    const theirs = await otherCustomer.post('/api/v1/enquiries/draft', { title: 'Not yours' });
    const attempt = await customer.post('/api/v1/enquiries/draft', {
      title: 'Correcting a stranger',
      jobType: 'correction_ecn',
      relatedEnquiryId: theirs.body['enquiryId'],
    });
    expect(attempt.status).toBe(422);
    expect(attempt.body['code']).toBe('RELATED_ENQUIRY_NOT_USABLE');

    const ghost = await customer.post('/api/v1/enquiries/draft', {
      title: 'Correcting nothing',
      jobType: 'correction_ecn',
      relatedEnquiryId: '00000000-0000-4000-8000-000000000000',
    });
    // Same code for "not yours" and "does not exist": the check must not confirm ids.
    expect(ghost.status).toBe(422);
    expect(ghost.body['code']).toBe(attempt.body['code']);

    const mine = await customer.post('/api/v1/enquiries/draft', { title: 'Original' });
    const ok = await customer.post('/api/v1/enquiries/draft', {
      title: 'Correcting my own',
      jobType: 'correction_ecn',
      relatedEnquiryId: mine.body['enquiryId'],
    });
    expect(ok.status).toBe(201);
    expect(ok.body['relatedEnquiryId']).toBe(mine.body['enquiryId']);

    // On any other job type the correction fields are dropped, not stored as stray text.
    const plain = await customer.post('/api/v1/enquiries/draft', {
      title: 'Plain job work',
      jobType: 'job_work',
      changeReference: 'ECN-9',
      relatedEnquiryId: mine.body['enquiryId'],
    });
    expect(plain.body['changeReference']).toBe('');
    expect(plain.body['relatedEnquiryId']).toBeNull();
  });

  it('copies a correction as a correction of its source, with the ECN number cleared', async () => {
    const drawing = await seedDocument(customerOrgId, 'drawing_2d');
    const created = await customer.post('/api/v1/enquiries/draft', {
      ...completeDraft({ title: 'Housing rev C' }),
      jobType: 'correction_ecn',
      changeReference: 'ECN-0077',
      changeDescription: 'Bore diameter tightened.',
      documents: [{ documentVersionId: drawing, role: 'governing', lineNo: 1 }],
    });
    const sourceId = created.body['enquiryId'] as string;
    await customer.post(`/api/v1/enquiries/${sourceId}/submit`, {
      expectedVersion: created.body['aggregateVersion'] as number,
    });

    const copy = await customer.post(`/api/v1/enquiries/${sourceId}/copy`, {});
    expect(copy.status).toBe(201);
    expect(copy.body['jobType']).toBe('correction_ecn');
    expect(copy.body['relatedEnquiryId']).toBe(sourceId);
    expect(copy.body['changeReference']).toBe('');
  });

  it('shows the reviewer the job-type checklist rows', async () => {
    const drawing = await seedDocument(customerOrgId, 'drawing_2d');
    const created = await customer.post('/api/v1/enquiries/draft', {
      ...completeDraft({ title: 'Job work on our own bar stock' }),
      jobType: 'job_work',
      documents: [{ documentVersionId: drawing, role: 'governing', lineNo: 1 }],
    });
    const enquiryId = created.body['enquiryId'] as string;
    const submitted = await customer.post(`/api/v1/enquiries/${enquiryId}/submit`, {
      expectedVersion: created.body['aggregateVersion'] as number,
    });
    await sourcing.post(`/api/v1/intake/${enquiryId}/triage`, {
      expectedVersion: submitted.body['aggregateVersion'] as number,
    });

    const detail = await sourcing.get(`/api/v1/intake/${enquiryId}`);
    const flags = detail.body['completeness'] as Array<{ code: string; severity: string }>;
    const custody = flags.find((f) => f.code === 'customer_material_custody');
    expect(custody?.severity).toBe('advisory');
    expect((detail.body['enquiry'] as Record<string, unknown>)['jobType']).toBe('job_work');
  });

  it('hides another organizations enquiry behind the same answer as one that does not exist', async () => {
    const created = await customer.post('/api/v1/enquiries/draft', { title: 'Private' });
    const enquiryId = created.body['enquiryId'] as string;

    const peek = await otherCustomer.get(`/api/v1/enquiries/${enquiryId}`);
    expect(peek.status).toBe(404);
    expect(peek.body['code']).toBe('ENQUIRY_NOT_FOUND');

    const invented = await otherCustomer.get(
      `/api/v1/enquiries/00000000-0000-4000-8000-000000000000`,
    );
    expect(invented.status).toBe(404);
    expect(invented.body['code']).toBe(peek.body['code']);
  });

  it('refuses to attach a document the customer does not own', async () => {
    const foreign = await seedDocument(otherCustomerOrgId, 'drawing_2d');
    const attempt = await customer.post('/api/v1/enquiries/draft', {
      title: 'Borrowed drawing',
      documents: [{ documentVersionId: foreign, role: 'reference' }],
    });
    expect(attempt.status).toBe(409);
    expect(attempt.body['code']).toBe('DOCUMENT_NOT_USABLE');
  });

  // ---------------------------------------------------------------- F-05.4

  it('blocks approve-for-sourcing until a CAD/2D conflict is resolved by declaration', async () => {
    const cad = await seedDocument(customerOrgId, 'cad_3d');
    const drawing = await seedDocument(customerOrgId, 'drawing_2d');
    const created = await customer.post('/api/v1/enquiries/draft', {
      ...completeDraft({ title: 'CAD and drawing both attached' }),
      documents: [
        { documentVersionId: cad, role: 'reference', lineNo: 1 },
        { documentVersionId: drawing, role: 'reference', lineNo: 1 },
      ],
    });
    const enquiryId = created.body['enquiryId'] as string;
    const submitted = await customer.post(`/api/v1/enquiries/${enquiryId}/submit`, {
      expectedVersion: created.body['aggregateVersion'] as number,
    });

    const triaged = await sourcing.post(`/api/v1/intake/${enquiryId}/triage`, {
      expectedVersion: submitted.body['aggregateVersion'] as number,
    });
    expect(triaged.status).toBe(201);

    const detail = await sourcing.get(`/api/v1/intake/${enquiryId}`);
    const codes = (detail.body['completeness'] as Array<{ code: string }>).map((f) => f.code);
    expect(codes).toContain('cad_2d_conflict');

    const blocked = await sourcing.post(`/api/v1/intake/${enquiryId}/approve`, {
      expectedVersion: triaged.body['aggregateVersion'] as number,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body['code']).toBe('SOURCING_BLOCKED');

    // Declaring which document governs is what clears it — not deleting the other one.
    const approved = await sourcing.post(`/api/v1/intake/${enquiryId}/approve`, {
      expectedVersion: triaged.body['aggregateVersion'] as number,
      governingDocumentVersionId: drawing,
    });
    expect(approved.status).toBe(201);
    expect(approved.body['status']).toBe('approved_for_sourcing');
    expect(
      (approved.body['documents'] as Array<{ documentVersionId: string; role: string }>).find(
        (d) => d.documentVersionId === drawing,
      )!.role,
    ).toBe('governing');
  });

  it('requires a reason to decline and refuses a role that may not triage', async () => {
    const drawing = await seedDocument(customerOrgId, 'drawing_2d');
    const created = await customer.post('/api/v1/enquiries/draft', {
      ...completeDraft({ title: 'Out of scope job' }),
      documents: [{ documentVersionId: drawing, role: 'governing', lineNo: 1 }],
    });
    const enquiryId = created.body['enquiryId'] as string;
    const submitted = await customer.post(`/api/v1/enquiries/${enquiryId}/submit`, {
      expectedVersion: created.body['aggregateVersion'] as number,
    });

    // The customer cannot triage their own enquiry.
    const notAllowed = await customer.post(`/api/v1/intake/${enquiryId}/triage`, {
      expectedVersion: submitted.body['aggregateVersion'] as number,
    });
    expect(notAllowed.status).toBe(403);

    const triaged = await sourcing.post(`/api/v1/intake/${enquiryId}/triage`, {
      expectedVersion: submitted.body['aggregateVersion'] as number,
    });

    const noReason = await sourcing.post(`/api/v1/intake/${enquiryId}/decline`, {
      expectedVersion: triaged.body['aggregateVersion'] as number,
    });
    expect(noReason.status).toBe(400);

    const declined = await sourcing.post(`/api/v1/intake/${enquiryId}/decline`, {
      expectedVersion: triaged.body['aggregateVersion'] as number,
      reason: 'Part size is outside every eligible supplier’s envelope.',
    });
    expect(declined.status).toBe(201);
    expect(declined.body['status']).toBe('closed');
    expect(declined.body['decisionReason']).toContain('envelope');
  });

  // ------------------------------------------------- pilot scenario 2 (doc 19 §10)

  it('carries an incomplete enquiry through two clarification rounds without rewriting what was submitted', async () => {
    const drawing = await seedDocument(customerOrgId, 'drawing_2d');
    const created = await customer.post('/api/v1/enquiries/draft', {
      ...completeDraft({ title: 'Impeller housing', applicationNote: 'Grade not final.' }),
      documents: [{ documentVersionId: drawing, role: 'governing', lineNo: 1 }],
    });
    const enquiryId = created.body['enquiryId'] as string;

    const submitted = await customer.post(`/api/v1/enquiries/${enquiryId}/submit`, {
      expectedVersion: created.body['aggregateVersion'] as number,
    });
    expect(submitted.status).toBe(201);
    const intakeHash = (
      await pg.query<{ content_hash: string }>(
        `SELECT content_hash FROM sourcing.requirement WHERE enquiry_id = $1 AND revision_no = 1`,
        [enquiryId],
      )
    ).rows[0]!.content_hash;

    let version = submitted.body['aggregateVersion'] as number;

    // ---- round one
    const triaged = await sourcing.post(`/api/v1/intake/${enquiryId}/triage`, {
      expectedVersion: version,
    });
    version = triaged.body['aggregateVersion'] as number;

    const round1 = await sourcing.post(`/api/v1/intake/${enquiryId}/clarifications`, {
      expectedVersion: version,
      questions: [
        { topic: 'material', question: 'Which aluminium grade is acceptable?', lineNo: 1 },
        { topic: 'tolerance', question: 'Is the 0.05 mm bore tolerance on diameter or position?', lineNo: 1 },
      ],
    });
    expect(round1.status).toBe(201);
    expect(round1.body['status']).toBe('clarification_required');

    // The customer sees questions, not our internal state.
    const customerView = await customer.get(`/api/v1/enquiries/${enquiryId}`);
    expect((customerView.body['enquiry'] as { status: string }).status).toBe('information_needed');
    const openIds = (customerView.body['clarifications'] as Array<{ clarificationId: string; status: string }>)
      .filter((c) => c.status === 'open')
      .map((c) => c.clarificationId);
    expect(openIds).toHaveLength(2);

    const answered1 = await customer.post(`/api/v1/enquiries/${enquiryId}/clarifications`, {
      answers: [
        { clarificationId: openIds[0]!, answer: '6061-T6 or 6082-T6.' },
        { clarificationId: openIds[1]!, answer: 'Diameter.' },
      ],
    });
    expect(answered1.status).toBe(201);
    expect(answered1.body['status']).toBe('under_review');
    expect(answered1.body['currentRevisionNo']).toBe(2);
    // The revision they submitted is still revision 1, untouched.
    expect(answered1.body['submittedRevisionNo']).toBe(1);

    // ---- round two
    const round2 = await sourcing.post(`/api/v1/intake/${enquiryId}/clarifications`, {
      expectedVersion: answered1.body['aggregateVersion'] as number,
      questions: [{ topic: 'delivery', question: 'Can the 500-off batch ship in two lots?' }],
    });
    expect(round2.status).toBe(201);

    const secondRound = (
      await customer.get(`/api/v1/enquiries/${enquiryId}`)
    ).body['clarifications'] as Array<{ clarificationId: string; status: string }>;
    const stillOpen = secondRound.filter((c) => c.status === 'open');
    expect(stillOpen).toHaveLength(1);

    const answered2 = await customer.post(`/api/v1/enquiries/${enquiryId}/clarifications`, {
      answers: [{ clarificationId: stillOpen[0]!.clarificationId, answer: 'Yes, two lots is fine.' }],
    });
    expect(answered2.status).toBe(201);
    expect(answered2.body['currentRevisionNo']).toBe(3);

    // ---- the submitted revision survived both rounds, byte for byte
    const intakeAfter = await pg.query<{ content_hash: string }>(
      `SELECT content_hash FROM sourcing.requirement WHERE enquiry_id = $1 AND revision_no = 1`,
      [enquiryId],
    );
    expect(intakeAfter.rows[0]!.content_hash).toBe(intakeHash);

    const chain = await pg.query<{ revision_no: number; kind: string; supersedes_id: string | null }>(
      `SELECT revision_no, kind, supersedes_id FROM sourcing.requirement
        WHERE enquiry_id = $1 ORDER BY revision_no`,
      [enquiryId],
    );
    expect(chain.rows.map((r) => r.kind)).toEqual(['intake', 'reviewed', 'reviewed']);
    expect(chain.rows[1]!.supersedes_id).not.toBeNull();

    // ---- approval, now that nothing is open
    const approved = await sourcing.post(`/api/v1/intake/${enquiryId}/approve`, {
      expectedVersion: answered2.body['aggregateVersion'] as number,
      note: 'Grade and lot split confirmed.',
    });
    expect(approved.status).toBe(201);
    expect(approved.body['status']).toBe('approved_for_sourcing');

    // ---- the approved revision, which every round is built on, keeps every answer
    const approvedRevision = await pg.query<{ kind: string; snapshot: { clarifications: Array<{ topic: string; answer: string }> } }>(
      `SELECT kind, snapshot FROM sourcing.requirement WHERE enquiry_id = $1 ORDER BY revision_no DESC LIMIT 1`,
      [enquiryId],
    );
    expect(approvedRevision.rows[0]!.kind).toBe('reviewed');
    const answeredCount = await pg.query<{ n: string }>(`SELECT count(*) AS n FROM sourcing.clarification WHERE enquiry_id = $1 AND status = 'answered'`, [enquiryId]);
    expect(approvedRevision.rows[0]!.snapshot.clarifications).toHaveLength(Number(answeredCount.rows[0]!.n));
    expect(approvedRevision.rows[0]!.snapshot.clarifications.every((c) => c.answer.length > 0)).toBe(true);

    // ---- the whole run left an audit trail and an outbox event per business step
    const audit = await pg.query<{ action: string }>(
      `SELECT action FROM platform.audit_event WHERE subject_id = $1 ORDER BY occurred_at`,
      [enquiryId],
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('sourcing.enquiry_submitted');
    expect(actions.filter((a) => a === 'sourcing.clarification_requested')).toHaveLength(2);
    expect(actions.filter((a) => a === 'sourcing.clarification_answered')).toHaveLength(2);
    expect(actions).toContain('sourcing.enquiry_approved_for_sourcing');

    const outbox = await pg.query<{ event_type: string }>(
      `SELECT event_type FROM platform.outbox_event WHERE aggregate_id = $1`,
      [enquiryId],
    );
    expect(outbox.rows.map((r) => r.event_type)).toContain('sourcing.enquiry_approved_for_sourcing');
  });

  // ---------------------------------------------------------------- F-05.5

  it('shows the customer a curated status that names no internal state and no supplier', async () => {
    const drawing = await seedDocument(customerOrgId, 'drawing_2d');
    const created = await customer.post('/api/v1/enquiries/draft', {
      ...completeDraft({ title: 'Projection check' }),
      documents: [{ documentVersionId: drawing, role: 'governing', lineNo: 1 }],
    });
    const enquiryId = created.body['enquiryId'] as string;
    const submitted = await customer.post(`/api/v1/enquiries/${enquiryId}/submit`, {
      expectedVersion: created.body['aggregateVersion'] as number,
    });
    const triaged = await sourcing.post(`/api/v1/intake/${enquiryId}/triage`, {
      expectedVersion: submitted.body['aggregateVersion'] as number,
    });
    await sourcing.post(`/api/v1/intake/${enquiryId}/approve`, {
      expectedVersion: triaged.body['aggregateVersion'] as number,
    });

    const list = await customer.get('/api/v1/enquiries');
    expect(list.status).toBe(200);
    const mine = (list.body['enquiries'] as Array<Record<string, unknown>>).find(
      (e) => e['enquiryId'] === enquiryId,
    )!;
    expect(mine['status']).toBe('sourcing_in_progress');
    expect(mine['statusLabel']).toBe('Sourcing in progress');
    expect(mine['actionNeeded']).toBeNull();

    // Nothing internal leaks anywhere in the customer payload.
    const serialized = JSON.stringify(list.body) + JSON.stringify((await customer.get(`/api/v1/enquiries/${enquiryId}`)).body);
    for (const forbidden of [
      'approved_for_sourcing',
      'under_review',
      'clarification_required',
      'supplier',
      'bid',
      'cost',
      'margin',
      'decidedBy',
      'reviewerNote',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    // The detail view of a non-draft returns no editable draft body at all.
    const detail = await customer.get(`/api/v1/enquiries/${enquiryId}`);
    expect(detail.body['draft']).toBeNull();
  });
});
