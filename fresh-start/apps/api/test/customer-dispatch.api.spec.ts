import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './pilot/driver';

/**
 * IN-17 F-17.2: customer dispatch (doc 10 §12; doc 06 §11; doc 03 §4; BR-LOG-03; UC-33). JobWork
 * logistics packs the order's stock under its own lot markings; the balance falls due; the customer
 * confirms the address; eight guards are computed from real facts and each must be green, or
 * overridden by its owner for exactly the reasons shown; release moves the stock out at the ledger's
 * constraint, and nothing of the supplier reaches the customer.
 */
describe('customer dispatch (F-17.2)', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let siteId: string;
  let first: Body;
  let second: Body;
  let context: Body;

  const allChecked = { neutralCartons: true, supplierMarksRemoved: true, jobworkLabelsApplied: true, packagingNoteFollowed: true };
  const lot = (code: string): Body => (context['lots'] as Body[]).find((l) => l['lotCode'] === code)!;
  const packages = (): Body[] => [
    { packageNo: 1, weightG: 9000, items: [{ stockLotId: lot('LOT-A')['stockLotId'], quantity: '60' }] },
    { packageNo: 2, weightG: 6000, items: [{ stockLotId: lot('LOT-B')['stockLotId'], quantity: '40' }] },
  ];
  const shipment = async (s: Body): Promise<Body> => ok(await p.as.logistics.get(`/api/v1/shipments/${s['shipmentId']}`), 200, 'shipment');
  const guard = (s: Body, key: string): Body => (s['guards'] as Body[]).find((g) => g['key'] === key)!;
  const red = (s: Body): string[] => (s['guards'] as Body[]).filter((g) => !g['pass']).map((g) => g['key'] as string);
  const replan = async (s: Body, extra: Body = {}): Promise<Body> =>
    ok(await p.as.logistics.post(`/api/v1/customer-dispatches/${s['shipmentId']}/replan`, { expectedVersion: s['aggregateVersion'], packages: packages(), documents: s['documents'], packingCheck: (s['delivery'] as Body)['packingCheck'], ...extra }), 201, 'replan');
  const orderStatus = async (): Promise<string> => (await p.one<{ status: string }>(`SELECT status FROM orders.sales_order WHERE id = $1`, [deal.orderId])).status;
  const invoices = async (): Promise<Body[]> => (ok(await p.as.finance.get(`/api/v1/sales-orders/${deal.orderId}`), 200, 'order')['invoices'] as Body[]);

  beforeAll(async () => {
    p = await Pilot.start('custdispatch');
    siteId = await p.customerSite();
    ({ deal } = await p.atJobWork());
    context = ok(await p.as.logistics.get(`/api/v1/logistics/sales-orders/${deal.orderId}/dispatch-context`), 200, 'dispatch context');
  }, 300_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('offers the order’s stock under JobWork’s markings', async () => {
    expect(await orderStatus()).toBe('received_jobwork');
    expect(context).toMatchObject({ ordered: '100', dispatched: '0', partialDelivery: 'not_allowed', sites: [expect.objectContaining({ siteId, label: 'Kovai Pumps plant' })] });
    expect(lot('LOT-A')).toMatchObject({ inStock: '60', available: '60', released: true, receiptOpen: false, heldBy: [], marking: expect.stringMatching(/^JW-[0-9A-F]{8}$/) });
    expect((await p.as.supplierA.get(`/api/v1/logistics/sales-orders/${deal.orderId}/dispatch-context`)).status).toBe(403);
  });

  it('plans by logistics only, from this order’s stock to the customer’s address, and invoices the balance', async () => {
    const body = { salesOrderId: deal.orderId, packages: packages() };
    expect((await p.as.quality.post('/api/v1/customer-dispatches', body)).status).toBe(403);
    expect((await p.as.buyer.post('/api/v1/customer-dispatches', body)).status).toBe(403);
    expect((await p.as.logistics.post('/api/v1/customer-dispatches', { ...body, destinationSiteId: p.sites.supplierA })).body['code']).toBe('DESTINATION_NOT_CUSTOMERS');
    expect((await p.as.logistics.post('/api/v1/customer-dispatches', { ...body, packages: [{ packageNo: 1, items: [{ stockLotId: randomUUID(), quantity: '1' }] }] })).body['code']).toBe('LOT_NOT_ORDER_STOCK');

    expect((await invoices()).map((i) => [i['kind'], i['status']])).toEqual([['advance', 'paid']]);
    first = ok(await p.as.logistics.post('/api/v1/customer-dispatches', body), 201, 'plan');
    expect(first).toMatchObject({ leg: 'jobwork_to_customer', status: 'planned', destination: { label: 'Kovai Pumps plant', city: 'Tiruppur' }, totalQuantity: '100', salesOrderId: deal.orderId });
    const items = (first['packages'] as Body[]).flatMap((pk) => pk['items'] as Body[]);
    expect(items.map((i) => [i['lotCode'], i['sourceLotCode'], i['quantity']])).toEqual([
      [lot('LOT-A')['marking'], 'LOT-A', '60'],
      [lot('LOT-B')['marking'], 'LOT-B', '40'],
    ]);
    // Doc 10 §4: the balance due before dispatch is invoiced now.
    expect((await invoices()).map((i) => [i['kind'], i['status']])).toEqual([
      ['advance', 'paid'],
      ['balance', 'issued'],
    ]);
    expect(red(first)).toEqual(['payment', 'identity', 'address', 'documents']);
    expect(guard(first, 'payment')['reasons']).toEqual([expect.stringMatching(/^Balance \(50 %\) \(INV-\d{4}-\d{4}\): ₹[\d,.]+ open\.$/), 'The customer has no approved credit terms.']);
    expect(first['delivery']).toMatchObject({ orderNumber: deal.order['number'], partialDelivery: 'not_allowed', addressConfirmation: null, overrides: [] });
    await p.dispatchNotifications();
    expect((await p.notices('buyer')).map((n) => n.template_key)).toEqual(expect.arrayContaining(['customer.delivery_address_confirmation', 'customer.invoice_issued']));
  });

  it('has the customer confirm the address; an edit afterwards makes the confirmation stale', async () => {
    const [delivery] = ok(await p.as.buyer.get(`/api/v1/orders/${deal.orderId}/deliveries`), 200, 'deliveries') as unknown as Body[];
    expect(delivery).toMatchObject({ status: 'preparing', addressConfirmation: { needed: true, confirmedAt: null }, destination: { label: 'Kovai Pumps plant' } });
    expect((await p.as.outsider.get(`/api/v1/deliveries/${first['shipmentId']}`)).status).toBe(404);
    expect((await p.as.supplierA.get(`/api/v1/deliveries/${first['shipmentId']}`)).status).toBe(404);
    const confirmed = ok(await p.as.buyer.post(`/api/v1/deliveries/${first['shipmentId']}/confirm-address`, { expectedVersion: delivery!['aggregateVersion'] }), 201, 'confirm address');
    expect(confirmed['addressConfirmation']).toMatchObject({ needed: false, byJobWork: false });
    first = await shipment(first);
    expect(guard(first, 'address')['pass']).toBe(true);

    const site = ((ok(await p.as.buyer.get('/api/v1/organizations/me/sites'), 200, 'sites')['sites'] as Body[]).find((x) => x['siteId'] === siteId))!;
    ok(await p.as.buyer.post('/api/v1/organizations/me/sites', { siteId, label: site['label'], kind: 'delivery', addressLine1: site['addressLine1'], city: site['city'], state: site['state'], postalCode: site['postalCode'], contactName: 'S. Priya', contactPhone: '+91 98400 54321' }), 201, 'edit site');
    first = await shipment(first);
    expect(guard(first, 'address')['reasons']).toEqual(['The address changed after it was confirmed: confirm it again.']);
    expect((first['delivery'] as Body)['addressConfirmation']).toMatchObject({ party: 'customer', current: false });

    expect((await p.as.quality.post(`/api/v1/customer-dispatches/${first['shipmentId']}/address-confirmations`, { expectedVersion: first['aggregateVersion'], note: 'Confirmed by phone' })).status).toBe(403);
    first = ok(await p.as.sales.post(`/api/v1/customer-dispatches/${first['shipmentId']}/address-confirmations`, { expectedVersion: first['aggregateVersion'], note: 'Confirmed by phone with S. Priya, stores' }), 201, 'record confirmation');
    expect(guard(first, 'address')['pass']).toBe(true);
  });

  it('blocks on a document of another order or a malformed e-way bill, until replanned right', async () => {
    first = await replan(first, { documents: { invoiceNumber: 'INV-2099-9999' } });
    expect(guard(first, 'documents')['reasons']).toEqual([`INV-2099-9999 is not an invoice of ${deal.order['number']}.`]);
    const balance = (await invoices()).find((i) => i['kind'] === 'balance')!;
    first = await replan(first, { documents: { invoiceNumber: balance['number'], eWaybillNumber: '1811-XX' } });
    expect(guard(first, 'documents')['reasons']).toEqual(['1811-XX is not a 12-digit e-way bill number.']);
    first = await replan(first, { documents: { invoiceNumber: balance['number'], eWaybillNumber: '1811 0000 0042' }, packingCheck: allChecked });
    expect(red(first)).toEqual(['payment']);
  });

  it('holds a partial delivery the customer did not allow, and catches a supplier’s name on an item', async () => {
    first = await replan(first, { packages: [packages()[0]] });
    expect(red(first)).toEqual(['payment', 'commitment']);
    expect(guard(first, 'commitment')).toMatchObject({ overridable: true, reasons: ['The customer asked for one complete delivery: this ships 60 of the 100 outstanding.'] });
    first = await replan(first, { packages: [{ packageNo: 1, items: [{ stockLotId: lot('LOT-A')['stockLotId'], quantity: '60', description: 'Pump bracket, Anand Engineering batch' }] }, packages()[1]] });
    expect(guard(first, 'identity')).toMatchObject({ pass: false, overridable: false, reasons: ['“Anand Engineering” in an item description names another party.'] });
    first = await replan(first);
    expect(red(first)).toEqual(['payment']);
  });

  it('lets only the hold’s owner override it, for exactly the reasons shown', async () => {
    const url = `/api/v1/customer-dispatches/${first['shipmentId']}/overrides`;
    expect((await p.as.logistics.post(url, { guardKey: 'documents', justification: 'Customer will send it later' })).status).toBe(400);
    expect((await p.as.logistics.post(url, { guardKey: 'address', justification: 'Customer will confirm later' })).status).toBe(400);
    expect((await p.as.logistics.post(url, { guardKey: 'quality', justification: 'Quality says it is fine' })).body['code']).toBe('GUARD_GREEN');
    expect((await p.as.finance.post(url, { guardKey: 'payment', justification: 'Pays on delivery by agreement' })).status).toBe(403);
    first = ok(await p.as.logistics.post(url, { guardKey: 'payment', justification: 'Pays on delivery by agreement with sales' }), 201, 'request override');
    expect(guard(first, 'payment')).toMatchObject({ pass: false, override: { status: 'requested', covers: false } });
    expect((await p.as.logistics.post(url, { guardKey: 'payment', justification: 'Pays on delivery by agreement with sales' })).body['code']).toBe('OVERRIDE_PENDING');
    const [requested] = (first['delivery'] as Body)['overrides'] as Body[];
    expect(requested).toMatchObject({ guardKey: 'payment', requiredRoles: ['jobwork_finance'], status: 'requested' });
    await p.dispatchNotifications();
    expect((await p.notices('finance')).some((n) => n.template_key === 'internal.approval_requested' && n.title.includes(first['number'] as string))).toBe(true);

    // Logistics asked, so logistics may not decide; nor may another domain's owner.
    expect((await p.as.logistics.post(`/api/v1/approvals/${requested!['approvalRequestId']}/decide`, { decision: 'approved', reason: '' })).body['code']).toBe('APPROVAL_SEPARATION');
    expect((await p.as.quality.post(`/api/v1/approvals/${requested!['approvalRequestId']}/decide`, { decision: 'approved', reason: '' })).status).toBe(403);
    ok(await p.decide('finance', requested!['approvalRequestId'] as string, 'approved'), 201, 'finance approves');
    first = await shipment(first);
    expect(guard(first, 'payment')).toMatchObject({ pass: true, override: { status: 'approved', covers: true } });

    // A reason the owner never saw: the override no longer covers.
    const hold = ok(await p.as.finance.post(`/api/v1/finance/credit/${p.orgs.customer}/holds`, { reason: 'Cheque returned unpaid' }), 201, 'place hold');
    first = await shipment(first);
    expect(guard(first, 'payment')).toMatchObject({ pass: false, override: { status: 'approved', covers: false } });
    const holdId = (((hold['credit'] as Body)['activeHolds'] as Body[])[0]!)['holdId'];
    ok(await p.as.finance.post(`/api/v1/finance/credit/${p.orgs.customer}/holds/${holdId}/release`, { reason: 'Cleared on resubmission' }), 201, 'release hold');
    first = await shipment(first);
    expect(guard(first, 'payment')['pass']).toBe(true);
  });

  it('pays, submits and releases: the stock leaves at the constraint, and two releases cannot take the same pieces', async () => {
    await p.payInvoice((await invoices()).find((i) => i['kind'] === 'balance')!['invoiceId'] as string);
    first = await shipment(first);
    expect(guard(first, 'payment')).toMatchObject({ pass: true });

    second = ok(await p.as.logistics.post('/api/v1/customer-dispatches', { salesOrderId: deal.orderId, packages: packages(), documents: first['documents'], packingCheck: allChecked }), 201, 'plan second');
    second = ok(await p.as.sales.post(`/api/v1/customer-dispatches/${second['shipmentId']}/address-confirmations`, { expectedVersion: second['aggregateVersion'], note: 'Same plant, same contact' }), 201, 'confirm second');
    expect(red(second)).toEqual([]);

    expect((await p.as.logistics.post(`/api/v1/customer-dispatches/${first['shipmentId']}/release`, { expectedVersion: first['aggregateVersion'] })).body['code']).toBe('SHIPMENT_STATUS');
    first = ok(await p.as.logistics.post(`/api/v1/customer-dispatches/${first['shipmentId']}/submit`, { expectedVersion: first['aggregateVersion'] }), 201, 'submit');
    second = ok(await p.as.logistics.post(`/api/v1/customer-dispatches/${second['shipmentId']}/submit`, { expectedVersion: second['aggregateVersion'] }), 201, 'submit second');
    expect((await p.as.logistics.post(`/api/v1/shipments/${first['shipmentId']}/release`, { expectedVersion: first['aggregateVersion'] })).body['code']).toBe('SHIPMENT_LEG');
    first = ok(await p.as.logistics.post(`/api/v1/customer-dispatches/${first['shipmentId']}/release`, { expectedVersion: first['aggregateVersion'] }), 201, 'release');
    expect(first).toMatchObject({ status: 'released', destination: { label: 'Kovai Pumps plant', contactName: 'S. Priya' } });
    expect(await orderStatus()).toBe('ready_customer_dispatch');

    const refused = await p.as.logistics.post(`/api/v1/customer-dispatches/${second['shipmentId']}/release`, { expectedVersion: second['aggregateVersion'] });
    expect(refused.body['code']).toBe('SHIPMENT_NOT_READY');
    expect(refused.body['detail']).toMatch(/60 to ship, 0 in JobWork stock/);
    ok(await p.as.logistics.post(`/api/v1/shipments/${second['shipmentId']}/cancel`, { expectedVersion: second['aggregateVersion'], reason: 'Duplicate plan' }), 201, 'cancel second');

    const balances = await p.rows<{ code: string; quantity: string }>(
      `SELECT c.code, SUM(b.quantity)::text AS quantity FROM logistics.stock_balance b JOIN logistics.custody_location c ON c.id = b.location_id JOIN logistics.stock_lot t ON t.id = b.lot_id
        WHERE t.sales_order_id = $1 GROUP BY c.code ORDER BY c.code`,
      [deal.orderId],
    );
    expect(balances).toEqual([
      { code: 'JW-STOCK', quantity: '0.0000' },
      { code: 'OUT-DISPATCHED', quantity: '100.0000' },
    ]);
    expect(await p.auditActions(first['shipmentId'] as string)).toEqual(
      expect.arrayContaining(['logistics.customer_dispatch_planned', 'logistics.delivery_address_confirmed', 'logistics.dispatch_override_requested', 'logistics.customer_dispatch_submitted', 'logistics.customer_dispatch_released']),
    );
  });

  it('shows the customer its delivery and documents, with nothing of the supplier', async () => {
    const label = ok(await p.as.logistics.get(`/api/v1/customer-dispatches/${first['shipmentId']}/label`), 200, 'label');
    const note = ok(await p.as.logistics.get(`/api/v1/customer-dispatches/${first['shipmentId']}/delivery-note`), 200, 'delivery note');
    const customerNote = ok(await p.as.buyer.get(`/api/v1/deliveries/${first['shipmentId']}/delivery-note`), 200, 'customer delivery note');
    const delivery = ok(await p.as.buyer.get(`/api/v1/deliveries/${first['shipmentId']}`), 200, 'delivery');
    const list = ok(await p.as.buyer.get(`/api/v1/orders/${deal.orderId}/deliveries`), 200, 'deliveries');
    expect(customerNote['contentHash']).toBe(note['contentHash']);
    expect(label['html']).toContain('package 2 of 2');
    expect(note['html']).toContain(lot('LOT-A')['marking'] as string);
    expect(delivery).toMatchObject({ status: 'ready_to_leave', addressConfirmation: { needed: false, byJobWork: true } });

    const po = deal.purchaseOrders[0]!;
    const shielded = ['Anand', 'Balaji', 'LOT-A', 'LOT-B', po['number'] as string, 'Coimbatore', 'contact@example.test', '+91 90000 00000', p.orgs.supplierA, deal.purchaseOrderId, '4850', '48.50'];
    for (const text of [label['html'], note['html'], JSON.stringify(delivery), JSON.stringify(list)] as string[]) {
      for (const s of shielded) expect(text.toLowerCase()).not.toContain(s.toLowerCase());
    }
    expect((await p.as.buyer.get(`/api/v1/customer-dispatches/${first['shipmentId']}/label`)).status).toBe(403);
  });

  it('moves the order into customer transit at pickup and tells the customer; the supplier sees nothing of leg 2', async () => {
    expect((await p.as.supplierA.post(`/api/v1/supplier/shipments/${first['shipmentId']}/pickup`, { expectedVersion: first['aggregateVersion'], carrierMode: 'supplier_vehicle' })).status).toBe(404);
    expect((await p.as.logistics.post(`/api/v1/shipments/${first['shipmentId']}/pickup`, { expectedVersion: first['aggregateVersion'], carrierMode: 'supplier_vehicle' })).body['code']).toBe('CARRIER_MODE');
    first = ok(await p.as.logistics.post(`/api/v1/shipments/${first['shipmentId']}/pickup`, { expectedVersion: first['aggregateVersion'], carrierMode: 'carrier', carrierName: 'Safexpress', trackingReference: 'SX-55120' }), 201, 'pickup');
    expect(await orderStatus()).toBe('in_customer_transit');
    await p.dispatchNotifications();
    expect((await p.notices('buyer')).some((n) => n.template_key === 'customer.delivery_dispatched')).toBe(true);
    expect(ok(await p.as.buyer.get(`/api/v1/deliveries/${first['shipmentId']}`), 200, 'delivery')).toMatchObject({ status: 'on_the_way', carrier: { name: 'Safexpress', trackingReference: 'SX-55120' } });

    const supplierList = ok(await p.as.supplierA.get('/api/v1/supplier/shipments'), 200, 'supplier shipments') as unknown as Body[];
    expect(supplierList.every((s) => s['leg'] === 'supplier_to_jobwork')).toBe(true);
    expect((await p.as.supplierA.get(`/api/v1/supplier/shipments/${first['shipmentId']}`)).status).toBe(404);
    expect((await p.as.supplierB.get(`/api/v1/deliveries/${first['shipmentId']}`)).status).toBe(404);
  });
});
