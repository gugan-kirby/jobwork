import { createHash } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  mintServiceToken,
  SCAN_WORKER_PRINCIPAL,
  SERVICE_TOKEN_HEADER,
} from '@jobwork/service-auth';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { computeExclusions } from '../src/modules/supplier';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'supplier-test-password-1';
const SERVICE_SECRET = 'test-service-token-secret';
const SESSION_COOKIE = 'jw_session';

describe('Supplier verification lifecycle (F-04.2, doc 06 §14)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let supplierOrgId: string;
  let supplier: TestClient; // supplier org_admin — submits evidence
  let supplierTwo: TestClient; // second supplier member
  let sourcing: TestClient; // JobWork sourcing, MFA-enrolled — reviews
  let sourcingTwo: TestClient; // a second reviewer
  let accountsAdmin: TestClient; // platform_admin only — must not review

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

  async function seedOrg(type: 'supplier' | 'internal', name: string): Promise<string> {
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
    const verify = await fresh.post('/api/v1/auth/mfa', {
      code: totpCode(secret.rows[0]!.mfa_totp_secret, email),
    });
    expect(verify.status).toBe(201);
    return fresh;
  }

  async function submit(
    client: TestClient,
    kind: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return client.post('/api/v1/suppliers/me/verification', { kind, ...extra });
  }

  async function verify(
    reviewer: TestClient,
    itemId: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return reviewer.post(`/api/v1/suppliers/verification/${itemId}/review`, {
      decision: 'verify',
      ...extra,
    });
  }

  async function sweep(): Promise<{ expired: number; expiring: number }> {
    const res = await fetch(`${baseUrl}/api/v1/internal/suppliers/verification/sweep`, {
      method: 'POST',
      headers: {
        [SERVICE_TOKEN_HEADER]: mintServiceToken(SERVICE_SECRET, SCAN_WORKER_PRINCIPAL.name),
        'idempotency-key': `sweep-${Math.random().toString(36).slice(2)}`,
      },
    });
    const payload = (await res.json()) as Record<string, unknown>;
    if (res.status !== 201) console.error('sweep failed', JSON.stringify(payload));
    expect(res.status).toBe(201);
    return payload as unknown as { expired: number; expiring: number };
  }

  /**
   * The eligibility view needs a live capability to project a row; publishing one is
   * F-04.3's command, so the state is seeded directly here.
   */
  async function ensureCapability(): Promise<void> {
    await pg.query(
      `INSERT INTO supplier.supplier_capability (supplier_profile_id, capability_id, version_no)
       SELECT p.id, c.id, 1
         FROM supplier.supplier_profile p, supplier.capability c
        WHERE p.organization_id = $1 AND c.code = 'cnc_milling'
       ON CONFLICT DO NOTHING`,
      [supplierOrgId],
    );
  }

  async function eligibilityRow(): Promise<{ mandatory: number } | null> {
    const res = await pg.query<{ mandatory_verified_count: string }>(
      `SELECT mandatory_verified_count FROM supplier.eligibility
        WHERE organization_id = $1 LIMIT 1`,
      [supplierOrgId],
    );
    const row = res.rows[0];
    return row ? { mandatory: Number(row.mandatory_verified_count) } : null;
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_supplier');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = SERVICE_SECRET;
    process.env['SESSION_COOKIE_NAME'] = SESSION_COOKIE;
    process.env['NODE_ENV'] = 'test';

    pg = new Client({ connectionString: db.url });
    await pg.connect();
    supplierOrgId = await seedOrg('supplier', 'Chennai Precision');
    const internalOrgId = await seedOrg('internal', 'JobWork Operations');
    await seedUser(supplierOrgId, 'admin@supplier.test', ['org_admin']);
    await seedUser(supplierOrgId, 'quality@supplier.test', ['supplier_quality']);
    await seedUser(internalOrgId, 'sourcing@jobwork.test', ['jobwork_sourcing']);
    await seedUser(internalOrgId, 'sourcing2@jobwork.test', ['jobwork_sourcing']);
    await seedUser(internalOrgId, 'accounts@jobwork.test', ['platform_admin', 'security_admin']);

    ({ app, baseUrl } = await createTestApp());
    supplier = await signIn('admin@supplier.test');
    supplierTwo = await signIn('quality@supplier.test');
    accountsAdmin = await signIn('accounts@jobwork.test');
    sourcing = await signInWithMfa('sourcing@jobwork.test');
    sourcingTwo = await signInWithMfa('sourcing2@jobwork.test');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('walks an item from submission to verified, creating the profile on the way', async () => {
    const submitted = await submit(supplier, 'gst', { referenceValue: '33AABCU9603R1ZM' });
    expect(submitted.status).toBe(201);
    expect(submitted.body['status']).toBe('submitted');
    expect(submitted.body['versionNo']).toBe(1);

    const queue = await sourcing.get('/api/v1/suppliers/verification/queue');
    expect(queue.status).toBe(200);
    const items = queue.body['items'] as Array<Record<string, unknown>>;
    expect(items.some((i) => i['verificationItemId'] === submitted.body['verificationItemId'])).toBe(
      true,
    );
    expect(items[0]?.['organizationName']).toBe('Chennai Precision');

    const verified = await verify(sourcing, submitted.body['verificationItemId'] as string, {
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
    });
    expect(verified.status).toBe(201);
    expect(verified.body['status']).toBe('verified');

    // Re-deciding the same way is a no-op, not a second decision.
    const again = await verify(sourcing, submitted.body['verificationItemId'] as string);
    expect(again.body['status']).toBe('verified');

    const audit = await pg.query<{ action: string }>(
      `SELECT action FROM platform.audit_event WHERE action LIKE 'supplier.%' ORDER BY occurred_at`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'supplier.verification_submitted',
        'supplier.verification_verified',
      ]),
    );
  });

  it('refuses self-review, supplier review, and account administrators', async () => {
    const submitted = await submit(supplierTwo, 'address_proof');
    const itemId = submitted.body['verificationItemId'] as string;

    // The supplier cannot verify itself, whatever role it holds.
    const bySupplier = await verify(supplier, itemId);
    expect(bySupplier.status).toBe(403);
    expect(bySupplier.body['code']).toBe('NOT_AUTHORIZED');

    // Managing accounts is not reviewing evidence (doc 03 §7).
    const byAdmin = await verify(accountsAdmin, itemId);
    expect(byAdmin.status).toBe(403);

    // And a JobWork reviewer cannot decide an item they submitted themselves.
    await pg.query(
      `UPDATE supplier.verification_item SET submitted_by =
         (SELECT id FROM iam.user_account WHERE email = 'sourcing@jobwork.test')
        WHERE id = $1`,
      [itemId],
    );
    const selfReview = await verify(sourcing, itemId);
    expect(selfReview.status).toBe(403);
    expect(selfReview.body['code']).toBe('SELF_REVIEW_REJECTED');

    // A different reviewer decides it perfectly well.
    const byOther = await verify(sourcingTwo, itemId);
    expect(byOther.status).toBe(201);
    expect(byOther.body['status']).toBe('verified');
  });

  it('returns evidence with a reason, and a resubmission appends a version', async () => {
    const submitted = await submit(supplier, 'udyam');
    const itemId = submitted.body['verificationItemId'] as string;

    const noReason = await sourcing.post(`/api/v1/suppliers/verification/${itemId}/review`, {
      decision: 'return',
    });
    expect(noReason.status).toBe(400);

    const returned = await sourcing.post(`/api/v1/suppliers/verification/${itemId}/review`, {
      decision: 'return',
      reason: 'Certificate image is unreadable',
    });
    expect(returned.status).toBe(201);
    expect(returned.body['status']).toBe('returned_for_evidence');
    expect(returned.body['reviewReason']).toBe('Certificate image is unreadable');

    const resubmitted = await submit(supplier, 'udyam');
    expect(resubmitted.body['versionNo']).toBe(2);
    expect(resubmitted.body['verificationItemId']).not.toBe(itemId);

    // The returned version is still there, unchanged: history is not rewritten.
    const history = await supplier.get('/api/v1/suppliers/me/verification');
    const udyam = (history.body['items'] as Array<Record<string, unknown>>).filter(
      (i) => i['kind'] === 'udyam',
    );
    expect(udyam).toHaveLength(2);
    expect(udyam.find((i) => i['versionNo'] === 1)?.['status']).toBe('returned_for_evidence');
  });

  it('refuses evidence that is not a scan-clean document of the supplier’s own', async () => {
    const bytes = Buffer.from('%PDF-1.7 evidence\n%%EOF\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const started = await supplier.post('/api/v1/documents/uploads', {
      purpose: 'certificate',
      filename: 'iso9001.pdf',
      declaredMediaType: 'application/pdf',
      byteSize: bytes.byteLength,
      sha256,
    });
    const grant = started.body['grant'] as { method: string; url: string; headers: Record<string, string> };
    await fetch(grant.url, { method: grant.method, headers: grant.headers, body: bytes });
    const finalized = await supplier.post(
      `/api/v1/documents/uploads/${started.body['uploadSessionId'] as string}/finalize`,
      { byteSize: bytes.byteLength, sha256 },
    );
    const versionId = finalized.body['documentVersionId'] as string;

    // Still processing: unusable as evidence (BR-ENG-08).
    const tooEarly = await submit(supplier, 'quality_system', {
      evidenceDocumentVersionId: versionId,
    });
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body['code']).toBe('EVIDENCE_NOT_USABLE');

    // A version belonging to nobody the supplier knows is simply not found.
    const unknown = await submit(supplier, 'quality_system', {
      evidenceDocumentVersionId: '00000000-0000-4000-8000-0000000000bb',
    });
    expect(unknown.status).toBe(409);

    // Clear the scan, and the same evidence is accepted.
    const fileId = await pg.query<{ id: string }>(
      `SELECT f.id FROM dms.file_object f
         JOIN dms.document_version v ON v.file_object_id = f.id WHERE v.id = $1`,
      [versionId],
    );
    for (const [path, body] of [
      [`${fileId.rows[0]!.id}/begin`, undefined],
      [
        `${fileId.rows[0]!.id}/result`,
        {
          verdict: 'clean',
          reason: 'clean',
          detectedMediaType: 'application/pdf',
          scanner: { name: 'test-scanner', version: '1' },
        },
      ],
    ] as const) {
      const headers: Record<string, string> = {
        [SERVICE_TOKEN_HEADER]: mintServiceToken(SERVICE_SECRET, SCAN_WORKER_PRINCIPAL.name),
        'idempotency-key': `k-${Math.random().toString(36).slice(2)}`,
      };
      if (body) headers['content-type'] = 'application/json';
      await fetch(`${baseUrl}/api/v1/internal/documents/scans/${path}`, {
        method: 'POST',
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    }

    const accepted = await submit(supplier, 'quality_system', {
      evidenceDocumentVersionId: versionId,
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body['evidenceDocumentVersionId']).toBe(versionId);
  });

  it('expires by stored date, dropping eligibility without touching history', async () => {
    await ensureCapability();
    for (const kind of ['pan', 'bank_account']) {
      const submitted = await submit(supplier, kind);
      await verify(sourcing, submitted.body['verificationItemId'] as string, {
        expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      });
    }

    // gst + pan + bank_account are the mandatory three; all live now.
    expect((await eligibilityRow())?.mandatory).toBe(3);

    const before = await pg.query<{ id: string; reviewed_at: Date }>(
      `SELECT id, reviewed_at FROM supplier.verification_item
        WHERE supplier_profile_id = (SELECT id FROM supplier.supplier_profile WHERE organization_id = $1)
          AND kind = 'pan' ORDER BY version_no DESC LIMIT 1`,
      [supplierOrgId],
    );
    await pg.query(
      `UPDATE supplier.verification_item SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [before.rows[0]!.id],
    );

    const swept = await sweep();
    expect(swept.expired).toBeGreaterThanOrEqual(1);

    const after = await pg.query<{ status: string; reviewed_at: Date; version_no: number }>(
      `SELECT status, reviewed_at, version_no FROM supplier.verification_item WHERE id = $1`,
      [before.rows[0]!.id],
    );
    expect(after.rows[0]!.status).toBe('expired');
    // The verification's own history — who reviewed it, which version it was — is
    // untouched; only its effect on future matching changed.
    expect(after.rows[0]!.reviewed_at.toISOString()).toBe(before.rows[0]!.reviewed_at.toISOString());
    expect((await eligibilityRow())?.mandatory).toBe(2);

    // Sweeping again settles nothing further: the query is the truth, not the timer.
    expect((await sweep()).expired).toBe(0);

    const expiredAudit = await pg.query<{ actor_type: string }>(
      `SELECT actor_type FROM platform.audit_event
        WHERE action = 'supplier.verification_expired' AND subject_id = $1`,
      [before.rows[0]!.id],
    );
    expect(expiredAudit.rows[0]?.actor_type).toBe('service');
  });

  it('warns before the cliff, and revocation bites immediately', async () => {
    const submitted = await submit(supplier, 'pan');
    expect(submitted.body['versionNo']).toBe(2);
    const itemId = submitted.body['verificationItemId'] as string;
    await verify(sourcing, itemId, {
      expiresAt: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString(),
    });

    const swept = await sweep();
    expect(swept.expiring).toBeGreaterThanOrEqual(1);
    const warned = await pg.query<{ status: string }>(
      `SELECT status FROM supplier.verification_item WHERE id = $1`,
      [itemId],
    );
    // Warning does not withdraw anything: an expiring item is still live evidence.
    expect(warned.rows[0]!.status).toBe('expiring');
    expect((await eligibilityRow())?.mandatory).toBe(3);

    const revoked = await sourcing.post(`/api/v1/suppliers/verification/${itemId}/revoke`, {
      reason: 'Certificate withdrawn by the issuing authority',
    });
    expect(revoked.status).toBe(201);
    expect(revoked.body['status']).toBe('revoked');
    expect((await eligibilityRow())?.mandatory).toBe(2);

    // Revoking twice changes nothing further.
    const again = await sourcing.post(`/api/v1/suppliers/verification/${itemId}/revoke`, {
      reason: 'duplicate call',
    });
    expect(again.body['status']).toBe('revoked');

    const supplierAttempt = await supplier.post(
      `/api/v1/suppliers/verification/${itemId}/revoke`,
      { reason: 'not mine to revoke' },
    );
    expect(supplierAttempt.status).toBe(403);
  });

  it('computes the same exclusions from the same facts, and says why', () => {
    const now = new Date('2026-09-05T00:00:00Z');
    const base = {
      profileStatus: 'active',
      organizationStatus: 'active',
      publishedCapabilityCount: 2,
      now,
    };
    const live = [
      { kind: 'gst' as const, status: 'verified' as const, expiresAt: new Date('2027-01-01') },
      { kind: 'pan' as const, status: 'verified' as const, expiresAt: null },
      { kind: 'bank_account' as const, status: 'verified' as const, expiresAt: null },
    ];
    expect(computeExclusions({ ...base, items: live })).toEqual([]);

    expect(
      computeExclusions({
        ...base,
        items: [{ ...live[0]!, expiresAt: new Date('2026-01-01') }, live[1]!, live[2]!],
      }),
    ).toEqual(['verification_expired']);

    expect(
      computeExclusions({
        ...base,
        items: [{ kind: 'gst', status: 'revoked', expiresAt: null }, live[1]!, live[2]!],
      }),
    ).toEqual(['verification_revoked']);

    expect(computeExclusions({ ...base, items: [live[0]!] })).toEqual([
      'missing_mandatory_verification',
    ]);

    expect(
      computeExclusions({ ...base, publishedCapabilityCount: 0, items: live }),
    ).toEqual(['no_published_capability']);

    expect(
      computeExclusions({ ...base, organizationStatus: 'suspended', items: live }),
    ).toEqual(['organization_suspended']);
  });
});
