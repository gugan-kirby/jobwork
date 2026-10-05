import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './pilot/driver';

type Line = { countedQuantity?: string; acceptedQuantity?: string; quarantinedQuantity?: string; refusedQuantity?: string; identity?: string; damaged?: boolean; note?: string };

/**
 * JobWork receiving over HTTP (IN-16 F-16.3; doc 10 §13; doc 05 §17; BR-LOG-04). Every counted
 * piece is accepted, quarantined or refused; a difference opens a discrepancy and holds the
 * shipment; ordered and shipped never change; the ledger conserves what entered custody.
 */
describe('JobWork receiving (F-16.3)', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let wp: string;
  let s1: Body;
  let s2: Body;
  let deal2: SourcedDeal;
  let wp2: string;

  const items = (s: Body): Body[] => (s['packages'] as Body[]).flatMap((pk) => (pk['items'] as Body[]).map((i) => ({ ...i, packageNo: pk['packageNo'] })));
  /** A receipt that counts every item as shipped and accepts it, with per-package overrides. */
  const receipt = (s: Body, lines: Record<number, Line> = {}, extra: Body = {}): Body => ({
    expectedVersion: s['aggregateVersion'],
    sealIntact: true,
    packages: (s['packages'] as Body[]).map((pk) => ({ packageNo: pk['packageNo'], condition: 'ok' })),
    lines: items(s).map((i) => ({ itemId: i['itemId'], countedQuantity: i['quantity'], acceptedQuantity: i['quantity'], ...lines[i['packageNo'] as number] })),
    ...extra,
  });
  const receive = (s: Body, body: Body) => p.as.logistics.post(`/api/v1/shipments/${s['shipmentId']}/receive`, body);
  const view = async (workPackageId: string): Promise<Body> => ok(await p.as.logistics.get(`/api/v1/logistics/work-packages/${workPackageId}`), 200, 'logistics view');
  const orderStatus = async (orderId: string): Promise<string> => (await p.one<{ status: string }>(`SELECT status FROM orders.sales_order WHERE id = $1`, [orderId])).status;
  const lot = (n: number, code: string, quantity: number) => ({ packageNo: n, weightG: 9000, items: [{ lotCode: code, quantity: String(quantity) }] });

  beforeAll(async () => {
    p = await Pilot.start('receiving');
    deal = await p.sourceToPurchaseOrder((await p.approvedEnquiry()).enquiryId);
    wp = (await p.intoProduction(deal)).workPackageId;
    await p.releasedLots(deal, wp, [
      { lot: 'LOT-A', quantity: '60' },
      { lot: 'LOT-B', quantity: '40' },
    ]);
    s1 = await p.shippedToJobWork(deal.purchaseOrderId, [lot(1, 'LOT-A', 30), lot(2, 'LOT-A', 30)]);
    deal2 = await p.sourceToPurchaseOrder((await p.approvedEnquiry()).enquiryId);
    wp2 = (await p.intoProduction(deal2)).workPackageId;
    await p.releasedLots(deal2, wp2, [{ lot: 'LOT-C', quantity: '100' }]);
  }, 300_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('receives a partial, multi-package shipment as counted, by JobWork logistics only', async () => {
    expect((await p.as.supplierA.post(`/api/v1/shipments/${s1['shipmentId']}/receive`, receipt(s1))).status).toBe(403);
    expect((await p.as.quality.post(`/api/v1/shipments/${s1['shipmentId']}/receive`, receipt(s1))).status).toBe(403);
    const partial = receipt(s1);
    expect((await receive(s1, { ...partial, lines: (partial['lines'] as Body[]).slice(1) })).body['code']).toBe('RECEIVING_INCOMPLETE');
    expect((await receive(s1, receipt(s1, { 1: { acceptedQuantity: '29' } }))).body['code']).toBe('RECEIVING_SPLIT');
    expect((await receive(s1, receipt(s1, { 1: { countedQuantity: '31', acceptedQuantity: '31' } }))).body['code']).toBe('ACCEPT_BEYOND_SHIPPED');
    expect((await receive(s1, receipt(s1, { 1: { identity: 'mismatch' } }))).body['code']).toBe('ACCEPT_UNSOUND');
    expect((await receive(s1, receipt(s1, { 1: { damaged: true } }))).body['code']).toBe('DAMAGE_UNSPLIT');
    expect((await receive(s1, receipt(s1, {}, { photoDocumentVersionIds: [await p.cleanDrawing(p.orgs.supplierA)] }))).body['code']).toBe('PHOTO_UNAVAILABLE');

    s1 = ok(await receive(s1, receipt(s1, {}, { photoDocumentVersionIds: [await p.cleanDrawing(p.orgs.internal)] })), 201, 'receive');
    expect(s1).toMatchObject({ status: 'accepted', discrepancies: [], receiving: { decision: 'accept', packagesReceived: 2, sealIntact: true } });
    expect((s1['receiving'] as Body)['lines']).toEqual([
      expect.objectContaining({ lotCode: 'LOT-A', shippedQuantity: '30', countedQuantity: '30', split: { accepted: '30', quarantined: '0', refused: '0' } }),
      expect.objectContaining({ lotCode: 'LOT-A', shippedQuantity: '30', countedQuantity: '30', split: { accepted: '30', quarantined: '0', refused: '0' } }),
    ]);
    expect((await receive(s1, receipt(s1))).body['code']).toBe('SHIPMENT_STATUS');
    expect(await view(wp)).toMatchObject({
      ordered: '100',
      released: '100',
      shipped: '60',
      received: '60',
      accepted: '60',
      quarantined: '0',
      outstanding: '40',
      lots: [{ lotCode: 'LOT-A', sourceShipmentNumber: s1['number'], receivedQuantity: '60', ownership: 'jobwork', balances: [{ locationCode: 'JW-STOCK', label: 'JobWork stock', onHand: true, quantity: '60' }] }],
    });
    expect(await orderStatus(deal.orderId)).toBe('in_supplier_to_jobwork_transit');
  });

  it('holds a short and damaged shipment, changing neither what was ordered nor what was shipped', async () => {
    s2 = await p.shippedToJobWork(deal.purchaseOrderId, [lot(1, 'LOT-B', 20), lot(2, 'LOT-B', 20)]);
    const body = receipt(s2, { 1: { countedQuantity: '18', acceptedQuantity: '18' }, 2: { acceptedQuantity: '16', quarantinedQuantity: '3', refusedQuantity: '1', damaged: true, note: 'crushed corner' } });
    (body['packages'] as Body[])[1]!['condition'] = 'damaged';
    s2 = ok(await receive(s2, body), 201, 'receive');
    expect(s2).toMatchObject({ status: 'discrepancy_hold', totalQuantity: '40', receiving: { decision: 'partial' } });
    expect((s2['discrepancies'] as Body[]).map((d) => [d['kind'], d['lotCode'], d['quantity'], d['status']])).toEqual([
      ['shortage', 'LOT-B', '2', 'open'],
      ['damage', 'LOT-B', '4', 'open'],
    ]);
    expect(items(s2).map((i) => i['quantity'])).toEqual(['20', '20']);
    expect((await p.one<{ q: string }>(`SELECT sum(quantity)::int::text AS q FROM orders.purchase_order_line WHERE purchase_order_id = $1`, [deal.purchaseOrderId])).q).toBe('100');
    expect(await view(wp)).toMatchObject({ shipped: '100', received: '98', accepted: '94', quarantined: '3', scrapped: '0', outstanding: '6' });

    await p.dispatchNotifications();
    expect((await p.notices('supplierA')).filter((n) => n.template_key === 'supplier.receiving_discrepancy').map((n) => n.title)).toEqual(
      expect.arrayContaining([`${s2['number']}: a shortage on LOT-B at receiving`, `${s2['number']}: damage on LOT-B at receiving`]),
    );
  });

  it('shows the supplier its discrepancies but not JobWork’s stock', async () => {
    const seen = ok(await p.as.supplierA.get(`/api/v1/supplier/shipments/${s2['shipmentId']}`), 200, 'supplier view');
    expect((seen['discrepancies'] as Body[]).map((d) => d['kind'])).toEqual(['shortage', 'damage']);
    expect(((seen['receiving'] as Body)['lines'] as Body[]).map((l) => [l['countedQuantity'], l['split']])).toEqual([
      ['18', null],
      ['20', null],
    ]);
    expect((await p.as.supplierA.get(`/api/v1/logistics/work-packages/${wp}`)).status).toBe(403);
    expect((await p.as.supplierB.get(`/api/v1/supplier/shipments/${s2['shipmentId']}`)).status).toBe(404);
    expect((await p.as.buyer.get(`/api/v1/logistics/work-packages/${wp}`)).status).toBe(403);
  });

  it('resolves each discrepancy once: logistics the shortage, quality the damaged pieces', async () => {
    const [shortage, damage] = (s2['discrepancies'] as Body[]).map((d) => d['discrepancyId'] as string);
    const resolve = (actor: 'logistics' | 'quality', id: string, resolution: string, note = 'Agreed with the supplier on the call') => p.as[actor].post(`/api/v1/receiving-discrepancies/${id}/resolve`, { resolution, note });
    expect((await resolve('quality', shortage!, 'accept_shortage')).status).toBe(403);
    expect((await resolve('logistics', damage!, 'scrapped')).status).toBe(403);
    expect((await resolve('logistics', damage!, 'document_corrected')).body['code']).toBe('RESOLUTION_NOT_ALLOWED');
    s2 = ok(await resolve('logistics', shortage!, 'accept_shortage', 'The supplier packed 18; the 2 stay owed'), 201, 'accept shortage');
    expect(s2['status']).toBe('discrepancy_hold');
    s2 = ok(await resolve('quality', damage!, 'scrapped', 'Dented beyond the cosmetic limit'), 201, 'scrap');
    expect(s2['status']).toBe('accepted');
    expect((s2['discrepancies'] as Body[]).map((d) => [d['status'], d['resolution']])).toEqual([
      ['resolved', 'accept_shortage'],
      ['resolved', 'scrapped'],
    ]);
    expect((await resolve('quality', damage!, 'scrapped')).body['code']).toBe('DISCREPANCY_RESOLVED');
    // The 2 short and the 4 damaged stay owed: the remaining commitment is visible (doc 19 §8).
    expect(await view(wp)).toMatchObject({ accepted: '94', quarantined: '0', scrapped: '3', outstanding: '6' });
    expect(await orderStatus(deal.orderId)).toBe('in_supplier_to_jobwork_transit');
  });

  it('conserves every piece that entered custody, and never ledgers a refused one', async () => {
    const lots = await p.rows<{ lot_code: string; received: string; held: string }>(
      `SELECT t.lot_code, t.received_quantity::int::text AS received, (SELECT sum(b.quantity) FROM logistics.stock_balance b WHERE b.lot_id = t.id)::int::text AS held
         FROM logistics.stock_lot t WHERE t.work_package_id = $1 ORDER BY t.lot_code`,
      [wp],
    );
    expect(lots).toEqual([
      { lot_code: 'LOT-A', received: '60', held: '60' },
      // 18 + 16 accepted and 3 quarantined; the refused piece never entered custody.
      { lot_code: 'LOT-B', received: '37', held: '37' },
    ]);
    await expect(p.one(`UPDATE logistics.receiving_line SET counted_quantity = 20 WHERE counted_quantity = 18 RETURNING id`)).rejects.toThrow();
  });

  it('marks the order received at JobWork once everything ordered is accepted', async () => {
    let s3 = await p.shippedToJobWork(deal2.purchaseOrderId, [lot(1, 'LOT-C', 50), lot(2, 'LOT-C', 50)]);
    s3 = ok(await receive(s3, receipt(s3, { 2: { acceptedQuantity: '46', quarantinedQuantity: '4', damaged: true } }, { documentsMatch: false })), 201, 'receive');
    expect((s3['discrepancies'] as Body[]).map((d) => d['kind'])).toEqual(['damage', 'document_mismatch']);
    expect(await orderStatus(deal2.orderId)).toBe('in_supplier_to_jobwork_transit');
    const [damage, documents] = (s3['discrepancies'] as Body[]).map((d) => d['discrepancyId'] as string);
    ok(await p.as.logistics.post(`/api/v1/receiving-discrepancies/${documents}/resolve`, { resolution: 'document_corrected', note: 'Corrected challan received by email', caseReference: 'DC-201A' }), 201, 'documents');
    s3 = ok(await p.as.quality.post(`/api/v1/receiving-discrepancies/${damage}/resolve`, { resolution: 'released_to_stock', note: 'Scuffs on the packaging only; parts inspected sound' }), 201, 'release to stock');
    expect(s3['status']).toBe('accepted');
    expect(await view(wp2)).toMatchObject({ received: '100', accepted: '100', quarantined: '0', outstanding: '0' });
    expect(await orderStatus(deal2.orderId)).toBe('received_jobwork');
    expect(await p.auditActions(deal2.orderId)).toContain('orders.sales_order_received_jobwork');
  });
});
