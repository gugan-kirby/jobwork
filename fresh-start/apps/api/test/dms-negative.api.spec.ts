import { createHash } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { signRequest } from '@jobwork/object-store';
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
import { ConfigService } from '../src/platform/config/config.service';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'audience-test-password-1';
const SERVICE_SECRET = 'test-service-token-secret';
const SESSION_COOKIE = 'jw_session';

interface Grant {
  method: string;
  url: string;
  headers: Record<string, string>;
}

interface UploadedVersion {
  documentId: string;
  documentVersionId: string;
  fileObjectId: string;
}

/**
 * The doc 03 §7 negative matrix for released files, plus the doc 19 §3 withdrawal
 * case. Every expectation here is a rule that must fail closed, so each one is
 * asserted against the real query path rather than a unit-level stub.
 */
describe('Audience release and download refusals (F-03.4)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;
  let config: ConfigService;

  let ownerOrgId: string;
  let supplierOrgId: string;
  let owner: TestClient; // customer that owns the documents
  let outsider: TestClient; // unrelated customer
  let supplier: TestClient; // supplier the file is released to
  let sourcing: TestClient; // JobWork sourcing, MFA-enrolled
  let accountsAdmin: TestClient; // platform_admin + security_admin only
  let auditor: TestClient;

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

  async function ensureBucket(bucket: string): Promise<void> {
    const signed = signRequest(
      {
        accessKeyId: config.env.OBJECT_STORE_ACCESS_KEY,
        secretAccessKey: config.env.OBJECT_STORE_SECRET_KEY,
        region: config.env.OBJECT_STORE_REGION,
      },
      { endpoint: config.env.OBJECT_STORE_ENDPOINT, objectPath: bucket, method: 'PUT' },
    );
    const res = await fetch(signed.url, { method: 'PUT', headers: signed.headers });
    if (!res.ok && res.status !== 409) throw new Error(`bucket ${bucket}: ${res.status}`);
  }

  async function seedOrg(
    type: 'customer' | 'supplier' | 'internal',
    name: string,
  ): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ($1, $2, $2) RETURNING id`,
      [type, name],
    );
    return res.rows[0]!.id;
  }

  async function seedUser(
    organizationId: string,
    email: string,
    roles: string[],
  ): Promise<string> {
    const user = await pg.query<{ id: string }>(
      `INSERT INTO iam.user_account
         (email, password_hash, password_params_version, display_name, status, email_verified_at)
       VALUES ($1, $2, 1, 'Member', 'active', now()) RETURNING id`,
      [email, await hashPassword(PASSWORD)],
    );
    const membership = await pg.query<{ id: string }>(
      `INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`,
      [user.rows[0]!.id, organizationId],
    );
    await pg.query(
      `INSERT INTO iam.membership_role (membership_id, role_id)
       SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`,
      [membership.rows[0]!.id, roles],
    );
    return user.rows[0]!.id;
  }

  async function signIn(email: string): Promise<TestClient> {
    const client = new TestClient(baseUrl);
    const res = await client.post('/api/v1/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(201);
    return client;
  }

  /** Internal actors must clear MFA before any transactional command (AUTH-15). */
  async function signInWithMfa(email: string): Promise<TestClient> {
    const first = await signIn(email);
    const enroll = await first.post('/api/v1/account/mfa/enroll');
    expect(enroll.status).toBe(201);
    const activate = await first.post('/api/v1/account/mfa/activate', {
      code: totpCode(enroll.body['secret'] as string, email),
    });
    expect(activate.status).toBe(201);

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

  async function asWorker(path: string, body?: unknown): Promise<number> {
    const headers: Record<string, string> = {
      [SERVICE_TOKEN_HEADER]: mintServiceToken(SERVICE_SECRET, SCAN_WORKER_PRINCIPAL.name),
      'idempotency-key': `k-${Math.random().toString(36).slice(2)}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return res.status;
  }

  /** Uploads a file as the owner, optionally taking it all the way to `clean`. */
  async function uploadVersion(
    content: string,
    opts: { documentId?: string; expectedVersion?: number; verdict?: 'clean' | 'infected' | null; by?: TestClient } = {},
  ): Promise<UploadedVersion> {
    const bytes = Buffer.from(content);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const uploader = opts.by ?? owner;
    const started = await uploader.post('/api/v1/documents/uploads', {
      purpose: 'drawing_2d',
      filename: 'drawing.pdf',
      declaredMediaType: 'application/pdf',
      byteSize: bytes.byteLength,
      sha256,
      ...(opts.documentId ? { documentId: opts.documentId } : {}),
    });
    expect(started.status).toBe(201);
    const grant = started.body['grant'] as Grant;
    const put = await fetch(grant.url, { method: 'PUT', headers: grant.headers, body: bytes });
    expect(put.status).toBe(200);

    const finalized = await uploader.post(
      `/api/v1/documents/uploads/${started.body['uploadSessionId'] as string}/finalize`,
      {
        byteSize: bytes.byteLength,
        sha256,
        ...(opts.expectedVersion ? { expectedVersion: opts.expectedVersion } : {}),
      },
    );
    expect(finalized.status).toBe(201);

    const file = await pg.query<{ id: string }>(
      `SELECT f.id FROM dms.file_object f
         JOIN dms.document_version v ON v.file_object_id = f.id
        WHERE v.id = $1`,
      [finalized.body['documentVersionId']],
    );
    const uploaded: UploadedVersion = {
      documentId: finalized.body['documentId'] as string,
      documentVersionId: finalized.body['documentVersionId'] as string,
      fileObjectId: file.rows[0]!.id,
    };

    const verdict = opts.verdict === undefined ? 'clean' : opts.verdict;
    if (verdict) {
      expect(await asWorker(`/api/v1/internal/documents/scans/${uploaded.fileObjectId}/begin`)).toBe(201);
      expect(
        await asWorker(`/api/v1/internal/documents/scans/${uploaded.fileObjectId}/result`, {
          verdict,
          reason: verdict === 'clean' ? 'clean' : 'malware_signature',
          detectedMediaType: 'application/pdf',
          scanner: { name: 'test-scanner', version: '1' },
        }),
      ).toBe(201);
    }
    return uploaded;
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_audience');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = SERVICE_SECRET;
    process.env['SESSION_COOKIE_NAME'] = SESSION_COOKIE;
    process.env['NODE_ENV'] = 'test';

    config = new ConfigService();
    await ensureBucket(config.env.OBJECT_STORE_BUCKET_QUARANTINE);
    await ensureBucket(config.env.OBJECT_STORE_BUCKET_CLEAN);

    pg = new Client({ connectionString: db.url });
    await pg.connect();

    ownerOrgId = await seedOrg('customer', 'Owner Works');
    const outsiderOrgId = await seedOrg('customer', 'Unrelated Works');
    supplierOrgId = await seedOrg('supplier', 'Chennai Precision');
    const internalOrgId = await seedOrg('internal', 'JobWork Operations');

    await seedUser(ownerOrgId, 'owner@audience.test', ['customer_requester']);
    await seedUser(outsiderOrgId, 'outsider@audience.test', ['customer_requester']);
    await seedUser(supplierOrgId, 'supplier@audience.test', ['supplier_estimator']);
    await seedUser(internalOrgId, 'sourcing@audience.test', ['jobwork_sourcing']);
    await seedUser(internalOrgId, 'accounts@audience.test', ['platform_admin', 'security_admin']);
    await seedUser(internalOrgId, 'auditor@audience.test', ['auditor']);

    ({ app, baseUrl } = await createTestApp());
    owner = await signIn('owner@audience.test');
    outsider = await signIn('outsider@audience.test');
    supplier = await signIn('supplier@audience.test');
    accountsAdmin = await signIn('accounts@audience.test');
    auditor = await signIn('auditor@audience.test');
    sourcing = await signInWithMfa('sourcing@audience.test');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('lets the owning organization download its own cleared file, and logs that it did', async () => {
    const version = await uploadVersion('%PDF-1.7 owner copy\n%%EOF\n');

    const download = await owner.get(`/api/v1/documents/versions/${version.documentVersionId}/download`);
    expect(download.status).toBe(200);
    const url = download.body['url'] as string;
    // A storage-origin capability with a forced attachment disposition — never a
    // stream from the application origin (doc 09 §4).
    expect(url.startsWith(config.env.OBJECT_STORE_ENDPOINT)).toBe(true);
    expect(url).toContain('response-content-disposition=attachment');
    expect(url).toContain('X-Amz-Expires=');

    // Short-lived: the revocation bound of doc 20 §8 target 5.
    const ttl = new Date(download.body['expiresAt'] as string).getTime() - Date.now();
    expect(ttl).toBeLessThanOrEqual(config.env.DOWNLOAD_GRANT_TTL_SECONDS * 1000 + 5_000);

    const fetched = await fetch(url);
    expect(fetched.status).toBe(200);

    const log = await pg.query(
      `SELECT action FROM dms.access_log WHERE document_version_id = $1`,
      [version.documentVersionId],
    );
    expect(log.rowCount).toBe(1);
  });

  it('will not release or serve content the scanner has not cleared (BR-ENG-08)', async () => {
    const processing = await uploadVersion('%PDF-1.7 unscanned\n%%EOF\n', { verdict: null });
    const grant = await owner.post(
      `/api/v1/documents/versions/${processing.documentVersionId}/grants`,
      { audienceType: 'internal' },
    );
    expect(grant.status).toBe(409);
    expect(grant.body['code']).toBe('CONTENT_NOT_RELEASABLE');

    const download = await owner.get(
      `/api/v1/documents/versions/${processing.documentVersionId}/download`,
    );
    expect(download.status).toBe(409);

    const infected = await uploadVersion('%PDF-1.7 infected\n%%EOF\n', { verdict: 'infected' });
    const infectedGrant = await owner.post(
      `/api/v1/documents/versions/${infected.documentVersionId}/grants`,
      { audienceType: 'internal' },
    );
    expect(infectedGrant.status).toBe(409);
    expect(
      (await owner.get(`/api/v1/documents/versions/${infected.documentVersionId}/download`)).status,
    ).toBe(409);
  });

  it('hides another organization’s version entirely — no fetch, no release, no probe', async () => {
    const version = await uploadVersion('%PDF-1.7 not yours\n%%EOF\n');

    const download = await outsider.get(
      `/api/v1/documents/versions/${version.documentVersionId}/download`,
    );
    expect(download.status).toBe(404);
    expect(download.body['code']).toBe('DOCUMENT_NOT_FOUND');

    const stolenGrant = await outsider.post(
      `/api/v1/documents/versions/${version.documentVersionId}/grants`,
      { audienceType: 'internal' },
    );
    expect(stolenGrant.status).toBe(404);

    const manifest = await outsider.get(`/api/v1/documents/${version.documentId}/manifest`);
    expect(manifest.status).toBe(404);

    // An unknown id answers exactly the same way, so existence cannot be probed.
    const guessed = await outsider.get(
      `/api/v1/documents/versions/00000000-0000-4000-8000-0000000000aa/download`,
    );
    expect(guessed.status).toBe(404);
    expect(guessed.body['code']).toBe(download.body['code']);
  });

  it('keeps the counterparty unnameable: an external party can only release to JobWork', async () => {
    const version = await uploadVersion('%PDF-1.7 shielded\n%%EOF\n');

    const direct = await owner.post(
      `/api/v1/documents/versions/${version.documentVersionId}/grants`,
      { audienceType: 'organization', organizationId: supplierOrgId },
    );
    expect(direct.status).toBe(403);
    expect(direct.body['code']).toBe('NOT_AUTHORIZED');

    const toJobWork = await owner.post(
      `/api/v1/documents/versions/${version.documentVersionId}/grants`,
      { audienceType: 'internal' },
    );
    expect(toJobWork.status).toBe(201);

    // Re-releasing to the same audience returns the same grant instead of stacking.
    const again = await owner.post(
      `/api/v1/documents/versions/${version.documentVersionId}/grants`,
      { audienceType: 'internal' },
    );
    expect(again.body['grantId']).toBe(toJobWork.body['grantId']);
  });

  it('sends a supplier JobWork’s copy of a customer file, never the file itself (F-FP.5)', async () => {
    const version = await uploadVersion('%PDF-1.7 customer original\n%%EOF\n');
    await owner.post(`/api/v1/documents/versions/${version.documentVersionId}/grants`, { audienceType: 'internal' });
    const refused = await sourcing.post(`/api/v1/documents/versions/${version.documentVersionId}/grants`, { audienceType: 'organization', organizationId: supplierOrgId });
    expect([refused.status, refused.body['code']]).toEqual([422, 'SUPPLIER_COPY_REQUIRED']);
    expect((await supplier.get(`/api/v1/documents/versions/${version.documentVersionId}/download`)).status).toBe(404);
  });

  it('gives access to the role doing the work, not to whoever administers accounts', async () => {
    const version = await uploadVersion('%PDF-1.7 internal read\n%%EOF\n');
    await owner.post(`/api/v1/documents/versions/${version.documentVersionId}/grants`, {
      audienceType: 'internal',
    });

    // Sourcing handles documents as part of its work.
    expect(
      (await sourcing.get(`/api/v1/documents/versions/${version.documentVersionId}/download`))
        .status,
    ).toBe(200);

    // Platform and security administration is not business access (doc 03 §7).
    const asAdmin = await accountsAdmin.get(
      `/api/v1/documents/versions/${version.documentVersionId}/download`,
    );
    expect(asAdmin.status).toBe(404);

    // The auditor's read comes from an auditor grant, not from being internal.
    expect(
      (await auditor.get(`/api/v1/documents/versions/${version.documentVersionId}/download`)).status,
    ).toBe(404);
    await sourcing.post(`/api/v1/documents/versions/${version.documentVersionId}/grants`, {
      audienceType: 'auditor',
      actions: ['view', 'download'],
    });
    expect(
      (await auditor.get(`/api/v1/documents/versions/${version.documentVersionId}/download`)).status,
    ).toBe(200);
  });

  it('binds a release to one immutable version, never to the document (BR-ENG-02)', async () => {
    const v1 = await uploadVersion('%PDF-1.7 revision one\n%%EOF\n', { by: sourcing });
    const released = await sourcing.post(
      `/api/v1/documents/versions/${v1.documentVersionId}/grants`,
      { audienceType: 'organization', organizationId: supplierOrgId },
    );
    expect(released.status).toBe(201);
    expect(
      (await supplier.get(`/api/v1/documents/versions/${v1.documentVersionId}/download`)).status,
    ).toBe(200);

    const v2 = await uploadVersion('%PDF-1.7 revision two\n%%EOF\n', {
      documentId: v1.documentId,
      expectedVersion: 2,
      by: sourcing,
    });
    // The supplier holds version 1. Version 2 is a different artifact, not an update
    // to what they were given.
    expect(
      (await supplier.get(`/api/v1/documents/versions/${v2.documentVersionId}/download`)).status,
    ).toBe(404);
  });

  it('withdraws future access on revocation while the downloads already taken remain facts', async () => {
    const version = await uploadVersion('%PDF-1.7 withdrawn later\n%%EOF\n', { by: sourcing });
    const released = await sourcing.post(
      `/api/v1/documents/versions/${version.documentVersionId}/grants`,
      { audienceType: 'organization', organizationId: supplierOrgId },
    );
    const grantId = released.body['grantId'] as string;

    expect(
      (await supplier.get(`/api/v1/documents/versions/${version.documentVersionId}/download`)).status,
    ).toBe(200);

    const revoked = await sourcing.post(
      `/api/v1/documents/versions/${version.documentVersionId}/grants/${grantId}/revoke`,
      { reason: 'customer withdrew the drawing' },
    );
    expect(revoked.status).toBe(201);
    expect(revoked.body['revokedAt']).not.toBeNull();

    // Dead immediately for anything new.
    expect(
      (await supplier.get(`/api/v1/documents/versions/${version.documentVersionId}/download`)).status,
    ).toBe(404);

    // Revoking twice is a no-op, not a second revocation.
    const again = await sourcing.post(
      `/api/v1/documents/versions/${version.documentVersionId}/grants/${grantId}/revoke`,
    );
    expect(again.status).toBe(201);
    expect(again.body['revokedAt']).toBe(revoked.body['revokedAt']);

    // The record of who took a copy survives, and the audit says how many (doc 19 §3).
    const log = await pg.query(
      `SELECT count(*)::int AS n FROM dms.access_log
        WHERE document_version_id = $1 AND organization_id = $2`,
      [version.documentVersionId, supplierOrgId],
    );
    expect(log.rows[0]!.n).toBe(1);
    const audit = await pg.query<{ data: { downloadsBeforeRevocation: number } }>(
      `SELECT data FROM platform.audit_event
        WHERE action = 'dms.audience_revoked' AND subject_id = $1`,
      [version.documentVersionId],
    );
    expect(audit.rows[0]!.data.downloadsBeforeRevocation).toBe(1);

    // The access log cannot be tidied away afterwards, whatever the connection role.
    await expect(
      pg.query(`DELETE FROM dms.access_log WHERE document_version_id = $1`, [
        version.documentVersionId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('stops honouring a grant the moment its validity window closes', async () => {
    const version = await uploadVersion('%PDF-1.7 time boxed\n%%EOF\n', { by: sourcing });
    const released = await sourcing.post(
      `/api/v1/documents/versions/${version.documentVersionId}/grants`,
      {
        audienceType: 'organization',
        organizationId: supplierOrgId,
        validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    );
    expect(released.status).toBe(201);
    expect(
      (await supplier.get(`/api/v1/documents/versions/${version.documentVersionId}/download`)).status,
    ).toBe(200);

    // A window already closed grants nothing; the API refuses to create one at all.
    const backdated = await sourcing.post(
      `/api/v1/documents/versions/${version.documentVersionId}/grants`,
      {
        audienceType: 'auditor',
        validUntil: new Date(Date.now() - 1000).toISOString(),
      },
    );
    expect(backdated.status).toBe(400);

    await pg.query(
      `UPDATE dms.audience_grant SET valid_until = now() - interval '1 minute' WHERE id = $1`,
      [released.body['grantId']],
    );
    expect(
      (await supplier.get(`/api/v1/documents/versions/${version.documentVersionId}/download`)).status,
    ).toBe(404);
  });

  it('takes file access away with the membership, not on the next login (doc 03 §7)', async () => {
    const version = await uploadVersion('%PDF-1.7 suspension case\n%%EOF\n', { by: sourcing });
    await sourcing.post(`/api/v1/documents/versions/${version.documentVersionId}/grants`, {
      audienceType: 'organization',
      organizationId: supplierOrgId,
    });
    expect(
      (await supplier.get(`/api/v1/documents/versions/${version.documentVersionId}/download`)).status,
    ).toBe(200);

    await pg.query(
      `UPDATE iam.membership SET status = 'suspended'
        WHERE organization_id = $1`,
      [supplierOrgId],
    );

    // Same live session, same cookie: the running session loses file access.
    const afterSuspension = await supplier.get(
      `/api/v1/documents/versions/${version.documentVersionId}/download`,
    );
    expect(afterSuspension.status).toBe(403);
    expect(afterSuspension.body['code']).toBe('MEMBERSHIP_NOT_FOUND');
  });
});
