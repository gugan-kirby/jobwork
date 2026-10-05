import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeliveryCommand } from '../src/modules/logistics/application/delivery.command';
import { type Body, ok, Pilot, type SourcedDeal } from './pilot/driver';

/**
 * IN-17 F-17.3: delivery, POD, acceptance and exceptions (doc 06 §11; doc 19 §8; BR-LOG-05; FR-905;
 * UC-09). POD is the handover, not acceptance; only the customer, or the window running out, accepts.
 * A report inside the window holds the delivery; one after acceptance is a warranty claim. A refusal
 * comes back on its own leg onto the same stock lots; an address change never rewrites the shipment.
 */
describe('delivery, POD and acceptance (F-17.3)', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let balance: Body;
  let d1: Body;
  let d2: Body;
  let d3: Body;
  let d4: Body;
  let hosur: string;

  const allChecked = { neutralCartons: true, supplierMarksRemoved: true, jobworkLabelsApplied: true, packagingNoteFollowed: true };
  const orderStatus = async (): Promise<string> => (await p.one<{ status: string }>(`SELECT status FROM orders.sales_order WHERE id = $1`, [deal.orderId])).status;
  const shipment = async (id: unknown): Promise<Body> => ok(await p.as.logistics.get(`/api/v1/shipments/${id}`), 200, 'shipment');
  const delivery = async (id: unknown): Promise<Body> => ok(await p.as.buyer.get(`/api/v1/deliveries/${id}`), 200, 'delivery');
  const markingOf = (s: Body, n = 0): string => ((s['packages'] as Body[]).flatMap((pk) => pk['items'] as Body[])[n]!['lotCode']) as string;
  const pod = (s: Body, extra: Body = {}) =>
    p.as.logistics.post(`/api/v1/shipments/${s['shipmentId']}/pod`, { expectedVersion: s['aggregateVersion'], receivedByName: 'R. Kumar', receivedAt: new Date().toISOString(), packagesReceived: (s['packages'] as Body[]).length, remarks: 'clean', source: 'driver', ...extra });
  const carrierDelivered = (s: Body, id: string) => p.as.logistics.post(`/api/v1/shipments/${s['shipmentId']}/carrier-events`, { providerEventId: id, rawStatus: 'DL', normalizedStatus: 'delivered', occurredAt: new Date().toISOString() });
  const ledger = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (
        await p.rows<{ code: string; quantity: string }>(
          `SELECT c.code, SUM(b.quantity)::text AS quantity FROM logistics.stock_balance b JOIN logistics.custody_location c ON c.id = b.location_id JOIN logistics.stock_lot t ON t.id = b.lot_id WHERE t.sales_order_id = $1 GROUP BY c.code`,
          [deal.orderId],
        )
      ).map((r) => [r.code, String(Number(r.quantity))]),
    );

  /** A leg-2 delivery of `lots` released and picked up, every guard green. */
  async function dispatched(lots: Array<[string, string]>, tracking: string): Promise<Body> {
    const context = ok(await p.as.logistics.get(`/api/v1/logistics/sales-orders/${deal.orderId}/dispatch-context`), 200, 'context');
    const lot = (code: string): unknown => (context['lots'] as Body[]).find((l) => l['lotCode'] === code)!['stockLotId'];
    const packages = lots.map(([code, quantity], n) => ({ packageNo: n + 1, weightG: 5000, items: [{ stockLotId: lot(code), quantity }] }));
    let s = ok(await p.as.logistics.post('/api/v1/customer-dispatches', { salesOrderId: deal.orderId, packages, packingCheck: allChecked }), 201, 'plan');
    if (!balance) {
      balance = (ok(await p.as.finance.get(`/api/v1/sales-orders/${deal.orderId}`), 200, 'order')['invoices'] as Body[]).find((i) => i['kind'] === 'balance')!;
      await p.payInvoice(balance['invoiceId'] as string);
    }
    s = ok(await p.as.logistics.post(`/api/v1/customer-dispatches/${s['shipmentId']}/replan`, { expectedVersion: s['aggregateVersion'], packages, documents: { invoiceNumber: balance['number'] }, packingCheck: allChecked }), 201, 'replan');
    s = ok(await p.as.sales.post(`/api/v1/customer-dispatches/${s['shipmentId']}/address-confirmations`, { expectedVersion: s['aggregateVersion'], note: 'Confirmed by phone with stores' }), 201, 'confirm');
    s = ok(await p.as.logistics.post(`/api/v1/customer-dispatches/${s['shipmentId']}/submit`, { expectedVersion: s['aggregateVersion'] }), 201, 'submit');
    s = ok(await p.as.logistics.post(`/api/v1/customer-dispatches/${s['shipmentId']}/release`, { expectedVersion: s['aggregateVersion'] }), 201, 'release');
    return ok(await p.as.logistics.post(`/api/v1/shipments/${s['shipmentId']}/pickup`, { expectedVersion: s['aggregateVersion'], carrierMode: 'carrier', carrierName: 'Safexpress', trackingReference: tracking }), 201, 'pickup');
  }

  beforeAll(async () => {
    p = await Pilot.start('delivery');
    await p.customerSite();
    hosur = await p.customerSite('Kovai Pumps Hosur unit', 'Hosur');
    ({ deal } = await p.atJobWork());
    // Stage: the customer allowed partial deliveries at enquiry (the wizard's step 6).
    await p.pg.query(`UPDATE sourcing.enquiry SET partial_delivery = 'allowed' WHERE id = (SELECT enquiry_id FROM orders.sales_order WHERE id = $1)`, [deal.orderId]);
  }, 300_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('records the POD and opens the window, but accepts nothing; only the customer’s approver accepts', async () => {
    d1 = await dispatched([['LOT-A', '30']], 'SX-1001');
    expect((await p.as.approver.post(`/api/v1/deliveries/${d1['shipmentId']}/accept`, { expectedVersion: (await delivery(d1['shipmentId']))['aggregateVersion'] })).body['code']).toBe('SHIPMENT_STATUS');
    expect((await p.as.quality.post(`/api/v1/shipments/${d1['shipmentId']}/pod`, { expectedVersion: d1['aggregateVersion'], receivedByName: 'R. Kumar', receivedAt: new Date().toISOString(), packagesReceived: 1, remarks: 'clean', source: 'driver' })).status).toBe(403);
    expect((await pod(d1, { receivedAt: new Date(Date.now() + 86_400_000).toISOString() })).body['code']).toBe('POD_TIME');
    expect((await pod(d1, { remarks: 'with_remarks' })).status).toBe(400);
    const before = new Date();
    d1 = ok(await pod(d1, { remarks: 'with_remarks', remarksNote: 'Carton 1 corner crushed, contents look fine' }), 201, 'POD');
    expect(d1['status']).toBe('receiving_check');
    const due = new Date((d1['delivery'] as Body)['acceptanceDueAt'] as string);
    // Seven days after the day of delivery, to the end of that day in IST.
    expect(due.getTime() - before.getTime()).toBeGreaterThan(7 * 86_400_000);
    expect(due.getTime() - before.getTime()).toBeLessThanOrEqual(8 * 86_400_000);
    expect(new Date(due.getTime() + 330 * 60_000).toISOString().slice(11, 23)).toBe('23:59:59.999');
    expect(await orderStatus()).toBe('in_customer_transit');
    expect(await p.one(`SELECT count(*)::int AS n FROM logistics.delivery_acceptance WHERE shipment_id = $1`, [d1['shipmentId']])).toEqual({ n: 0 });

    await p.dispatchNotifications();
    expect((await p.notices('buyer')).some((n) => n.template_key === 'customer.delivery_confirmation_needed' && n.title.includes(d1['number'] as string))).toBe(true);
    const seen = await delivery(d1['shipmentId']);
    expect(seen).toMatchObject({ status: 'awaiting_your_confirmation', pod: { receivedByName: 'R. Kumar', remarks: 'with_remarks', deliveredTo: { label: 'Kovai Pumps plant' } }, acceptance: null, actions: { accept: true, reportIssue: true } });

    expect((await p.as.buyer.post(`/api/v1/deliveries/${d1['shipmentId']}/accept`, { expectedVersion: seen['aggregateVersion'] })).status).toBe(403);
    const accepted = ok(await p.as.approver.post(`/api/v1/deliveries/${d1['shipmentId']}/accept`, { expectedVersion: seen['aggregateVersion'], note: 'Thirty counted' }), 201, 'accept');
    expect(accepted).toMatchObject({ status: 'accepted', acceptance: { basis: 'explicit', warrantyStatement: expect.stringContaining('does not waive JobWork') } });
  });

  it('treats a defect found after acceptance as a warranty claim that holds nothing', async () => {
    const report = (body: Body) => p.as.buyer.post(`/api/v1/deliveries/${d1['shipmentId']}/issues`, body);
    expect((await report({ kind: 'shortage', description: 'Two short' })).body['code']).toBe('WINDOW_CLOSED');
    const claimed = ok(await report({ kind: 'quality_defect', lotMarking: markingOf(d1), quantity: '1', description: 'Bore found oversize at assembly' }), 201, 'warranty claim');
    expect(claimed['status']).toBe('accepted');
    expect(claimed['exceptions']).toEqual([expect.objectContaining({ kind: 'quality_defect', warrantyClaim: true, status: 'open' })]);
    expect(await p.auditActions(d1['shipmentId'] as string)).toContain('logistics.warranty_claim_recorded');
  });

  it('holds a carrier-delivered delivery the customer did not receive, until it is found delivered', async () => {
    d2 = await dispatched([['LOT-A', '30']], 'SX-1002');
    ok(await carrierDelivered(d2, 'man-d2-dl'), 201, 'carrier delivered');
    const queues = ok(await p.as.logistics.get('/api/v1/queues'), 200, 'queues');
    expect((queues['items'] as Body[]).some((i) => i['queueKey'] === 'deliveries_awaiting_pod' && i['reference'] === d2['number'])).toBe(true);
    expect((await delivery(d2['shipmentId']))).toMatchObject({ status: 'carrier_reports_delivered', pod: null, actions: { accept: false, reportNotReceived: true } });

    const missing = ok(await p.as.buyer.post(`/api/v1/deliveries/${d2['shipmentId']}/issues`, { kind: 'not_received', description: 'Nothing arrived at stores' }), 201, 'not received');
    expect(missing['status']).toBe('issue_reported');
    await p.dispatchNotifications();
    expect((await p.notices('logistics')).some((n) => n.template_key === 'internal.delivery_exception_opened')).toBe(true);
    d2 = await shipment(d2['shipmentId']);
    const x = ((d2['delivery'] as Body)['exceptions'] as Body[])[0]!;
    expect((await p.as.logistics.post(`/api/v1/delivery-exceptions/${x['exceptionId']}/resolve`, { resolution: 'found_delivered', note: 'Carrier POD shows the gate signed' })).body['code']).toBe('POD_REQUIRED');
    d2 = ok(await pod(d2, { source: 'carrier', receivedByName: 'Gate security' }), 201, 'POD while held');
    expect(d2['status']).toBe('discrepancy_hold');
    expect((await p.as.approver.post(`/api/v1/deliveries/${d2['shipmentId']}/accept`, { expectedVersion: d2['aggregateVersion'] })).body['code']).toBe('SHIPMENT_STATUS');
    expect((await p.as.quality.post(`/api/v1/delivery-exceptions/${x['exceptionId']}/resolve`, { resolution: 'found_delivered', note: 'POD' })).status).toBe(403);
    d2 = ok(await p.as.logistics.post(`/api/v1/delivery-exceptions/${x['exceptionId']}/resolve`, { resolution: 'found_delivered', note: 'Carrier POD shows the gate signed; stores found it' }), 201, 'found delivered');
    expect(d2['status']).toBe('receiving_check');
  });

  it('holds damage reported inside the window with the customer’s own photos; a withdrawal lifts it, a case keeps it', async () => {
    const report = (body: Body) => p.as.buyer.post(`/api/v1/deliveries/${d2['shipmentId']}/issues`, body);
    const photo = await p.cleanDrawing(p.orgs.customer);
    const theirs = await p.cleanDrawing(p.orgs.supplierA);
    expect((await report({ kind: 'damage', lotMarking: markingOf(d2), quantity: '2', description: 'Two dented', evidenceDocumentVersionIds: [theirs] })).body['code']).toBe('EVIDENCE_UNAVAILABLE');
    expect((await report({ kind: 'damage', lotMarking: markingOf(d2), quantity: '31', description: 'All dented' })).body['code']).toBe('QUANTITY_BEYOND_DELIVERY');
    expect((await report({ kind: 'damage', lotMarking: 'JW-00000000', quantity: '1', description: 'Dented' })).body['code']).toBe('LOT_NOT_IN_DELIVERY');
    let seen = ok(await report({ kind: 'damage', lotMarking: markingOf(d2), quantity: '2', description: 'Two dented on the flange', evidenceDocumentVersionIds: [photo] }), 201, 'damage');
    expect(seen['status']).toBe('issue_reported');
    const damage = (seen['exceptions'] as Body[]).find((e) => e['kind'] === 'damage')!;
    expect(damage).toMatchObject({ evidenceCount: 1, warrantyClaim: false, status: 'open' });
    seen = ok(await p.as.buyer.post(`/api/v1/delivery-exceptions/${damage['exceptionId']}/withdraw`, { note: 'Our forklift did it' }), 201, 'withdraw');
    expect(seen['status']).toBe('awaiting_your_confirmation');

    seen = ok(await report({ kind: 'shortage', lotMarking: markingOf(d2), quantity: '3', description: 'Twenty-seven counted' }), 201, 'shortage');
    const shortage = (seen['exceptions'] as Body[]).find((e) => e['kind'] === 'shortage')!;
    expect((await p.as.support.post(`/api/v1/delivery-exceptions/${shortage['exceptionId']}/resolve`, { resolution: 'handed_to_case', note: 'Opened a support case' })).body['code']).toBe('CASE_REFERENCE_REQUIRED');
    expect((await p.as.support.post(`/api/v1/delivery-exceptions/${shortage['exceptionId']}/resolve`, { resolution: 'redirected', note: 'Wrong' })).body['code']).toBe('RESOLUTION_NOT_ALLOWED');
    const handed = ok(await p.as.support.post(`/api/v1/delivery-exceptions/${shortage['exceptionId']}/resolve`, { resolution: 'handed_to_case', note: 'Recount with the customer and the carrier', caseReference: 'CASE-2026-0001' }), 201, 'hand to case');
    expect(handed['status']).toBe('discrepancy_hold');
    expect((await delivery(d2['shipmentId']))['exceptions']).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'shortage', resolution: 'handed_to_case', caseReference: 'CASE-2026-0001', resolutionNote: '' })]));
  });

  it('brings a refused delivery back on its own leg onto the same stock lots', async () => {
    d3 = await dispatched([['LOT-B', '40']], 'SX-1003');
    const lots = await p.one<{ n: number }>(`SELECT count(*)::int AS n FROM logistics.stock_lot WHERE sales_order_id = $1`, [deal.orderId]);
    expect(await ledger()).toMatchObject({ 'JW-STOCK': '0', 'OUT-DISPATCHED': '100' });
    d3 = ok(await p.as.logistics.post(`/api/v1/shipments/${d3['shipmentId']}/refusal`, { expectedVersion: d3['aggregateVersion'], refusedBy: 'Stores in-charge', reason: 'Did not expect this delivery today' }), 201, 'refusal');
    expect(d3['status']).toBe('refused');
    expect((await delivery(d3['shipmentId']))).toMatchObject({ status: 'refused', exceptions: [expect.objectContaining({ kind: 'refused', status: 'open' })] });
    const back = (ok(await p.as.logistics.get(`/api/v1/shipments?salesOrderId=${deal.orderId}`), 200, 'shipments') as unknown as Body[]).find((s) => s['returnsShipmentId'] === d3['shipmentId'])!;
    expect(back).toMatchObject({ leg: 'customer_to_jobwork', status: 'picked_up', origin: { label: 'Kovai Pumps plant' }, destination: { label: 'JobWork receiving hub' } });
    expect(markingOf(back)).toBe(markingOf(d3));

    expect((await p.receivedInFull(back))['status']).toBe('accepted');
    expect(await ledger()).toMatchObject({ 'JW-STOCK': '40', 'OUT-DISPATCHED': '60' });
    expect(await p.one(`SELECT count(*)::int AS n FROM logistics.stock_lot WHERE sales_order_id = $1`, [deal.orderId])).toEqual(lots);
    expect((await shipment(d3['shipmentId']))['delivery']).toMatchObject({ exceptions: [expect.objectContaining({ kind: 'refused', status: 'resolved', resolution: 'returned_to_stock' })] });
    const context = ok(await p.as.logistics.get(`/api/v1/logistics/sales-orders/${deal.orderId}/dispatch-context`), 200, 'context');
    expect(context).toMatchObject({ dispatched: '60' });
    expect((context['lots'] as Body[]).find((l) => l['lotCode'] === 'LOT-B')).toMatchObject({ inStock: '40', available: '40' });
  });

  it('arranges an address change after dispatch beside the shipment, whose own address never changes', async () => {
    d4 = await dispatched([['LOT-B', '40']], 'SX-1004');
    const ask = (actor: 'buyer' | 'supplierA', siteId: string) => p.as[actor].post(`/api/v1/deliveries/${d4['shipmentId']}/address-change`, { siteId, reason: 'Deliver to the Hosur unit instead' });
    expect((await ask('supplierA', hosur)).status).toBe(404);
    expect((await ask('buyer', p.sites.supplierA)).body['code']).toBe('DESTINATION_NOT_CUSTOMERS');
    const asked = ok(await ask('buyer', hosur), 201, 'address change');
    expect(asked).toMatchObject({ status: 'on_the_way', destination: { label: 'Kovai Pumps plant' }, exceptions: [expect.objectContaining({ kind: 'address_change', status: 'open', requestedAddress: expect.objectContaining({ label: 'Kovai Pumps Hosur unit' }) })] });
    expect((await ask('buyer', hosur)).body['code']).toBe('ADDRESS_CHANGE_PENDING');
    d4 = await shipment(d4['shipmentId']);
    const x = ((d4['delivery'] as Body)['exceptions'] as Body[])[0]!;
    expect((await p.as.support.post(`/api/v1/delivery-exceptions/${x['exceptionId']}/resolve`, { resolution: 'redirected', note: 'Carrier rerouted' })).status).toBe(403);
    ok(await p.as.logistics.post(`/api/v1/delivery-exceptions/${x['exceptionId']}/resolve`, { resolution: 'redirected', note: 'Carrier rerouted to Hosur, ref RR-77', carrierChargeNote: 'Redirect ₹1,800 per carrier quote' }), 201, 'redirected');
    d4 = ok(await pod(await shipment(d4['shipmentId'])), 201, 'POD');
    expect(d4['destination']).toMatchObject({ label: 'Kovai Pumps plant' });
    expect((await delivery(d4['shipmentId']))).toMatchObject({ destination: { label: 'Kovai Pumps plant' }, pod: { deliveredTo: { label: 'Kovai Pumps Hosur unit', city: 'Hosur' } } });
    await expect(p.pg.query(`UPDATE logistics.shipment SET destination_snapshot = destination_snapshot || '{"city": "Hosur"}' WHERE id = $1`, [d4['shipmentId']])).rejects.toThrow(/keeps its addresses/);
    expect(await orderStatus()).toBe('delivered');
  });

  it('deems acceptance only past the window, never over a hold, and tells the customer', async () => {
    const sweep = ok(await p.service('/internal/deliveries/acceptance-sweep'), 201, 'sweep');
    expect(sweep).toEqual({ deemed: 0 });
    const command = p.app.get(DeliveryCommand);
    const later = new Date(Date.now() + 9 * 86_400_000);
    expect(await command.acceptanceSweep({ id: '00000000-0000-4000-8000-000000000001' }, later)).toEqual({ deemed: 1 });
    expect(await delivery(d4['shipmentId'])).toMatchObject({ status: 'accepted', acceptance: { basis: 'deemed' } });
    expect((await delivery(d2['shipmentId']))['status']).toBe('issue_reported');
    expect(await p.one(`SELECT accepted_by FROM logistics.delivery_acceptance WHERE shipment_id = $1`, [d4['shipmentId']])).toEqual({ accepted_by: null });
    await p.dispatchNotifications();
    expect((await p.notices('buyer')).some((n) => n.template_key === 'customer.delivery_deemed_accepted')).toBe(true);
    // 30 accepted, 30 held by a case, 40 deemed: delivered in full, not yet accepted in full.
    expect(await orderStatus()).toBe('delivered');
  });

  it('keeps every quantity traceable, the POD free of the supplier, and leg 2 out of the supplier’s sight', async () => {
    expect(await ledger()).toMatchObject({ 'JW-STOCK': '0', 'OUT-DISPATCHED': '100' });
    const doc = ok(await p.as.buyer.get(`/api/v1/deliveries/${d4['shipmentId']}/pod`), 200, 'POD document');
    expect(doc['html']).toContain('Kovai Pumps Hosur unit');
    for (const s of ['Anand', 'LOT-A', 'LOT-B', deal.purchaseOrders[0]!['number'] as string, 'Coimbatore']) expect((doc['html'] as string).toLowerCase()).not.toContain(s.toLowerCase());
    expect((await p.as.supplierA.get(`/api/v1/deliveries/${d4['shipmentId']}`)).status).toBe(404);
    expect((await p.as.supplierA.post(`/api/v1/deliveries/${d4['shipmentId']}/issues`, { kind: 'damage', description: 'Dented' })).status).toBe(404);
  });
});
