import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, CARRIER_SECRET, ok, Pilot, type SourcedDeal } from './driver';

/**
 * Pilot scenario 10 (doc 19 §10; IN-16 F-16.6): a short and damaged supplier shipment. Two
 * released lots ship in three packages and the carrier reports delivery, which receives nothing.
 * Receiving finds package 2 five short and package 3 damaged: the shipment is held, the damaged
 * pieces quarantined, two discrepancies opened, and the supplier told. Quality scraps the damaged
 * pieces; the shortage is replaced by a further release shipped and received in full. The order
 * reaches `received_jobwork`, and what entered custody equals what is on hand plus what was scrapped.
 */
describe('Pilot 10: short and damaged supplier shipment', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let wp: string;
  let gauge: string;
  let first: Body;

  const items = (s: Body): Body[] => (s['packages'] as Body[]).flatMap((pk) => (pk['items'] as Body[]).map((i) => ({ ...i, packageNo: pk['packageNo'] })));
  const view = async (): Promise<Body> => ok(await p.as.logistics.get(`/api/v1/logistics/work-packages/${wp}`), 200, 'logistics view');
  const orderStatus = async (): Promise<string> => (await p.one<{ status: string }>(`SELECT status FROM orders.sales_order WHERE id = $1`, [deal.orderId])).status;
  const release = (quantity: string, lots: string[]) => p.as.quality.post('/api/v1/quality-releases', { workPackageId: wp, quantity, lots, serials: [] });
  const full = (s: Body): Body => ({
    expectedVersion: s['aggregateVersion'],
    sealIntact: true,
    packages: (s['packages'] as Body[]).map((pk) => ({ packageNo: pk['packageNo'], condition: 'ok' })),
    lines: items(s).map((i) => ({ itemId: i['itemId'], countedQuantity: i['quantity'], acceptedQuantity: i['quantity'] })),
  });

  beforeAll(async () => {
    p = await Pilot.start('scenario10');
    deal = await p.sourceToPurchaseOrder((await p.approvedEnquiry()).enquiryId);
    wp = (await p.intoProduction(deal)).workPackageId;
    gauge = await p.releasedLots(deal, wp, [
      { lot: 'LOT-A', quantity: '60' },
      { lot: 'LOT-B', quantity: '40' },
    ]);
  }, 300_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('ships two released lots in three packages; the carrier’s "delivered" receives nothing', async () => {
    first = await p.shippedToJobWork(deal.purchaseOrderId, [
      { packageNo: 1, weightG: 9000, items: [{ lotCode: 'LOT-A', quantity: '30' }] },
      { packageNo: 2, weightG: 9000, items: [{ lotCode: 'LOT-A', quantity: '30' }] },
      { packageNo: 3, weightG: 12_000, items: [{ lotCode: 'LOT-B', quantity: '40' }] },
    ], 'LR-10-0001');
    expect(await orderStatus()).toBe('in_supplier_to_jobwork_transit');
    const raw = JSON.stringify({ id: 'scn10-dl', reference: 'LR-10-0001', code: 'DL' });
    const ts = String(Math.floor(Date.now() / 1000));
    const hook = await fetch(`${p.baseUrl}/api/v1/webhooks/carriers/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-timestamp': ts, 'x-dev-signature': createHmac('sha256', CARRIER_SECRET).update(`${ts}.${raw}`).digest('hex') },
      body: raw,
    });
    expect(hook.status).toBe(200);
    first = ok(await p.as.logistics.get(`/api/v1/shipments/${first['shipmentId']}`), 200, 'shipment');
    expect(first['status']).toBe('delivered_to_destination');
    expect(await view()).toMatchObject({ received: '0', accepted: '0', lots: [] });
  });

  it('finds package 2 five short and package 3 damaged: hold, quarantine, discrepancies, supplier told', async () => {
    const body = full(first);
    const lines = body['lines'] as Body[];
    lines[1] = { ...lines[1], countedQuantity: '25', acceptedQuantity: '25' };
    lines[2] = { ...lines[2], acceptedQuantity: '36', quarantinedQuantity: '4', damaged: true, note: 'Forklift tine through the carton' };
    (body['packages'] as Body[])[2]!['condition'] = 'damaged';
    first = ok(await p.as.logistics.post(`/api/v1/shipments/${first['shipmentId']}/receive`, body), 201, 'receive');
    expect(first['status']).toBe('discrepancy_hold');
    expect((first['discrepancies'] as Body[]).map((d) => [d['kind'], d['lotCode'], d['quantity']])).toEqual([
      ['shortage', 'LOT-A', '5'],
      ['damage', 'LOT-B', '4'],
    ]);
    expect(await view()).toMatchObject({ ordered: '100', shipped: '100', received: '95', accepted: '91', quarantined: '4', outstanding: '9' });
    await p.dispatchNotifications();
    expect((await p.notices('supplierA')).filter((n) => n.template_key === 'supplier.receiving_discrepancy')).toHaveLength(2);
  });

  it('scraps the damage and replaces the shortage with a further release shipped and received in full', async () => {
    const [shortage, damage] = (first['discrepancies'] as Body[]).map((d) => d['discrepancyId'] as string);
    ok(await p.as.quality.post(`/api/v1/receiving-discrepancies/${damage}/resolve`, { resolution: 'scrapped', note: 'Punctured; not salvageable' }), 201, 'scrap');
    first = ok(await p.as.logistics.post(`/api/v1/receiving-discrepancies/${shortage}/resolve`, { resolution: 'replacement_expected', note: 'Supplier packed 25; sends the balance', caseReference: 'SUP-CASE-10' }), 201, 'replacement');
    expect(first['status']).toBe('accepted');
    expect(await orderStatus()).toBe('in_supplier_to_jobwork_transit');

    // 100 were released against 100 ordered; the 9 that never reached stock may be released again, and no more.
    await p.inspection(wp, 'final', 'LOT-C', gauge);
    expect((await release('10', ['LOT-C'])).body['detail']).toContain('Only 9 of 100 remain to release, including 9 released but never delivered');
    ok(await release('9', ['LOT-C']), 201, 'release the replacement');
    let replacement = await p.shippedToJobWork(deal.purchaseOrderId, [{ packageNo: 1, weightG: 3000, items: [{ lotCode: 'LOT-C', quantity: '9' }] }], 'LR-10-0002');
    replacement = ok(await p.as.logistics.post(`/api/v1/shipments/${replacement['shipmentId']}/receive`, full(replacement)), 201, 'receive the replacement');
    expect(replacement['status']).toBe('accepted');
  });

  it('reaches received at JobWork, with received = on hand + scrapped', async () => {
    expect(await orderStatus()).toBe('received_jobwork');
    expect(await view()).toMatchObject({ ordered: '100', released: '109', shipped: '109', received: '104', accepted: '100', quarantined: '0', scrapped: '4', outstanding: '0' });
    const ledger = await p.one<{ received: string; on_hand: string; scrapped: string }>(
      `SELECT (SELECT sum(received_quantity) FROM logistics.stock_lot WHERE work_package_id = $1)::int::text AS received,
              (SELECT sum(b.quantity) FROM logistics.stock_balance b JOIN logistics.stock_lot t ON t.id = b.lot_id JOIN logistics.custody_location c ON c.id = b.location_id WHERE t.work_package_id = $1 AND c.on_hand)::int::text AS on_hand,
              (SELECT sum(b.quantity) FROM logistics.stock_balance b JOIN logistics.stock_lot t ON t.id = b.lot_id JOIN logistics.custody_location c ON c.id = b.location_id WHERE t.work_package_id = $1 AND c.code = 'OUT-SCRAPPED')::int::text AS scrapped`,
      [wp],
    );
    expect(ledger).toEqual({ received: '104', on_hand: '100', scrapped: '4' });
    expect(await p.auditActions(first['shipmentId'] as string)).toEqual(
      expect.arrayContaining(['logistics.shipment_released', 'logistics.carrier_event_recorded', 'logistics.shipment_received', 'logistics.receiving_discrepancy_opened', 'logistics.receiving_discrepancy_resolved']),
    );
    expect(await p.auditActions(deal.orderId)).toEqual(expect.arrayContaining(['orders.sales_order_in_transit', 'orders.sales_order_received_jobwork']));
  });
});
