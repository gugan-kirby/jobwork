import { createHash } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { ConfigService } from '../src/platform/config/config.service';
import { ObjectStore } from '../src/modules/dms/infrastructure/object-store';
import { signRequest } from '@jobwork/object-store';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'upload-test-password-1';
const SESSION_COOKIE = 'jw_session';

interface Grant {
  method: string;
  url: string;
  headers: Record<string, string>;
}

const sha256Of = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

/** Uploads exactly as a browser would: the grant dictates method, URL and headers. */
async function putWithGrant(grant: Grant, body: Buffer): Promise<Response> {
  return fetch(grant.url, { method: grant.method, headers: grant.headers, body });
}

async function ensureBucket(config: ConfigService, bucket: string): Promise<void> {
  const signed = signRequest(
    {
      accessKeyId: config.env.OBJECT_STORE_ACCESS_KEY,
      secretAccessKey: config.env.OBJECT_STORE_SECRET_KEY,
      region: config.env.OBJECT_STORE_REGION,
    },
    { endpoint: config.env.OBJECT_STORE_ENDPOINT, objectPath: bucket, method: 'PUT' },
  );
  const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers });
  // 409 = the bucket is already ours, which is the normal case on a warm stack.
  if (!response.ok && response.status !== 409) {
    throw new Error(`could not ensure bucket ${bucket}: ${response.status}`);
  }
}

