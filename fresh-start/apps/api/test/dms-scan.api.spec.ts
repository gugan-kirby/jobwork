import { createHash } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ObjectStoreClient, signRequest } from '@jobwork/object-store';
import {
  mintServiceToken,
  SCAN_WORKER_PRINCIPAL,
  SERVICE_TOKEN_HEADER,
} from '@jobwork/service-auth';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/iam/domain/password';
import { ConfigService } from '../src/platform/config/config.service';
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'scan-test-password-1';
const SERVICE_SECRET = 'test-service-token-secret';
const SCANNER = { name: 'test-scanner', version: '1' };

interface Grant {
  method: string;
  url: string;
  headers: Record<string, string>;
}

describe('Scan pipeline internal commands (F-03.3)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;
  let store: ObjectStoreClient;
  let config: ConfigService;
  let customer: TestClient;

  async function ensureBucket(bucket: string): Promise<void> {
    const signed = signRequest(
      {
        accessKeyId: config.env.OBJECT_STORE_ACCESS_KEY,
        secretAccessKey: config.env.OBJECT_STORE_SECRET_KEY,
        region: config.env.OBJECT_STORE_REGION,
      },
      { endpoint: config.env.OBJECT_STORE_ENDPOINT, objectPath: bucket, method: 'PUT' },
    );
    const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers });
    if (!response.ok && response.status !== 409) {
      throw new Error(`could not ensure bucket ${bucket}: ${response.status}`);
    }
  }

  /** Calls an internal route the way the worker does: service token, no session. */
  async function asWorker(
    path: string,
    body?: unknown,
    opts: { token?: string; idempotencyKey?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = {
      [SERVICE_TOKEN_HEADER]:
        opts.token ?? mintServiceToken(SERVICE_SECRET, SCAN_WORKER_PRINCIPAL.name),
      'idempotency-key': opts.idempotencyKey ?? `k-${Math.random().toString(36).slice(2)}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  }

  /** Puts a real file in quarantine through the public upload protocol. */
  async function uploadFile(content: string): Promise<{
    fileObjectId: string;
    documentId: string;
    documentVersionId: string;
    storageKey: string;
  }> {
    const bytes = Buffer.from(content);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const started = await customer.post('/api/v1/documents/uploads', {
      purpose: 'drawing_2d',
      filename: 'drawing.pdf',
      declaredMediaType: 'application/pdf',
      byteSize: bytes.byteLength,
      sha256,
    });
    expect(started.status).toBe(201);
    const grant = started.body['grant'] as Grant;
    const put = await fetch(grant.url, { method: 'PUT', headers: grant.headers, body: bytes });
    expect(put.status).toBe(200);

    const finalized = await customer.post(
      `/api/v1/documents/uploads/${started.body['uploadSessionId'] as string}/finalize`,
      { byteSize: bytes.byteLength, sha256 },
    );
    expect(finalized.status).toBe(201);

    const row = await pg.query<{ id: string; storage_key: string }>(
      `SELECT f.id, f.storage_key
         FROM dms.file_object f
         JOIN dms.document_version v ON v.file_object_id = f.id
        WHERE v.id = $1`,
      [finalized.body['documentVersionId']],
    );
    return {
      fileObjectId: row.rows[0]!.id,
      storageKey: row.rows[0]!.storage_key,
      documentId: finalized.body['documentId'] as string,
      documentVersionId: finalized.body['documentVersionId'] as string,
    };
  }

  async function versionStatus(id: string): Promise<string> {
    const res = await pg.query<{ status: string }>(
      `SELECT status FROM dms.document_version WHERE id = $1`,
      [id],
    );
    return res.rows[0]!.status;
  }

  async function scanState(id: string): Promise<string> {
    const res = await pg.query<{ scan_state: string }>(
      `SELECT scan_state FROM dms.file_object WHERE id = $1`,
      [id],
    );
    return res.rows[0]!.scan_state;
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_scan');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = SERVICE_SECRET;
    process.env['NODE_ENV'] = 'test';

    config = new ConfigService();
    store = new ObjectStoreClient({
      endpoint: config.env.OBJECT_STORE_ENDPOINT,
      region: config.env.OBJECT_STORE_REGION,
      accessKeyId: config.env.OBJECT_STORE_ACCESS_KEY,
      secretAccessKey: config.env.OBJECT_STORE_SECRET_KEY,
      quarantineBucket: config.env.OBJECT_STORE_BUCKET_QUARANTINE,
      cleanBucket: config.env.OBJECT_STORE_BUCKET_CLEAN,
      uploadTtlSeconds: 900,
      downloadTtlSeconds: 120,
    });
    await ensureBucket(config.env.OBJECT_STORE_BUCKET_QUARANTINE);
    await ensureBucket(config.env.OBJECT_STORE_BUCKET_CLEAN);

    pg = new Client({ connectionString: db.url });
    await pg.connect();
    const org = await pg.query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name)
       VALUES ('customer', 'Scan Test Works', 'Scan Test Works') RETURNING id`,
    );
    const user = await pg.query<{ id: string }>(
      `INSERT INTO iam.user_account
         (email, password_hash, password_params_version, display_name, status, email_verified_at)
       VALUES ('buyer@scan.test', $1, 1, 'Buyer', 'active', now()) RETURNING id`,
      [await hashPassword(PASSWORD)],
    );
    const membership = await pg.query<{ id: string }>(
      `INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`,
      [user.rows[0]!.id, org.rows[0]!.id],
    );
    await pg.query(
      `INSERT INTO iam.membership_role (membership_id, role_id)
       SELECT $1, id FROM iam.role WHERE key IN ('org_admin', 'customer_requester')`,
      [membership.rows[0]!.id],
    );

    ({ app, baseUrl } = await createTestApp());
    customer = new TestClient(baseUrl);
    const login = await customer.post('/api/v1/auth/login', {
      email: 'buyer@scan.test',
      password: PASSWORD,
    });
    expect(login.status).toBe(201);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('admits only the named service principal — no user session, no forged token', async () => {
    const file = await uploadFile('%PDF-1.7 guarded\n%%EOF\n');

    // An org admin with a valid session is still not a service principal.
    const asUser = await customer.post(
      `/api/v1/internal/documents/scans/${file.fileObjectId}/begin`,
    );
    expect(asUser.status).toBe(401);
    expect(asUser.body['code']).toBe('SERVICE_AUTH_FAILED');

    const noToken = await fetch(
      `${baseUrl}/api/v1/internal/documents/scans/${file.fileObjectId}/begin`,
      { method: 'POST' },
    );
    expect(noToken.status).toBe(401);

    const forged = await asWorker(`/api/v1/internal/documents/scans/${file.fileObjectId}/begin`, undefined, {
      token: mintServiceToken('the-wrong-secret', SCAN_WORKER_PRINCIPAL.name),
    });
    expect(forged.status).toBe(401);

    const unknownPrincipal = await asWorker(
      `/api/v1/internal/documents/scans/${file.fileObjectId}/begin`,
      undefined,
      { token: mintServiceToken(SERVICE_SECRET, 'billing-worker') },
    );
    expect(unknownPrincipal.status).toBe(401);

    const expired = await asWorker(
      `/api/v1/internal/documents/scans/${file.fileObjectId}/begin`,
      undefined,
      { token: mintServiceToken(SERVICE_SECRET, SCAN_WORKER_PRINCIPAL.name, -10) },
    );
    expect(expired.status).toBe(401);

    // Nothing above moved the file off quarantine.
    expect(await scanState(file.fileObjectId)).toBe('quarantined');
  });

  it('clears a file: bytes move to the clean bucket and versions become releasable', async () => {
    const file = await uploadFile('%PDF-1.7 clean file\n%%EOF\n');

    const begun = await asWorker(`/api/v1/internal/documents/scans/${file.fileObjectId}/begin`);
    expect(begun.status).toBe(201);
    expect(begun.body['scanState']).toBe('scanning');
    expect(begun.body['storageKey']).toBe(file.storageKey);
    expect(await versionStatus(file.documentVersionId)).toBe('processing');

    const recorded = await asWorker(
      `/api/v1/internal/documents/scans/${file.fileObjectId}/result`,
      {
        verdict: 'clean',
        reason: 'clean',
        detectedMediaType: 'application/pdf',
        scanner: SCANNER,
      },
    );
    expect(recorded.status).toBe(201);
    expect(recorded.body['versionsReleasable']).toBe(1);

    expect(await scanState(file.fileObjectId)).toBe('clean');
    expect(await versionStatus(file.documentVersionId)).toBe('available');

    // Promoted out of quarantine, and the quarantine copy is gone.
    expect(await store.head('clean', file.storageKey)).not.toBeNull();
    expect(await store.head('quarantine', file.storageKey)).toBeNull();

    const events = await pg.query<{ event_type: string }>(
      `SELECT event_type FROM platform.outbox_event WHERE aggregate_id = $1`,
      [file.fileObjectId],
    );
    expect(events.rows.map((r) => r.event_type)).toContain('dms.file_cleared');

    const audit = await pg.query<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM platform.audit_event
        WHERE action = 'dms.scan_recorded' AND subject_id = $1`,
      [file.fileObjectId],
    );
    // Audit distinguishes the service actor from a user (doc 20 §9).
    expect(audit.rows[0]?.actor_type).toBe('service');
    expect(audit.rows[0]?.actor_id).toBe(SCAN_WORKER_PRINCIPAL.id);
  });

  it('quarantines an infected file and keeps the original bytes as evidence', async () => {
    const file = await uploadFile('%PDF-1.7 infected sample\n%%EOF\n');
    await asWorker(`/api/v1/internal/documents/scans/${file.fileObjectId}/begin`);

    const recorded = await asWorker(
      `/api/v1/internal/documents/scans/${file.fileObjectId}/result`,
      {
        verdict: 'infected',
        reason: 'malware_signature',
        detectedMediaType: 'application/pdf',
        scanner: SCANNER,
      },
    );
    expect(recorded.status).toBe(201);
    expect(recorded.body['versionsQuarantined']).toBe(1);
    expect(recorded.body['versionsReleasable']).toBe(0);

    expect(await scanState(file.fileObjectId)).toBe('infected');
    expect(await versionStatus(file.documentVersionId)).toBe('quarantined');
    // Evidence retained where it is, and never promoted (doc 09 §4).
    expect(await store.head('quarantine', file.storageKey)).not.toBeNull();
    expect(await store.head('clean', file.storageKey)).toBeNull();

    const manifest = await customer.get(`/api/v1/documents/${file.documentId}/manifest`);
    const versions = manifest.body['versions'] as Array<Record<string, unknown>>;
    expect(versions[0]?.['status']).toBe('quarantined');
    expect(versions[0]?.['scanState']).toBe('infected');
  });

  it('holds a retriable failure open, then quarantines when retries are exhausted', async () => {
    const file = await uploadFile('%PDF-1.7 flaky scan\n%%EOF\n');
    await asWorker(`/api/v1/internal/documents/scans/${file.fileObjectId}/begin`);

    const transient = await asWorker(
      `/api/v1/internal/documents/scans/${file.fileObjectId}/result`,
      {
        verdict: 'failed',
        reason: 'scanner_timeout',
        detectedMediaType: null,
        scanner: SCANNER,
        retriesExhausted: false,
      },
    );
    expect(transient.status).toBe(201);
    expect(await scanState(file.fileObjectId)).toBe('failed');
    // Still not releasable, and still waiting.
    expect(await versionStatus(file.documentVersionId)).toBe('processing');

    // The retry re-claims the file: failed → scanning is the one legal way back.
    const reclaimed = await asWorker(
      `/api/v1/internal/documents/scans/${file.fileObjectId}/begin`,
    );
    expect(reclaimed.body['scanState']).toBe('scanning');

    const terminal = await asWorker(
      `/api/v1/internal/documents/scans/${file.fileObjectId}/result`,
      {
        verdict: 'failed',
        reason: 'scanner_timeout',
        detectedMediaType: null,
        scanner: SCANNER,
        retriesExhausted: true,
      },
    );
    expect(terminal.status).toBe(201);
    expect(terminal.body['versionsQuarantined']).toBe(1);
    expect(await versionStatus(file.documentVersionId)).toBe('quarantined');
  });

  it('keeps a settled verdict: replay is idempotent, a different verdict conflicts', async () => {
    const file = await uploadFile('%PDF-1.7 settled verdict\n%%EOF\n');
    await asWorker(`/api/v1/internal/documents/scans/${file.fileObjectId}/begin`);
    const body = {
      verdict: 'unsupported',
      reason: 'signature_mismatch',
      detectedMediaType: 'image/png',
      scanner: SCANNER,
    };
    const first = await asWorker(
      `/api/v1/internal/documents/scans/${file.fileObjectId}/result`,
      body,
    );
    expect(first.status).toBe(201);

    // A duplicate delivery of the same verdict is a no-op, not a second settlement.
    const replay = await asWorker(
      `/api/v1/internal/documents/scans/${file.fileObjectId}/result`,
      body,
    );
    expect(replay.status).toBe(201);
    expect(replay.body['scanState']).toBe('unsupported');
    expect(replay.body['versionsQuarantined']).toBe(1);

    const contradiction = await asWorker(
      `/api/v1/internal/documents/scans/${file.fileObjectId}/result`,
      { ...body, verdict: 'clean', reason: 'clean' },
    );
    expect(contradiction.status).toBe(409);
    expect(contradiction.body['code']).toBe('SCAN_VERDICT_CONFLICT');
    expect(await scanState(file.fileObjectId)).toBe('unsupported');
    expect(await store.head('clean', file.storageKey)).toBeNull();

    // A settled file is not re-scannable by simply claiming it again.
    const reclaim = await asWorker(`/api/v1/internal/documents/scans/${file.fileObjectId}/begin`);
    expect(reclaim.body['alreadySettled']).toBe(true);
    expect(reclaim.body['scanState']).toBe('unsupported');
  });

  it('refuses a verdict for a file that does not exist', async () => {
    const missing = await asWorker(
      `/api/v1/internal/documents/scans/00000000-0000-4000-8000-0000000000ff/result`,
      { verdict: 'clean', reason: 'clean', detectedMediaType: null, scanner: SCANNER },
    );
    expect(missing.status).toBe(404);
    expect(missing.body['code']).toBe('FILE_OBJECT_NOT_FOUND');
  });
});
