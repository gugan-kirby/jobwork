import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './pilot/driver';

/**
 * Customer-supplied material (IN-16 F-16.5; D-15; FR-307). The customer's bar stock arrives on its
 * own challan, is received onto lots the customer owns, and is issued to the supplier on JobWork's
 * challan, with every kilogram conserved in the ledger and no trace of the customer on the
 * supplier's side.
 */
describe('Customer-supplied material (F-16.5)', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let customerSite: string;
  let customerName: string;
  let inbound: Body;
  let issue: Body;
  let lotId: string;

  const register = (body: Body = {}, actor: 'logistics' | 'supplierA' = 'logistics') =>
    p.as[actor].post('/api/v1/logistics/customer-material', {
      salesOrderId: deal.orderId,
      originSiteId: customerSite,
      documents: { challanNumber: 'CUST-DC-77' },
      carrierMode: 'carrier',
      carrierName: 'Customer transporter',
      trackingReference: 'LR-9001',
      packages: [{ packageNo: 1, weightG: 125_000, items: [{ lotCode: 'HEAT-4471', quantity: '120.5', unit: 'kg', description: 'EN8 round bar, 40 mm' }] }],
      ...body,
    });
  const material = async (): Promise<Body[]> => ok(await p.as.logistics.get(`/api/v1/logistics/sales-orders/${deal.orderId}/material`), 200, 'material') as unknown as Body[];

  beforeAll(async () => {
    p = await Pilot.start('material');
    deal = await p.sourceToPurchaseOrder((await p.approvedEnquiry()).enquiryId);
    customerSite = (
      await p.one<{ id: string }>(
        `INSERT INTO iam.organization_site (organization_id, label, kind, address_line1, city, state, postal_code) VALUES ($1, 'Customer plant', 'delivery', 'Gate 3, Oragadam', 'Kanchipuram', 'Tamil Nadu', '602105') RETURNING id`,
        [p.orgs.customer],
      )
    ).id;
    customerName = (await p.one<{ display_name: string }>(`SELECT display_name FROM iam.organization WHERE id = $1`, [p.orgs.customer])).display_name;
  }, 240_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('registers the customer’s material on its own challan, by logistics only', async () => {
    expect((await register({}, 'supplierA')).status).toBe(403);
    expect((await register({ originSiteId: p.sites.supplierA })).body['code']).toBe('ORIGIN_NOT_CUSTOMERS');
    expect((await register({ documents: {} })).body['code']).toBe('CHALLAN_REQUIRED');
    // No address given: the order has no delivery site, so the customer's first active address.
    inbound = ok(await register({ originSiteId: undefined }), 201, 'register');
    expect(inbound).toMatchObject({ leg: 'customer_to_jobwork', status: 'picked_up', origin: { label: 'Customer plant' }, destination: { label: 'JobWork receiving hub' }, totalQuantity: '120.5' });
    expect((inbound['packages'] as Body[])[0]!['items']).toEqual([expect.objectContaining({ lotCode: 'HEAT-4471', quantity: '120.5', unit: 'kg' })]);
  });

  it('receives it onto a lot the customer owns, outside the order’s made parts', async () => {
    const item = ((inbound['packages'] as Body[])[0]!['items'] as Body[])[0]!;
    inbound = ok(
      await p.as.logistics.post(`/api/v1/shipments/${inbound['shipmentId']}/receive`, {
        expectedVersion: inbound['aggregateVersion'],
        sealIntact: true,
        packages: [{ packageNo: 1, condition: 'ok' }],
        lines: [{ itemId: item['itemId'], countedQuantity: '120.5', acceptedQuantity: '120.5' }],
      }),
      201,
      'receive',
    );
    expect(inbound['status']).toBe('accepted');
    const [lot] = await material();
    expect(lot).toMatchObject({ lotCode: 'HEAT-4471', unit: 'kg', sourceShipmentNumber: inbound['number'], receivedQuantity: '120.5', inStock: '120.5', issued: '0' });
    lotId = lot!['lotId'] as string;
    expect((await p.one<{ ownership: string }>(`SELECT ownership FROM logistics.stock_lot WHERE id = $1`, [lotId])).ownership).toBe('customer_material');
    // The order's made parts are untouched: nothing of the supplier's has arrived.
    expect((await p.one<{ status: string }>(`SELECT status FROM orders.sales_order WHERE id = $1`, [deal.orderId])).status).not.toBe('received_jobwork');
  });

  it('issues it to the supplier on JobWork’s challan, out of stock and into the ledger’s issued sink', async () => {
    const issueBody = (extra: Body = {}) => ({ purchaseOrderId: deal.purchaseOrderId, destinationSiteId: p.sites.supplierA, documents: { challanNumber: 'JW-DC-0001' }, lots: [{ lotId, quantity: '80' }], ...extra });
    expect((await p.as.logistics.post('/api/v1/logistics/material-issues', issueBody({ lots: [{ lotId, quantity: '130' }] }))).body['code']).toBe('NOT_IN_STOCK');
    expect((await p.as.logistics.post('/api/v1/logistics/material-issues', issueBody({ destinationSiteId: p.sites.supplierB }))).body['code']).toBe('DESTINATION_NOT_SUPPLIERS');
    expect((await p.as.logistics.post('/api/v1/logistics/material-issues', issueBody({ documents: {} }))).body['code']).toBe('CHALLAN_REQUIRED');
    expect((await p.as.supplierA.post('/api/v1/logistics/material-issues', issueBody())).status).toBe(403);
    // No destination given: the supplier's works address.
    issue = ok(await p.as.logistics.post('/api/v1/logistics/material-issues', issueBody({ destinationSiteId: undefined })), 201, 'issue');
    expect(issue).toMatchObject({ leg: 'jobwork_to_supplier', status: 'released', documents: { challanNumber: 'JW-DC-0001' }, origin: { label: 'JobWork receiving hub' }, destination: { city: 'Coimbatore' } });
    expect(await material()).toEqual([expect.objectContaining({ inStock: '40.5', issued: '80' })]);
    issue = ok(await p.as.logistics.post(`/api/v1/shipments/${issue['shipmentId']}/pickup`, { expectedVersion: issue['aggregateVersion'], carrierMode: 'jobwork_vehicle', carrierName: 'JobWork van', trackingReference: 'TN-09-AB-1234' }), 201, 'pickup');
    expect(issue['status']).toBe('picked_up');
  });

  it('shows the supplier its material with no trace of the customer, and takes its receipt', async () => {
    const seen = ok(await p.as.supplierA.get(`/api/v1/supplier/shipments/${issue['shipmentId']}`), 200, 'supplier view');
    const text = JSON.stringify(seen);
    for (const secret of [customerName, 'CUST-DC-77', 'Customer plant', 'Kanchipuram', 'Oragadam', p.orgs.customer, deal.orderId]) expect(text).not.toContain(secret);
    expect(seen).toMatchObject({ salesOrderId: null, documents: { challanNumber: 'JW-DC-0001' }, origin: { label: 'JobWork receiving hub' } });
    expect(((await p.as.supplierA.get('/api/v1/supplier/shipments')).body as unknown as Body[]).map((s) => s['shipmentId'])).toEqual([issue['shipmentId']]);
    expect((await p.as.supplierA.get(`/api/v1/supplier/shipments/${inbound['shipmentId']}`)).status).toBe(404);
    expect((await p.as.supplierB.get(`/api/v1/supplier/shipments/${issue['shipmentId']}`)).status).toBe(404);
    expect((await p.as.supplierA.post(`/api/v1/supplier/shipments/${issue['shipmentId']}/submit`, { expectedVersion: seen['aggregateVersion'] })).status).toBe(404);
    expect((await p.as.supplierB.post(`/api/v1/supplier/shipments/${issue['shipmentId']}/acknowledge-receipt`, { expectedVersion: seen['aggregateVersion'] })).status).toBe(404);
    const done = ok(await p.as.supplierA.post(`/api/v1/supplier/shipments/${issue['shipmentId']}/acknowledge-receipt`, { expectedVersion: seen['aggregateVersion'], note: '80 kg of HEAT-4471 received' }), 201, 'acknowledge');
    expect(done['status']).toBe('accepted');
  });

  it('conserves every kilogram: in stock plus issued is what was received', async () => {
    const balances = await p.rows<{ code: string; q: string }>(
      `SELECT c.code, b.quantity::text AS q FROM logistics.stock_balance b JOIN logistics.custody_location c ON c.id = b.location_id WHERE b.lot_id = $1 AND b.quantity <> 0 ORDER BY c.code`,
      [lotId],
    );
    expect(balances.map((b) => [b.code, Number(b.q)])).toEqual([
      ['JW-STOCK', 40.5],
      ['OUT-ISSUED', 80],
    ]);
    expect((await p.one<{ received: string }>(`SELECT received_quantity::text AS received FROM logistics.stock_lot WHERE id = $1`, [lotId])).received).toBe('120.5000');
  });
});
