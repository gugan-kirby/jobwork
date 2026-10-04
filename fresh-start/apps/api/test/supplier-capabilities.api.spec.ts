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
import { createTestApp } from './helpers/boot';
import { TestClient } from './helpers/http';

const PASSWORD = 'capability-test-password-1';
const SERVICE_SECRET = 'test-service-token-secret';

describe('Supplier capabilities and eligibility (F-04.3, F-04.4)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;

  let supplierOrgId: string;
  let supplier: TestClient;
  let customer: TestClient;
  let sourcing: TestClient;

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

  async function seedOrg(
    type: 'supplier' | 'internal' | 'customer',
    name: string,
  ): Promise<string> {
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

  /**
   * Takes the supplier all the way to eligible: mandatory evidence verified, the file
   * completed, submitted, and admitted by a different person (F-SO.5). Verifying the
   * last certificate no longer admits anybody — admission is a decision.
   */
  async function verifySupplier(): Promise<void> {
    for (const kind of ['gst', 'pan', 'bank_account']) {
      const submitted = await supplier.post('/api/v1/suppliers/me/verification', { kind });
      await sourcing.post(
        `/api/v1/suppliers/verification/${submitted.body['verificationItemId'] as string}/review`,
        {
          decision: 'verify',
          expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
        },
      );
    }

    const current = await supplier.get('/api/v1/suppliers/me');
    const profile = current.body['profile'] as Record<string, unknown>;
    await supplier.post('/api/v1/suppliers/me/profile', {
      expectedVersion: profile['aggregateVersion'],
      tradeName: 'Chennai Precision',
      website: '',
      summary: 'Precision milling and turning for pumps and valves.',
      regionClass: 'chennai_metro',
      yearEstablished: 2009,
      employeeBand: '11-50',
      primaryContactName: 'A. Raman',
      primaryContactEmail: 'raman@supplier.test',
      primaryContactPhone: '+91 90000 00000',
    });
    await supplier.post('/api/v1/suppliers/me/site', {
      label: 'Ambattur unit',
      addressLine1: '12 Ambattur Industrial Estate',
      city: 'Chennai',
      state: 'Tamil Nadu',
      postalCode: '600058',
    });

    const ready = await supplier.get('/api/v1/suppliers/me');
    const readyProfile = ready.body['profile'] as Record<string, unknown>;
    const submitted = await supplier.post('/api/v1/suppliers/me/submit', {
      expectedVersion: readyProfile['aggregateVersion'],
    });
    expect(submitted.status).toBe(201);
    const submittedProfile = submitted.body['profile'] as Record<string, unknown>;
    const approved = await sourcing.post(
      `/api/v1/suppliers/${submittedProfile['supplierProfileId'] as string}/approve`,
      { expectedVersion: submittedProfile['aggregateVersion'] },
    );
    expect(approved.status).toBe(201);
  }

  async function sweep(): Promise<void> {
    await fetch(`${baseUrl}/api/v1/internal/suppliers/verification/sweep`, {
      method: 'POST',
      headers: {
        [SERVICE_TOKEN_HEADER]: mintServiceToken(SERVICE_SECRET, SCAN_WORKER_PRINCIPAL.name),
        'idempotency-key': `sweep-${Math.random().toString(36).slice(2)}`,
      },
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_capability');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = SERVICE_SECRET;
    process.env['NODE_ENV'] = 'test';

    pg = new Client({ connectionString: db.url });
    await pg.connect();
    supplierOrgId = await seedOrg('supplier', 'Chennai Precision Works');
    const customerOrgId = await seedOrg('customer', 'Ashok Industries');
    const internalOrgId = await seedOrg('internal', 'JobWork Operations');
    await seedUser(supplierOrgId, 'admin@supplier.test', ['org_admin']);
    await seedUser(customerOrgId, 'buyer@customer.test', ['customer_requester']);
    await seedUser(internalOrgId, 'sourcing@jobwork.test', ['jobwork_sourcing']);

    ({ app, baseUrl } = await createTestApp());
    supplier = await signIn('admin@supplier.test');
    customer = await signIn('buyer@customer.test');
    sourcing = await signInWithMfa('sourcing@jobwork.test');

    await pg.query(
      `UPDATE supplier.supplier_profile SET region_class = 'chennai_metro'
        WHERE organization_id = $1`,
      [supplierOrgId],
    );
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('publishes a capability against the taxonomy and refuses anything outside it', async () => {
    const taxonomy = await supplier.get('/api/v1/suppliers/me/taxonomy');
    expect(taxonomy.status).toBe(200);
    const codes = (taxonomy.body['capabilities'] as Array<{ code: string }>).map((c) => c.code);
    expect(codes).toContain('cnc_milling');

    const published = await supplier.post('/api/v1/suppliers/me/capabilities', {
      capabilityCode: 'cnc_milling',
      attributes: { toleranceClass: 'IT7', maxLotSize: 500 },
    });
    expect(published.status).toBe(201);
    expect(published.body['versionNo']).toBe(1);
    expect(published.body['status']).toBe('published');

    const invented = await supplier.post('/api/v1/suppliers/me/capabilities', {
      capabilityCode: 'antigravity_forming',
      attributes: {},
    });
    expect(invented.status).toBe(422);
    expect(invented.body['code']).toBe('CAPABILITY_UNKNOWN');

    // Region and profile must exist before the eligibility projection can see anything.
    await pg.query(
      `UPDATE supplier.supplier_profile SET region_class = 'chennai_metro'
        WHERE organization_id = $1`,
      [supplierOrgId],
    );
  });

  it('never rewrites the version an old RFQ matched against (UC-11)', async () => {
    const first = await supplier.get('/api/v1/suppliers/me/capabilities');
    const original = (first.body['capabilities'] as Array<Record<string, unknown>>).find(
      (c) => (c['capability'] as { code: string }).code === 'cnc_milling',
    )!;
    const originalId = original['supplierCapabilityId'] as string;
    expect((original['attributes'] as { toleranceClass: string }).toleranceClass).toBe('IT7');

    const edited = await supplier.post('/api/v1/suppliers/me/capabilities', {
      capabilityCode: 'cnc_milling',
      attributes: { toleranceClass: 'IT6', maxLotSize: 800 },
    });
    expect(edited.status).toBe(201);
    expect(edited.body['versionNo']).toBe(2);
    expect(edited.body['supplierCapabilityId']).not.toBe(originalId);

    // The row an earlier match pointed at still says exactly what it said.
    const frozen = await pg.query<{ status: string; attributes: { toleranceClass: string } }>(
      `SELECT status, attributes FROM supplier.supplier_capability WHERE id = $1`,
      [originalId],
    );
    expect(frozen.rows[0]!.attributes.toleranceClass).toBe('IT7');
    expect(frozen.rows[0]!.status).toBe('superseded');

    // And the database refuses to let anyone edit it after the fact.
    await expect(
      pg.query(
        `UPDATE supplier.supplier_capability SET attributes = '{"toleranceClass":"IT4"}'::jsonb
          WHERE id = $1`,
        [originalId],
      ),
    ).rejects.toThrow(/settled and cannot be edited/);

    const live = await supplier.get('/api/v1/suppliers/me/capabilities');
    expect((live.body['capabilities'] as unknown[]).length).toBe(1);
    const history = await supplier.get('/api/v1/suppliers/me/capabilities?history=true');
    expect((history.body['capabilities'] as unknown[]).length).toBe(2);
  });

  it('versions machines and capacity the same way', async () => {
    const machine = await supplier.post('/api/v1/suppliers/me/machines', {
      machineKey: 'vmc-01',
      label: 'VMC 850',
      capabilityCode: 'cnc_milling',
      quantity: 2,
      axes: 3,
      envelope: { xMm: 800, yMm: 500, zMm: 500, maxWeightKg: 600 },
    });
    expect(machine.status).toBe(201);
    expect(machine.body['versionNo']).toBe(1);

    const bigger = await supplier.post('/api/v1/suppliers/me/machines', {
      machineKey: 'vmc-01',
      label: 'VMC 1050',
      quantity: 2,
      envelope: { xMm: 1000, yMm: 600, zMm: 550 },
    });
    expect(bigger.body['versionNo']).toBe(2);

    const badEnvelope = await supplier.post('/api/v1/suppliers/me/machines', {
      machineKey: 'vmc-02',
      label: 'Broken',
      quantity: 1,
      envelope: { xMm: 800, yMm: 500 },
    });
    expect(badEnvelope.status).toBe(400);

    const capacity = await supplier.post('/api/v1/suppliers/me/capacity', {
      capabilityCode: 'cnc_milling',
      windowStart: '2026-10-01',
      windowEnd: '2026-10-31',
      availableHours: 320,
    });
    expect(capacity.status).toBe(201);

    const backwards = await supplier.post('/api/v1/suppliers/me/capacity', {
      windowStart: '2026-11-30',
      windowEnd: '2026-11-01',
    });
    expect(backwards.status).toBe(400);

    const machines = await supplier.get('/api/v1/suppliers/me/machines');
    expect((machines.body['machines'] as unknown[]).length).toBe(1);
    expect(
      ((machines.body['machines'] as Array<Record<string, unknown>>)[0]!['envelope'] as {
        xMm: number;
      }).xMm,
    ).toBe(1000);
  });

  it('shows a customer capability cards that identify nobody (FR-203)', async () => {
    await verifySupplier();

    const cards = await customer.get('/api/v1/capability-cards?capabilityCodes=cnc_milling');
    expect(cards.status).toBe(200);
    const list = cards.body['cards'] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    const card = list[0]!;

    // The whole payload, serialized, must not contain anything identifying.
    const serialized = JSON.stringify(card);
    for (const forbidden of [
      supplierOrgId,
      'Chennai Precision Works',
      'admin@supplier.test',
      'supplierProfileId',
      'organizationId',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(card).sort()).toEqual([
      'capabilities',
      'cardId',
      'certificationTypes',
      'machineEnvelopeMaxMm',
      'regionClass',
      'verified',
    ]);
    expect(card['regionClass']).toBe('chennai_metro');
    expect(card['verified']).toBe(true);
    expect(card['machineEnvelopeMaxMm']).toEqual({ xMm: 1000, yMm: 600, zMm: 550 });

    // A customer cannot reach the internal eligibility view with its reason codes.
    const internalView = await customer.get('/api/v1/capability-cards/eligibility');
    expect(internalView.status).toBe(403);

    const forSourcing = await sourcing.get('/api/v1/capability-cards/eligibility');
    expect(forSourcing.status).toBe(200);
    const suppliers = forSourcing.body['suppliers'] as Array<Record<string, unknown>>;
    expect(suppliers[0]?.['eligible']).toBe(true);
    expect(suppliers[0]?.['exclusions']).toEqual([]);
  });

  it('drops out of the projection the instant mandatory evidence expires', async () => {
    const before = await customer.get('/api/v1/capability-cards?capabilityCodes=cnc_milling');
    expect((before.body['cards'] as unknown[]).length).toBe(1);

    const item = await pg.query<{ id: string }>(
      `SELECT v.id FROM supplier.verification_item v
         JOIN supplier.supplier_profile p ON p.id = v.supplier_profile_id
        WHERE p.organization_id = $1 AND v.kind = 'gst'
        ORDER BY v.version_no DESC LIMIT 1`,
      [supplierOrgId],
    );

    // Not swept yet: the projection reads the stored date, so the supplier is out the
    // moment the date passes rather than when a job happens to run.
    await pg.query(
      `UPDATE supplier.verification_item SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [item.rows[0]!.id],
    );

    const after = await customer.get('/api/v1/capability-cards?capabilityCodes=cnc_milling');
    expect((after.body['cards'] as unknown[]).length).toBe(0);

    const explained = await sourcing.get('/api/v1/capability-cards/eligibility');
    const record = (explained.body['suppliers'] as Array<Record<string, unknown>>)[0]!;
    expect(record['eligible']).toBe(false);
    expect(record['exclusions']).toEqual(['verification_expired']);

    // Sweeping settles the status; the verdict does not change, only its explanation
    // becomes durable.
    await sweep();
    const settled = await pg.query<{ status: string }>(
      `SELECT status FROM supplier.verification_item WHERE id = $1`,
      [item.rows[0]!.id],
    );
    expect(settled.rows[0]!.status).toBe('expired');
    const stillOut = await sourcing.get('/api/v1/capability-cards/eligibility');
    expect((stillOut.body['suppliers'] as Array<Record<string, unknown>>)[0]!['exclusions']).toEqual(
      ['verification_expired'],
    );
  });

  it('filters on capability, region and certification before anyone is ranked', async () => {
    // Restore eligibility with a fresh GST item.
    const submitted = await supplier.post('/api/v1/suppliers/me/verification', { kind: 'gst' });
    await sourcing.post(
      `/api/v1/suppliers/verification/${submitted.body['verificationItemId'] as string}/review`,
      { decision: 'verify', expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    );

    const wrongCapability = await customer.get(
      '/api/v1/capability-cards?capabilityCodes=injection_moulding',
    );
    expect((wrongCapability.body['cards'] as unknown[]).length).toBe(0);

    const wrongRegion = await customer.get(
      '/api/v1/capability-cards?capabilityCodes=cnc_milling&regionClass=pune_metro',
    );
    expect((wrongRegion.body['cards'] as unknown[]).length).toBe(0);

    const needsIso = await customer.get(
      '/api/v1/capability-cards?capabilityCodes=cnc_milling&certificationTypes=iso9001',
    );
    expect((needsIso.body['cards'] as unknown[]).length).toBe(0);

    await pg.query(
      `INSERT INTO supplier.certification
         (supplier_profile_id, certification_type, status, expires_on)
       SELECT p.id, 'iso9001', 'verified', current_date + 200
         FROM supplier.supplier_profile p WHERE p.organization_id = $1`,
      [supplierOrgId],
    );

    const nowMatches = await customer.get(
      '/api/v1/capability-cards?capabilityCodes=cnc_milling&certificationTypes=iso9001',
    );
    const cards = nowMatches.body['cards'] as Array<Record<string, unknown>>;
    expect(cards).toHaveLength(1);
    expect(cards[0]?.['certificationTypes']).toEqual(['iso9001']);
  });

  it('keeps a supplier out while its organization is suspended, and says so internally', async () => {
    await pg.query(`UPDATE iam.organization SET status = 'suspended' WHERE id = $1`, [
      supplierOrgId,
    ]);

    const cards = await customer.get('/api/v1/capability-cards?capabilityCodes=cnc_milling');
    expect((cards.body['cards'] as unknown[]).length).toBe(0);

    const explained = await sourcing.get('/api/v1/capability-cards/eligibility');
    const record = (explained.body['suppliers'] as Array<Record<string, unknown>>)[0]!;
    expect(record['exclusions']).toContain('organization_suspended');

    await pg.query(`UPDATE iam.organization SET status = 'active' WHERE id = $1`, [supplierOrgId]);
  });
});
