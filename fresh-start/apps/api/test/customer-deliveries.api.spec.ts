import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeliveryCommand } from '../src/modules/logistics/application/delivery.command';
import { type Body, ok, Pilot, type SourcedDeal } from './pilot/driver';

/**
 * IN-17 F-17.4: what the customer sees of its order's last mile (doc 06 §13; doc 03 §3 and §7). The
 * timeline's final rows come from real delivery facts, the next step says whose move it is and by
 * when, the order's documents are listed and each rendered for the customer only, and nothing of the
 * supplier is in any of it — order, deliveries, documents or the conformity certificate.
 */
describe('customer delivery projection and documents (F-17.4)', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let s: Body;

  const allChecked = { neutralCartons: true, supplierMarksRemoved: true, jobworkLabelsApplied: true, packagingNoteFollowed: true };
  const order = async (): Promise<Body> => ok(await p.as.buyer.get(`/api/v1/orders/${deal.orderId}`), 200, 'order');
  const lane = (o: Body, key: string): Body => (o['timeline'] as Body[]).find((l) => l['key'] === key)!;
  const listItem = async (): Promise<Body> => (ok(await p.as.buyer.get('/api/v1/orders'), 200, 'orders')['orders'] as Body[]).find((o) => o['orderId'] === deal.orderId)!;
  const portalQueue = async (key: string): Promise<number> => ((ok(await p.as.buyer.get('/api/v1/portal/summary'), 200, 'summary')['queues'] as Body[]).find((q) => q['key'] === key)!['count']) as number;

  beforeAll(async () => {
    p = await Pilot.start('custview');
    await p.customerSite();
    ({ deal } = await p.atJobWork());
  }, 300_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('asks the customer to confirm the address once a delivery is packed', async () => {
    expect(lane(await order(), 'final_checks')).toMatchObject({ state: 'current', detail: 'Incoming inspection and packing at JobWork.' });
    const context = ok(await p.as.logistics.get(`/api/v1/logistics/sales-orders/${deal.orderId}/dispatch-context`), 200, 'context');
    const packages = (context['lots'] as Body[]).map((l, n) => ({ packageNo: n + 1, weightG: 5000, items: [{ stockLotId: l['stockLotId'], quantity: l['available'] }] }));
    s = ok(await p.as.logistics.post('/api/v1/customer-dispatches', { salesOrderId: deal.orderId, packages, packingCheck: allChecked }), 201, 'plan');
    const o = await order();
    expect(lane(o, 'final_checks')['detail']).toBe('Your delivery is packed. Confirm the delivery address and receiving contact so it can leave.');
    expect(o['nextStep']).toMatchObject({ owner: 'you', label: 'Confirm the delivery address' });
    expect(await listItem()).toMatchObject({ actionNeeded: { kind: 'pay_balance' } });
    expect(await portalQueue('deliveries_awaiting_you')).toBe(1);

    const balance = (ok(await p.as.finance.get(`/api/v1/sales-orders/${deal.orderId}`), 200, 'order')['invoices'] as Body[]).find((i) => i['kind'] === 'balance')!;
    await p.payInvoice(balance['invoiceId'] as string);
    expect(await listItem()).toMatchObject({ actionNeeded: { kind: 'confirm_address', shipmentId: s['shipmentId'], invoiceId: null } });
    ok(await p.as.buyer.post(`/api/v1/deliveries/${s['shipmentId']}/confirm-address`, { expectedVersion: s['aggregateVersion'] }), 201, 'confirm');
    expect(await portalQueue('deliveries_awaiting_you')).toBe(0);
    s = ok(await p.as.logistics.get(`/api/v1/shipments/${s['shipmentId']}`), 200, 'shipment');
    s = ok(await p.as.logistics.post(`/api/v1/customer-dispatches/${s['shipmentId']}/replan`, { expectedVersion: s['aggregateVersion'], packages, documents: { invoiceNumber: balance['number'] }, packingCheck: allChecked }), 201, 'replan');
    s = ok(await p.as.logistics.post(`/api/v1/customer-dispatches/${s['shipmentId']}/submit`, { expectedVersion: s['aggregateVersion'] }), 201, 'submit');
    s = ok(await p.as.logistics.post(`/api/v1/customer-dispatches/${s['shipmentId']}/release`, { expectedVersion: s['aggregateVersion'] }), 201, 'release');
  });

  it('shows the delivery on its way, with the carrier and tracking', async () => {
    s = ok(await p.as.logistics.post(`/api/v1/shipments/${s['shipmentId']}/pickup`, { expectedVersion: s['aggregateVersion'], carrierMode: 'carrier', carrierName: 'Safexpress', trackingReference: 'SX-77001' }), 201, 'pickup');
    const o = await order();
    expect(o['status']).toBe('on_the_way');
    expect(lane(o, 'final_checks')).toMatchObject({ state: 'done', at: expect.any(String) });
    expect(lane(o, 'shipping')).toMatchObject({ state: 'current', detail: expect.stringMatching(/^Dispatched \d{1,2} \w{3} \d{4} with Safexpress, tracking SX-77001\.$/) });
    expect(o['nextStep']).toMatchObject({ owner: 'you', label: 'Prepare to receive' });
  });

  it('asks for confirmation by the due date once delivered, then shows it accepted', async () => {
    s = ok(
      await p.as.logistics.post(`/api/v1/shipments/${s['shipmentId']}/pod`, { expectedVersion: s['aggregateVersion'], receivedByName: 'R. Kumar', receivedAt: new Date().toISOString(), packagesReceived: 2, remarks: 'clean', source: 'driver' }),
      201,
      'POD',
    );
    let o = await order();
    expect(o['status']).toBe('delivery_confirmation_needed');
    expect(lane(o, 'shipping')['state']).toBe('done');
    expect(lane(o, 'delivered')).toMatchObject({ state: 'current', detail: expect.stringMatching(/^Delivered .+\. Accept it, or report a shortage, damage or defect, by \d{1,2} \w{3} \d{4}\.$/) });
    expect(o['nextStep']).toMatchObject({ owner: 'you', label: 'Confirm delivery', detail: expect.stringContaining('your warranty is not affected') });
    expect(await listItem()).toMatchObject({ actionNeeded: { kind: 'confirm_delivery', shipmentId: s['shipmentId'] } });
    expect(await portalQueue('deliveries_awaiting_you')).toBe(1);

    expect(await p.app.get(DeliveryCommand).acceptanceSweep({ id: '00000000-0000-4000-8000-000000000001' }, new Date(Date.now() + 9 * 86_400_000))).toEqual({ deemed: 1 });
    o = await order();
    expect(o['status']).toBe('completed');
    expect(lane(o, 'delivered')).toMatchObject({ state: 'done', detail: expect.stringMatching(/^Taken as accepted on .+: no issue was reported in time\.$/) });
    expect(await listItem()).toMatchObject({ actionNeeded: null });
  });

  it('lists the order’s documents for the customer and renders each for the customer only', async () => {
    const docs = ok(await p.as.buyer.get(`/api/v1/orders/${deal.orderId}/documents`), 200, 'documents') as unknown as Body[];
    expect(docs.map((d) => d['kind'])).toEqual(['quotation', 'invoice', 'invoice', 'delivery_note', 'conformity_certificate', 'proof_of_delivery']);
    for (const d of docs) {
      const rendered = ok(await p.as.buyer.get(`/api/v1${d['path']}`), 200, `render ${d['kind']}`);
      expect(rendered['contentHash']).toMatch(/^[0-9a-f]{64}$/);
    }
    expect((await p.as.outsider.get(`/api/v1/orders/${deal.orderId}/documents`)).status).toBe(404);
    expect((await p.as.supplierA.get(`/api/v1/orders/${deal.orderId}/documents`)).status).toBe(404);
    expect((await p.as.supplierA.get(`/api/v1/deliveries/${s['shipmentId']}/conformity`)).status).toBe(404);
    expect((await p.as.logistics.get(`/api/v1/orders/${deal.orderId}/documents`)).status).toBe(404);
  });

  it('certifies conformity from the released record, by JobWork’s markings', async () => {
    const certificate = ok(await p.as.buyer.get(`/api/v1/deliveries/${s['shipmentId']}/conformity`), 200, 'certificate');
    const html = certificate['html'] as string;
    expect(html).toContain('Certificate of conformance');
    expect(html).toMatch(/QR-\d{4}-\d{4}/);
    expect(html).toContain('First article');
    expect(html).toContain('Final inspection');
    expect(html).toContain('Bore diameter');
    expect(html).toMatch(/12 mm, ≥ 11\.98, ≤ 12\.02 mm/);
    expect(html).toContain('Conforming');
    const internal = ok(await p.as.logistics.get(`/api/v1/customer-dispatches/${s['shipmentId']}/conformity`), 200, 'internal certificate');
    expect(internal['contentHash']).toBe(certificate['contentHash']);
  });

  it('keeps the supplier out of everything the customer reads about delivery', async () => {
    const instruments = (await p.rows<{ asset_tag: string }>(`SELECT asset_tag FROM quality.instrument`)).map((r) => r.asset_tag);
    const shielded = ['Anand', 'Balaji', 'LOT-A', 'LOT-B', deal.purchaseOrders[0]!['number'] as string, deal.purchaseOrderId, p.orgs.supplierA, 'Coimbatore', 'contact@example.test', '+91 90000 00000', 'Bore gauge', ...instruments];
    const texts: string[] = [JSON.stringify(await order()), JSON.stringify(ok(await p.as.buyer.get(`/api/v1/orders/${deal.orderId}/deliveries`), 200, 'deliveries')), JSON.stringify(ok(await p.as.buyer.get(`/api/v1/orders/${deal.orderId}/documents`), 200, 'documents'))];
    for (const path of ['delivery-note', 'pod', 'conformity']) texts.push(ok(await p.as.buyer.get(`/api/v1/deliveries/${s['shipmentId']}/${path}`), 200, path)['html'] as string);
    for (const text of texts) for (const x of shielded) expect(text.toLowerCase(), `${x} leaked`).not.toContain(x.toLowerCase());
  });
});
