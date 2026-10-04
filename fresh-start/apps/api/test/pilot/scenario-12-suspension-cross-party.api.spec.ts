import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestClient } from '../helpers/http';
import { type Body, ok, Pilot, type SourcedDeal } from './driver';

/**
 * Pilot scenario 12 (doc 19 §10; doc 11): a supplier user is suspended mid-session, and
 * every party tries to reach records that are not theirs: another supplier's round and
 * purchase order, the customer's unreleased drawing, another customer's quotation, the
 * internal round. Each refusal looks the same for a real id as for an invented one, so a
 * refusal never confirms that something exists.
 */
describe('Pilot 12: user suspension and cross-party access', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let bOnlyRound: string;
  let unreleasedDrawing: string;
  let staleSessionB: TestClient;

  /** The refusal for the real record, and for a random id at the same route. */
  async function refusal(client: TestClient, path: (id: string) => string, realId: string): Promise<{ real: Body; invented: Body }> {
    const real = await client.get(path(realId));
    const invented = await client.get(path(randomUUID()));
    return { real: { status: real.status, code: real.body['code'] }, invented: { status: invented.status, code: invented.body['code'] } };
  }

  beforeAll(async () => {
    p = await Pilot.start('s12');
    const { enquiryId } = await p.approvedEnquiry();
    deal = await p.sourceToPurchaseOrder(enquiryId);
    // A second enquiry whose round invites supplier B only.
    const second = await p.approvedEnquiry();
    ({ rfqId: bOnlyRound } = await p.openRound(second.enquiryId, ['supplierB']));
    // A drawing the customer owns and never released to anyone.
    unreleasedDrawing = await p.cleanDrawing(p.orgs.customer);
    staleSessionB = p.as.supplierB.clone();
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('cuts a suspended user off at the next request and refuses their sign-in', async () => {
    expect((await staleSessionB.get('/api/v1/supplier/rfqs')).status).toBe(200);
    ok(await p.as.admin.post(`/api/v1/admin/users/${p.users.supplierB}/suspend`, { reason: 'Left the company; account under review.' }), 201, 'suspend supplier B user');
    expect((await staleSessionB.get('/api/v1/auth/me')).status).toBe(401);
    expect((await staleSessionB.get(`/api/v1/supplier/rfqs/${bOnlyRound}`)).status).toBe(401);
    expect((await staleSessionB.post(`/api/v1/supplier/rfqs/${bOnlyRound}/bid/submit`, p.bidBody(randomUUID(), 4000))).status).toBe(401);
    await expect(p.signIn('supplierB')).rejects.toThrow(/sign in supplierB/);
  });

  it('refuses suspension to anyone but a security administrator', async () => {
    const bySourcing = await p.as.sourcing.post(`/api/v1/admin/users/${p.users.supplierA}/suspend`, { reason: 'Slow to quote' });
    expect(bySourcing.status).toBe(403);
    const bySupplier = await p.as.supplierA.post(`/api/v1/admin/users/${p.users.buyer}/suspend`, { reason: 'Competitor' });
    expect(bySupplier.status).toBe(403);
    // Even an administrator must say why.
    expect((await p.as.admin.post(`/api/v1/admin/users/${p.users.supplierA}/suspend`, {})).status).toBe(400);
  });

  it('gives a supplier the same answer for another supplier’s round as for one that does not exist', async () => {
    const r = await refusal(p.as.supplierA, (id) => `/api/v1/supplier/rfqs/${id}`, bOnlyRound);
    expect(r.real.status).toBe(404);
    expect(r.real).toEqual(r.invented);
    expect((await p.as.supplierA.post(`/api/v1/supplier/rfqs/${bOnlyRound}/bid/submit`, p.bidBody(randomUUID(), 4000))).status).toBe(404);
    // Nor the internal view of any round.
    expect((await p.as.supplierA.get(`/api/v1/rfqs/${bOnlyRound}`)).status).toBe(403);
  });

  it('keeps the customer’s unreleased drawing from every supplier, and from internal staff without a grant', async () => {
    expect((await p.as.buyer.get(`/api/v1/documents/versions/${unreleasedDrawing}/download`)).status).toBe(200);
    for (const actor of ['supplierA', 'admin'] as const) {
      const r = await refusal(p.as[actor], (id) => `/api/v1/documents/versions/${id}/download`, unreleasedDrawing);
      expect(r.real.status).toBe(404);
      expect(r.real).toEqual(r.invented);
    }
  });

  it('keeps another customer out of this customer’s quotation, order and enquiry', async () => {
    for (const [path, id] of [
      [(x: string) => `/api/v1/quotations/${x}`, deal.quoteId],
      [(x: string) => `/api/v1/orders/${x}`, deal.orderId],
    ] as const) {
      const r = await refusal(p.as.outsider, path, id);
      expect(r.real.status).toBe(404);
      expect(r.real).toEqual(r.invented);
    }
    const accept = await p.as.outsider.post(`/api/v1/quotations/${deal.quoteId}/accept`, deal.accept.body, { headers: { 'idempotency-key': `steal-${randomUUID()}` } });
    expect([403, 404]).toContain(accept.status);
  });

  it('keeps the customer out of the buy side, and suppliers out of each other’s orders', async () => {
    expect((await p.as.buyer.get(`/api/v1/rfqs/${deal.rfqId}`)).status).toBe(403);
    expect((await p.as.buyer.get(`/api/v1/supplier/purchase-orders/${deal.purchaseOrderId}`)).status).toBeGreaterThanOrEqual(403);
    expect((await p.as.approver.get(`/api/v1/sales-orders/${deal.orderId}`)).status).toBe(403);
    const reinstated = await p.as.admin.post(`/api/v1/admin/users/${p.users.supplierB}/reinstate`, { reason: 'Review closed; access restored.' });
    expect(reinstated.status).toBe(201);
    const supplierB = await p.signIn('supplierB');
    const r = await refusal(supplierB, (id) => `/api/v1/supplier/purchase-orders/${id}`, deal.purchaseOrderId);
    expect(r.real.status).toBe(404);
    expect(r.real).toEqual(r.invented);
  });

  it('recovers a reinstated user to exactly what they had, and audits both decisions with their reasons', async () => {
    const supplierB = await p.signIn('supplierB');
    expect((await supplierB.get(`/api/v1/supplier/rfqs/${bOnlyRound}`)).status).toBe(200);
    const trail = await p.rows<{ action: string; actor_id: string; reason: string | null }>(
      `SELECT action, actor_id, reason FROM platform.audit_event WHERE subject_id = $1 ORDER BY occurred_at, id`,
      [p.users.supplierB],
    );
    const decisions = trail.filter((a) => /suspend|reinstat/.test(a.action));
    expect(decisions.map((a) => a.actor_id)).toEqual([p.users.admin, p.users.admin]);
    expect(decisions.map((a) => a.reason)).toEqual(['Left the company; account under review.', 'Review closed; access restored.']);
  });
});
