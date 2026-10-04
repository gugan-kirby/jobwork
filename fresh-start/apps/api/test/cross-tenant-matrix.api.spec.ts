import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/boot';
import { buildWorld, WORLD_WEBHOOK_SECRET, type ActorKey, type World } from './helpers/world';

/**
 * The consolidated cross-tenant matrix (F-11.5; doc 13 §5; doc 03 §3).
 *
 * Every increment kept its own negative suite; this one asks the same questions of every
 * kind of record at once, on one deal where all of them exist: customer A's enquiry,
 * sourced from supplier 1, accepted, paid and on a purchase order — with customer B and
 * supplier 2 as real, signed-in bystanders. Each probe declares who must be let in and
 * who must be refused; a refusal is 401, 403 or 404 and nothing else. For an external
 * party refused a record by id, the answer for that real id must be the answer for an id
 * that does not exist — a different status would tell them the record is there.
 *
 * Internal roles are asserted only where doc 03 is explicit (a platform administrator has
 * no default access to bids, cost, quotes or orders); other internal scoping is each
 * increment's own suite.
 */

type Probe = {
  name: string;
  path: (w: World, id?: string) => string;
  allow: ActorKey[];
  deny: ActorKey[];
};

const EXTERNAL: ActorKey[] = ['customerA', 'customerB', 'supplier1', 'supplier2'];
const externalBut = (...keep: ActorKey[]): ActorKey[] => EXTERNAL.filter((a) => !keep.includes(a));
const DENIED = [401, 403, 404];

const READS: Probe[] = [
  { name: 'customer enquiry', path: (w, id) => `/enquiries/${id ?? w.enquiryId}`, allow: ['customerA'], deny: externalBut('customerA') },
  { name: 'intake (internal enquiry)', path: (w, id) => `/intake/${id ?? w.enquiryId}`, allow: ['sourcing'], deny: EXTERNAL },
  { name: 'internal RFQ', path: (w, id) => `/rfqs/${id ?? w.rfqId}`, allow: ['sourcing'], deny: EXTERNAL },
  { name: 'supplier RFQ', path: (w, id) => `/supplier/rfqs/${id ?? w.rfqId}`, allow: ['supplier1'], deny: externalBut('supplier1') },
  { name: 'award (bids)', path: (w, id) => `/awards/${id ?? w.awardId}`, allow: ['sourcing'], deny: [...EXTERNAL, 'admin'] },
  { name: 'cost sheet', path: (w, id) => `/cost-sheets/${id ?? w.costSheetId}`, allow: ['sourcing'], deny: [...EXTERNAL, 'admin'] },
  { name: 'internal quote', path: (w, id) => `/quotes/${id ?? w.quoteId}`, allow: ['sales'], deny: [...EXTERNAL, 'admin'] },
  { name: 'customer quotation', path: (w, id) => `/quotations/${id ?? w.quoteId}`, allow: ['customerA'], deny: externalBut('customerA') },
  { name: 'customer order', path: (w, id) => `/orders/${id ?? w.orderId}`, allow: ['customerA'], deny: externalBut('customerA') },
  { name: 'sales order', path: (w, id) => `/sales-orders/${id ?? w.orderId}`, allow: ['sourcing', 'finance'], deny: [...EXTERNAL, 'admin'] },
  { name: 'invoice', path: (w, id) => `/invoices/${id ?? w.invoiceId}`, allow: ['customerA'], deny: externalBut('customerA') },
  { name: 'invoice document', path: (w, id) => `/invoices/${id ?? w.invoiceId}/document`, allow: ['customerA'], deny: externalBut('customerA') },
  { name: 'payment intent', path: (w, id) => `/payments/intents/${id ?? w.intentId}`, allow: ['customerA'], deny: externalBut('customerA') },
  { name: 'supplier purchase order', path: (w, id) => `/supplier/purchase-orders/${id ?? w.purchaseOrderId}`, allow: ['supplier1'], deny: externalBut('supplier1') },
  { name: 'supplier production view', path: (w, id) => `/supplier/purchase-orders/${id ?? w.purchaseOrderId}/production`, allow: ['supplier1'], deny: externalBut('supplier1') },
  { name: 'enquiry conversation', path: (w, id) => `/conversations/enquiry/${id ?? w.enquiryId}`, allow: ['customerA', 'sourcing'], deny: externalBut('customerA') },
  { name: 'purchase-order conversation', path: (w, id) => `/conversations/purchase_order/${id ?? w.purchaseOrderId}`, allow: ['supplier1', 'sourcing'], deny: externalBut('supplier1') },
  { name: 'supplier 360', path: (w, id) => `/suppliers/${id ?? w.supplierProfiles.supplier1}`, allow: ['sourcing'], deny: EXTERNAL },
  { name: 'customer credit', path: (w, id) => `/finance/credit/${id ?? w.orgs.customerA}`, allow: ['finance'], deny: EXTERNAL },
  { name: 'organization administration', path: (w, id) => `/admin/organizations/${id ?? w.orgs.customerA}`, allow: ['admin'], deny: [...EXTERNAL, 'sourcing'] },
  { name: 'governing drawing download', path: (w, id) => `/documents/versions/${id ?? w.drawingVersionId}/download`, allow: ['customerA'], deny: externalBut('customerA') },
  { name: 'audit explorer', path: () => '/audit-events', allow: [], deny: EXTERNAL },
  { name: 'command-center summary', path: () => '/operations/summary', allow: ['sourcing'], deny: EXTERNAL },
  { name: 'work queues', path: () => '/queues', allow: ['sourcing'], deny: EXTERNAL },
  { name: 'controls panel', path: () => '/operations/controls', allow: ['sourcing', 'admin'], deny: EXTERNAL },
  { name: 'dead letters', path: () => '/operations/dead-letters', allow: ['admin'], deny: [...EXTERNAL, 'sourcing'] },
];