describe('Document upload protocol (doc 08 §7, F-03.2)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;
  let config: ConfigService;
  let store: ObjectStore;
  let customer: TestClient;
  let outsider: TestClient;
  let customerOrgId: string;

  async function seedMember(
    orgName: string,
    orgType: 'customer' | 'supplier',
    email: string,
    roleKey: string,
  ): Promise<string> {
    const org = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ($1, $2, $2) RETURNING id`,
      [orgType, orgName],
    );
    const organizationId = org.rows[0]!.id;
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
       SELECT $1, id FROM iam.role WHERE key = $2`,
      [membership.rows[0]!.id, roleKey],
    );
    return organizationId;
  }

  async function signIn(email: string): Promise<TestClient> {
    const client = new TestClient(baseUrl);
    const res = await client.post('/api/v1/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(201);
    expect(client.cookie(SESSION_COOKIE)).toBeTruthy();
    return client;
  }

  async function initiate(
    client: TestClient,
    overrides: Record<string, unknown> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return client.post('/api/v1/documents/uploads', {
      purpose: 'drawing_2d',
      filename: 'bracket-rev-a.pdf',
      declaredMediaType: 'application/pdf',
      ...overrides,
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_dms');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SESSION_COOKIE_NAME'] = SESSION_COOKIE;
    process.env['NODE_ENV'] = 'test';

    config = new ConfigService();
    store = new ObjectStore(config);
    await ensureBucket(config, config.env.OBJECT_STORE_BUCKET_QUARANTINE);
    await ensureBucket(config, config.env.OBJECT_STORE_BUCKET_CLEAN);

    pg = new Client({ connectionString: db.url });
    await pg.connect();
    customerOrgId = await seedMember(
      'Ashok Precision',
      'customer',
      'buyer@customer.test',
      'customer_requester',
    );
    await seedMember('Other Works', 'customer', 'other@customer.test', 'customer_requester');

    ({ app, baseUrl } = await createTestApp());
    customer = await signIn('buyer@customer.test');
    outsider = await signIn('other@customer.test');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('takes a file from grant to processing version, with audit and scan event', async () => {
    const bytes = Buffer.from('%PDF-1.7 bracket drawing rev A');
    const sha256 = sha256Of(bytes);

    const started = await initiate(customer, { byteSize: bytes.byteLength, sha256 });
    expect(started.status).toBe(201);
    const grant = started.body['grant'] as Grant;
    expect(grant.method).toBe('PUT');
    expect(grant.headers['x-amz-checksum-sha256']).toBe(Buffer.from(sha256, 'hex').toString('base64'));

    const uploaded = await putWithGrant(grant, bytes);
    expect(uploaded.status).toBe(200);

    const sessionId = started.body['uploadSessionId'] as string;
    const finalized = await customer.post(
      `/api/v1/documents/uploads/${sessionId}/finalize`,
      { byteSize: bytes.byteLength, sha256, title: 'Bracket drawing' },
    );
    expect(finalized.status).toBe(201);
    expect(finalized.body['versionNo']).toBe(1);
    // Never grantable on arrival: it waits behind the scan (F-03.3).
    expect(finalized.body['status']).toBe('processing');
    expect(finalized.body['scanState']).toBe('quarantined');

    const manifest = await customer.get(
      `/api/v1/documents/${finalized.body['documentId'] as string}/manifest`,
    );
    expect(manifest.status).toBe(200);
    const versions = manifest.body['versions'] as Array<Record<string, unknown>>;
    expect(versions).toHaveLength(1);
    expect(versions[0]?.['sha256']).toBe(sha256);
    expect(versions[0]?.['byteSize']).toBe(bytes.byteLength);

    const audit = await pg.query<{ action: string }>(
      `SELECT action FROM platform.audit_event WHERE action LIKE 'dms.%' ORDER BY occurred_at`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['dms.upload_initiated', 'dms.upload_finalized']),
    );
    const outbox = await pg.query<{ event_type: string; aggregate_id: string }>(
      `SELECT event_type, aggregate_id FROM platform.outbox_event WHERE event_type = 'dms.file_finalized'`,
    );
    expect(outbox.rowCount).toBe(1);
  });

  it('lists the version an attach would use, with the states that decide it', async () => {
    const bytes = Buffer.from('%PDF-1.7 attachable drawing');
    const sha256 = sha256Of(bytes);
    const started = await initiate(customer, { byteSize: bytes.byteLength, sha256 });
    await putWithGrant(started.body['grant'] as Grant, bytes);
    const finalized = await customer.post(
      `/api/v1/documents/uploads/${started.body['uploadSessionId'] as string}/finalize`,
      { byteSize: bytes.byteLength, sha256, title: 'Attachable drawing' },
    );
    const documentId = finalized.body['documentId'] as string;
    const versionId = finalized.body['documentVersionId'] as string;

    const listed = async (): Promise<Record<string, unknown> | undefined> => {
      const res = await customer.get('/api/v1/documents');
      return (res.body['documents'] as Array<Record<string, unknown>>).find(
        (doc) => doc['documentId'] === documentId,
      );
    };

    // Before the scan the version exists but is unusable, and the list says both.
    const waiting = await listed();
    expect(waiting?.['currentVersionId']).toBe(versionId);
    expect(waiting?.['currentVersionStatus']).toBe('processing');
    expect(waiting?.['currentVersionScanState']).toBe('quarantined');

    // The scan machine is one-way (doc 09 §4): quarantined → scanning → verdict.
    for (const state of ['scanning', 'clean']) {
      await pg.query(
        `UPDATE dms.file_object SET scan_state = $2
          WHERE id = (SELECT file_object_id FROM dms.document_version WHERE id = $1)`,
        [versionId, state],
      );
    }
    await pg.query(`UPDATE dms.document_version SET status = 'available' WHERE id = $1`, [
      versionId,
    ]);

    // Cleared: this is the row the enquiry wizard reads to decide whether attaching is
    // even offered, so it must name the version, not just the document.
    const cleared = await listed();
    expect(cleared?.['currentVersionId']).toBe(versionId);
    expect(cleared?.['currentVersionStatus']).toBe('available');
    expect(cleared?.['currentVersionScanState']).toBe('clean');

    const manifest = await customer.get(`/api/v1/documents/${documentId}/manifest`);
    const summary = manifest.body['document'] as Record<string, unknown>;
    expect(summary['currentVersionId']).toBe(versionId);
    expect(summary['currentVersionScanState']).toBe('clean');
  });

  it('refuses a purpose the file does not fit: size, media type, extension', async () => {
    const sha256 = sha256Of(Buffer.from('x'));
    const oversize = await initiate(customer, { byteSize: 80 * 1024 * 1024, sha256 });
    expect(oversize.status).toBe(422);
    expect(oversize.body['code']).toBe('UPLOAD_POLICY_REJECTED');

    const wrongType = await initiate(customer, {
      byteSize: 1024,
      sha256,
      declaredMediaType: 'application/x-msdownload',
      filename: 'setup.exe',
    });
    expect(wrongType.status).toBe(422);

    const wrongExtension = await initiate(customer, {
      byteSize: 1024,
      sha256,
      filename: 'drawing.exe',
    });
    expect(wrongExtension.status).toBe(422);
  });

  it('issues a single-purpose grant: one method, one key, one length, one digest, short life', async () => {
    const bytes = Buffer.from('%PDF-1.7 single purpose grant');
    const sha256 = sha256Of(bytes);
    const started = await initiate(customer, { byteSize: bytes.byteLength, sha256 });
    const grant = started.body['grant'] as Grant;

    // Method-bound: the same signature does not authorize a read (the store refuses
    // it either as a bad request or as a signature mismatch — never with the bytes).
    const asRead = await fetch(grant.url, { method: 'GET' });
    expect(asRead.ok).toBe(false);
    expect([400, 403]).toContain(asRead.status);

    // Key-bound: moving the object path invalidates the signature.
    const movedKey = grant.url.replace(/\/([^/?]+)\?/, '/attacker-chosen-key?');
    const elsewhere = await fetch(movedKey, { method: 'PUT', headers: grant.headers, body: bytes });
    expect(elsewhere.status).toBe(403);

    // Length-bound: the declared length is inside the signature, so a larger body
    // cannot be pushed through the grant — altering or dropping a signed header to
    // make room is refused too.
    const oversize = await fetch(grant.url, { method: 'PUT', body: Buffer.alloc(5_000, 0x41) });
    expect(oversize.ok).toBe(false);
    expect([400, 403]).toContain(oversize.status);

    // Digest-bound: same length, different bytes — the store itself rejects them,
    // so a swapped payload never reaches quarantine, let alone a document version.
    const tampered = await putWithGrant(grant, Buffer.alloc(bytes.byteLength, 0x41));
    expect(tampered.status).toBe(400);

    // Time-bound.
    const shortLived = store.signUpload({
      key: 'expiry-probe',
      byteSize: bytes.byteLength,
      sha256,
      contentType: 'application/pdf',
      ttlSeconds: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const expired = await putWithGrant(shortLived, bytes);
    expect(expired.status).toBe(403);
  });

  it('fails closed when the finalize declaration does not match the stored bytes', async () => {
    const bytes = Buffer.from('%PDF-1.7 mismatch case');
    const sha256 = sha256Of(bytes);
    const started = await initiate(customer, { byteSize: bytes.byteLength, sha256 });
    const sessionId = started.body['uploadSessionId'] as string;
    expect((await putWithGrant(started.body['grant'] as Grant, bytes)).status).toBe(200);

    const wrongHash = await customer.post(`/api/v1/documents/uploads/${sessionId}/finalize`, {
      byteSize: bytes.byteLength,
      sha256: sha256Of(Buffer.from('a different file entirely')),
    });
    expect(wrongHash.status).toBe(409);
    expect(wrongHash.body['code']).toBe('UPLOAD_VERIFICATION_FAILED');

    // Rejection is terminal: the session is dead and no version exists.
    const versions = await pg.query(
      `SELECT v.id FROM dms.document_version v
         JOIN dms.file_object f ON f.id = v.file_object_id
        WHERE f.sha256 = $1`,
      [sha256],
    );
    expect(versions.rowCount).toBe(0);
    const session = await pg.query<{ status: string }>(
      `SELECT status FROM dms.upload_session WHERE id = $1`,
      [sessionId],
    );
    expect(session.rows[0]?.status).toBe('aborted');
    const rejected = await pg.query(
      `SELECT reason FROM platform.audit_event
        WHERE action = 'dms.upload_rejected' AND subject_id = $1`,
      [sessionId],
    );
    expect(rejected.rowCount).toBe(1);

    const retry = await customer.post(`/api/v1/documents/uploads/${sessionId}/finalize`, {
      byteSize: bytes.byteLength,
      sha256,
    });
    expect(retry.status).toBe(410);
  });

  it('fails closed on a size that disagrees with the session, and on missing bytes', async () => {
    const bytes = Buffer.from('%PDF-1.7 size case');
    const sha256 = sha256Of(bytes);

    const sizeCase = await initiate(customer, { byteSize: bytes.byteLength, sha256 });
    await putWithGrant(sizeCase.body['grant'] as Grant, bytes);
    const wrongSize = await customer.post(
      `/api/v1/documents/uploads/${sizeCase.body['uploadSessionId'] as string}/finalize`,
      { byteSize: bytes.byteLength + 10, sha256 },
    );
    expect(wrongSize.status).toBe(409);

    // Nothing ever uploaded: finalize cannot invent a document version.
    const neverUploaded = await initiate(customer, {
      byteSize: bytes.byteLength,
      sha256: sha256Of(Buffer.from('never uploaded')),
    });
    const missing = await customer.post(
      `/api/v1/documents/uploads/${neverUploaded.body['uploadSessionId'] as string}/finalize`,
      { byteSize: bytes.byteLength, sha256: sha256Of(Buffer.from('never uploaded')) },
    );
    expect(missing.status).toBe(409);
    expect(missing.body['code']).toBe('UPLOAD_VERIFICATION_FAILED');
  });

  it('is idempotent: a repeated finalize returns the same version, with or without a key', async () => {
    const bytes = Buffer.from('%PDF-1.7 idempotent finalize');
    const sha256 = sha256Of(bytes);
    const started = await initiate(customer, { byteSize: bytes.byteLength, sha256 });
    const sessionId = started.body['uploadSessionId'] as string;
    await putWithGrant(started.body['grant'] as Grant, bytes);

    const first = await customer.post(`/api/v1/documents/uploads/${sessionId}/finalize`, {
      byteSize: bytes.byteLength,
      sha256,
    });
    const second = await customer.post(`/api/v1/documents/uploads/${sessionId}/finalize`, {
      byteSize: bytes.byteLength,
      sha256,
    });
    expect(second.status).toBe(201);
    expect(second.body['documentVersionId']).toBe(first.body['documentVersionId']);

    const versions = await pg.query(
      `SELECT v.id FROM dms.document_version v WHERE v.document_id = $1`,
      [first.body['documentId']],
    );
    expect(versions.rowCount).toBe(1);
  });

  it('records a new version of the same document, reusing bytes it already holds', async () => {
    const bytes = Buffer.from('%PDF-1.7 revision B drawing');
    const sha256 = sha256Of(bytes);
    const first = await initiate(customer, { byteSize: bytes.byteLength, sha256 });
    await putWithGrant(first.body['grant'] as Grant, bytes);
    const v1 = await customer.post(
      `/api/v1/documents/uploads/${first.body['uploadSessionId'] as string}/finalize`,
      { byteSize: bytes.byteLength, sha256, engineeringRevision: 'B' },
    );
    expect(v1.status).toBe(201);
    const documentId = v1.body['documentId'] as string;

    // Same bytes, new filename, appended to the same document (doc 19 §3).
    const again = await initiate(customer, {
      byteSize: bytes.byteLength,
      sha256,
      filename: 'bracket-renamed.pdf',
      documentId,
      expectedVersion: 2,
    });
    expect(again.status).toBe(201);
    await putWithGrant(again.body['grant'] as Grant, bytes);
    const v2 = await customer.post(
      `/api/v1/documents/uploads/${again.body['uploadSessionId'] as string}/finalize`,
      { byteSize: bytes.byteLength, sha256, engineeringRevision: 'C', expectedVersion: 2 },
    );
    expect(v2.status).toBe(201);
    expect(v2.body['versionNo']).toBe(2);
    expect(v2.body['deduplicated']).toBe(true);

    const files = await pg.query(
      `SELECT id FROM dms.file_object WHERE sha256 = $1 AND owning_organization_id = $2`,
      [sha256, customerOrgId],
    );
    expect(files.rowCount).toBe(1);

    const stale = await initiate(customer, {
      byteSize: bytes.byteLength,
      sha256,
      documentId,
      expectedVersion: 2,
    });
    expect(stale.status).toBe(409);
    expect(stale.body['code']).toBe('VERSION_CONFLICT');
  });

  it('keeps sessions, documents and manifests inside the owning organization', async () => {
    const bytes = Buffer.from('%PDF-1.7 tenant isolation');
    const sha256 = sha256Of(bytes);
    const started = await initiate(customer, { byteSize: bytes.byteLength, sha256 });
    const sessionId = started.body['uploadSessionId'] as string;
    await putWithGrant(started.body['grant'] as Grant, bytes);
    const mine = await customer.post(`/api/v1/documents/uploads/${sessionId}/finalize`, {
      byteSize: bytes.byteLength,
      sha256,
    });

    const stolenFinalize = await outsider.post(
      `/api/v1/documents/uploads/${sessionId}/finalize`,
      { byteSize: bytes.byteLength, sha256 },
    );
    expect(stolenFinalize.status).toBe(410);

    const stolenManifest = await outsider.get(
      `/api/v1/documents/${mine.body['documentId'] as string}/manifest`,
    );
    expect(stolenManifest.status).toBe(404);

    const theirList = await outsider.get('/api/v1/documents');
    expect((theirList.body['documents'] as unknown[]).length).toBe(0);
  });

  it('closes an expired upload window instead of accepting late bytes', async () => {
    const bytes = Buffer.from('%PDF-1.7 late arrival');
    const sha256 = sha256Of(bytes);
    const started = await initiate(customer, { byteSize: bytes.byteLength, sha256 });
    const sessionId = started.body['uploadSessionId'] as string;
    await putWithGrant(started.body['grant'] as Grant, bytes);
    await pg.query(`UPDATE dms.upload_session SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      sessionId,
    ]);

    const late = await customer.post(`/api/v1/documents/uploads/${sessionId}/finalize`, {
      byteSize: bytes.byteLength,
      sha256,
    });
    expect(late.status).toBe(410);
    expect(late.body['code']).toBe('UPLOAD_SESSION_INVALID');
  });
});