/**
 * Internal commands invoked by parties who must never run them. Never sent by an allowed
 * actor: they would change the world. Bodies are valid in shape, so it is authorization —
 * not validation — that refuses them.
 */
const COMMANDS: Array<{ name: string; path: (w: World) => string; body: (w: World) => unknown; deny: ActorKey[] }> = [
  { name: 'issue purchase orders', path: (w) => `/sales-orders/${w.orderId}/purchase-orders`, body: () => ({ expectedVersion: 1 }), deny: EXTERNAL },
  { name: 'suspend a user', path: (w) => `/admin/users/${w.users.customerA}/suspend`, body: () => ({ reason: 'probe' }), deny: [...EXTERNAL, 'sourcing'] },
  { name: 'replay a dead letter', path: () => `/operations/dead-letters/${randomUUID()}/replay`, body: () => ({ reason: 'probe' }), deny: [...EXTERNAL, 'sourcing'] },
  { name: 'take a queue item', path: (w) => `/queues/enquiries_awaiting_triage/items/${w.enquiryId}/take`, body: () => ({ expectedVersion: null }), deny: EXTERNAL },
  { name: 'publish a business calendar', path: () => '/sla/calendars/chennai/versions', body: () => ({ timeZone: 'Asia/Kolkata', workingDays: [1], dayStart: '09:00', dayEnd: '10:00', holidays: [], reason: 'probe', expectedVersion: 1 }), deny: [...EXTERNAL, 'sourcing'] },
  { name: "acknowledge another supplier's purchase order", path: (w) => `/supplier/purchase-orders/${w.purchaseOrderId}/acknowledge`, body: () => ({ expectedVersion: 1, note: '' }), deny: ['supplier2', 'customerA', 'customerB'] },
  { name: "accept another customer's quotation", path: (w) => `/quotations/${w.quoteId}/accept`, body: () => ({ expectedVersion: 1, quoteVersionNo: 1, contentHash: 'a'.repeat(64), termsHash: 'b'.repeat(64), acknowledgeTerms: true }), deny: ['customerB', 'supplier1', 'supplier2'] },
  { name: "post into another customer's enquiry thread", path: (w) => `/conversations/enquiry/${w.enquiryId}/messages`, body: () => ({ audience: 'customer', body: 'probe' }), deny: ['customerB', 'supplier1', 'supplier2'] },
];

describe('Cross-tenant authorization matrix (F-11.5)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  let baseUrl: string;
  let pg: Client;
  let world: World;

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_matrix');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['SERVICE_TOKEN_SECRET'] = 'test-service-token-secret';
    process.env['PAYMENT_WEBHOOK_SECRET'] = WORLD_WEBHOOK_SECRET;
    process.env['NODE_ENV'] = 'test';
    pg = new Client({ connectionString: db.url });
    await pg.connect();
    ({ app, baseUrl } = await createTestApp());
    world = await buildWorld(pg, baseUrl);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.drop();
  });

  it('lets in exactly the parties each record belongs to, and refuses the rest', async () => {
    const wrong: string[] = [];
    for (const probe of READS) {
      const path = `/api/v1${probe.path(world)}`;
      for (const actor of probe.allow) {
        const res = await world.clients[actor].get(path);
        if (res.status < 200 || res.status >= 300) wrong.push(`${probe.name}: ${actor} should be let in, got ${res.status} ${String(res.body['code'] ?? '')}`);
      }
      for (const actor of probe.deny) {
        const res = await world.clients[actor].get(path);
        if (!DENIED.includes(res.status)) wrong.push(`${probe.name}: ${actor} should be refused, got ${res.status}`);
      }
      const anonymous = await world.clients.anonymous.get(path);
      if (anonymous.status !== 401) wrong.push(`${probe.name}: anonymous should get 401, got ${anonymous.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it("answers another party's real id exactly as it answers an id that does not exist", async () => {
    const leaks: string[] = [];
    for (const probe of READS) {
      const real = probe.path(world);
      const missing = probe.path(world, randomUUID());
      if (real === missing) continue; // not addressed by id
      for (const actor of probe.deny.filter((a) => EXTERNAL.includes(a))) {
        const a = await world.clients[actor].get(`/api/v1${real}`);
        const b = await world.clients[actor].get(`/api/v1${missing}`);
        if (a.status !== b.status || a.body['code'] !== b.body['code']) {
          leaks.push(`${probe.name}: ${actor} gets ${a.status} ${String(a.body['code'])} for the real id, ${b.status} ${String(b.body['code'])} for a missing one`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('refuses internal and other parties’ commands, and changes nothing', async () => {
    const before = await pg.query<{ n: string }>(`SELECT count(*) AS n FROM platform.audit_event`);
    const wrong: string[] = [];
    for (const command of COMMANDS) {
      for (const actor of command.deny) {
        const res = await world.clients[actor].post(`/api/v1${command.path(world)}`, command.body(world));
        if (!DENIED.includes(res.status)) wrong.push(`${command.name}: ${actor} should be refused, got ${res.status} ${String(res.body['code'] ?? '')}`);
      }
    }
    expect(wrong).toEqual([]);
    const after = await pg.query<{ n: string }>(`SELECT count(*) AS n FROM platform.audit_event`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('denies detail and download the moment a membership is suspended (doc 19 §9)', async () => {
    const order = `/api/v1/orders/${world.orderId}`;
    const download = `/api/v1/documents/versions/${world.drawingVersionId}/download`;
    expect((await world.clients.customerA.get(order)).status).toBe(200);
    expect((await world.clients.customerA.get(download)).status).toBe(200);
    const suspended = await world.clients.admin.post(`/api/v1/admin/memberships/${world.memberships.customerA}/suspend`, { reason: 'Matrix: revocation takes effect at once' });
    expect(suspended.status).toBe(201);
    expect(DENIED).toContain((await world.clients.customerA.get(order)).status);
    expect(DENIED).toContain((await world.clients.customerA.get(download)).status);
    expect(DENIED).toContain((await world.clients.customerA.get(`/api/v1/conversations/enquiry/${world.enquiryId}`)).status);
  });
});
