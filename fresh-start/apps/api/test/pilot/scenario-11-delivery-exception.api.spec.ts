import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeliveryCommand } from '../../src/modules/logistics/application/delivery.command';
import { type Body, ok, Pilot, type SourcedDeal } from './driver';

/**
 * Pilot scenario 11 (doc 19 §10; IN-17 F-17.6; IN-18): delivery to the customer, refused once,
 * then damaged in part. The order sits at JobWork; the first dispatch is red on payment, address and
 * documents until the customer confirms and pays and logistics corrects the e-way bill. The customer
 * refuses it at the door and the return leg brings the stock back onto the same lots. Re-dispatched,
 * part of it arrives dented: the report holds the leg and becomes a case, which credits the customer,
 * recovers from the supplier and closes once every action is verified by someone else. A second
 * delivery is deemed accepted by the sweep; a hidden defect after that is a warranty claim. Every
 * piece reconciles across both legs; the supplier's bill is matched and paid and the order closes.
 */
describe('Pilot 11: delivery refused, damaged, made good', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let first: Body;
  let d1: Body;
  let d2: Body;
  let damage: Body;
  let caseId: string;
  let bill: Body;

  const allChecked = { neutralCartons: true, supplierMarksRemoved: true, jobworkLabelsApplied: true, packagingNoteFollowed: true };
  const shipment = async (id: unknown): Promise<Body> => ok(await p.as.logistics.get(`/api/v1/shipments/${id}`), 200, 'shipment');
  const delivery = async (id: unknown): Promise<Body> => ok(await p.as.buyer.get(`/api/v1/deliveries/${id}`), 200, 'delivery');
  const red = (s: Body): string[] => (s['guards'] as Body[]).filter((g) => !g['pass']).map((g) => g['key'] as string);
  const orderStatus = async (): Promise<string> => (await p.one<{ status: string }>(`SELECT status FROM orders.sales_order WHERE id = $1`, [deal.orderId])).status;
  const balance = async (): Promise<Body> => (ok(await p.as.finance.get(`/api/v1/sales-orders/${deal.orderId}`), 200, 'order')['invoices'] as Body[]).find((i) => i['kind'] === 'balance')!;
  const caseOf = async (): Promise<Body> => ok(await p.as.support.get(`/api/v1/cases/${caseId}`), 200, 'case');
  const action = (c: Body, kind: string): Body => (c['actions'] as Body[]).find((a) => a['kind'] === kind)!;
  const total = (ledger: Record<string, string>): number => Object.values(ledger).reduce((t, q) => t + Number(q), 0);
  const settlementOf = (b: Body): Body => b['settlement'] as Body;

  beforeAll(async () => {
    p = await Pilot.start('scenario11');
    await p.customerSite();
    ({ deal } = await p.atJobWork());
    // The customer allowed partial deliveries at enquiry (the wizard's step 6).
    await p.pg.query(`UPDATE sourcing.enquiry SET partial_delivery = 'allowed' WHERE id = (SELECT enquiry_id FROM orders.sales_order WHERE id = $1)`, [deal.orderId]);
  }, 300_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('plans the first dispatch red on payment, address and documents, and invoices the balance', async () => {
    expect(await orderStatus()).toBe('received_jobwork');
    const lots = await p.stockLots(deal.orderId);
    first = ok(
      await p.as.logistics.post('/api/v1/customer-dispatches', { salesOrderId: deal.orderId, packages: [{ packageNo: 1, weightG: 9000, items: [{ stockLotId: lots['LOT-A'], quantity: '60' }] }], packingCheck: allChecked }),
      201,
      'plan',
    );
    expect(red(first)).toEqual(['payment', 'address', 'documents']);
    expect(await balance()).toMatchObject({ status: 'issued' });
  });

  it('turns green once the customer confirms and pays and logistics corrects the e-way bill; nothing of the supplier travels', async () => {
    const [seen] = ok(await p.as.buyer.get(`/api/v1/orders/${deal.orderId}/deliveries`), 200, 'deliveries') as unknown as Body[];
    ok(await p.as.buyer.post(`/api/v1/deliveries/${first['shipmentId']}/confirm-address`, { expectedVersion: seen!['aggregateVersion'] }), 201, 'customer confirms');
    const invoice = await balance();
    await p.payInvoice(invoice['invoiceId'] as string);
    first = await shipment(first['shipmentId']);
    expect(red(first)).toEqual(['documents']);

    const replan = async (eWaybillNumber: string): Promise<Body> =>
      ok(
        await p.as.logistics.post(`/api/v1/customer-dispatches/${first['shipmentId']}/replan`, { expectedVersion: first['aggregateVersion'], packages: first['packages'], documents: { invoiceNumber: invoice['number'], eWaybillNumber }, packingCheck: allChecked }),
        201,
        'replan',
      );
    first = await replan('1811-XX');
    expect(red(first)).toEqual(['documents']);
    first = await replan('1811 0000 0042');
    expect(red(first)).toEqual([]);
    first = ok(await p.as.logistics.post(`/api/v1/customer-dispatches/${first['shipmentId']}/submit`, { expectedVersion: first['aggregateVersion'] }), 201, 'submit');
    first = ok(await p.as.logistics.post(`/api/v1/customer-dispatches/${first['shipmentId']}/release`, { expectedVersion: first['aggregateVersion'] }), 201, 'release');

    const label = ok(await p.as.logistics.get(`/api/v1/customer-dispatches/${first['shipmentId']}/label`), 200, 'label');
    const note = ok(await p.as.buyer.get(`/api/v1/deliveries/${first['shipmentId']}/delivery-note`), 200, 'delivery note');
    const shielded = ['Anand', 'LOT-A', 'LOT-B', deal.purchaseOrders[0]!['number'] as string, 'Coimbatore', deal.purchaseOrderId];
    for (const text of [label['html'], note['html'], JSON.stringify(await delivery(first['shipmentId']))] as string[]) {
      for (const s of shielded) expect(text.toLowerCase()).not.toContain(s.toLowerCase());
    }
    first = ok(await p.as.logistics.post(`/api/v1/shipments/${first['shipmentId']}/pickup`, { expectedVersion: first['aggregateVersion'], carrierMode: 'carrier', carrierName: 'Safexpress', trackingReference: 'SX-11-0001' }), 201, 'pickup');
    expect(await orderStatus()).toBe('in_customer_transit');
  });

  it('brings a delivery refused at the door back onto the same lots', async () => {
    const lots = await p.one<{ n: number }>(`SELECT count(*)::int AS n FROM logistics.stock_lot WHERE sales_order_id = $1`, [deal.orderId]);
    first = ok(await p.as.logistics.post(`/api/v1/shipments/${first['shipmentId']}/refusal`, { expectedVersion: first['aggregateVersion'], refusedBy: 'Stores in-charge', reason: 'Stores closed for stocktaking' }), 201, 'refusal');
    expect(first['status']).toBe('refused');
    const back = (ok(await p.as.logistics.get(`/api/v1/shipments?salesOrderId=${deal.orderId}`), 200, 'shipments') as unknown as Body[]).find((s) => s['returnsShipmentId'] === first['shipmentId'])!;
    expect(p.markingOf(back)).toBe(p.markingOf(first));
    expect((await p.receivedInFull(back))['status']).toBe('accepted');
    expect(await p.ledger(deal.orderId)).toMatchObject({ 'JW-STOCK': '100', 'OUT-DISPATCHED': '0' });
    expect(await p.one(`SELECT count(*)::int AS n FROM logistics.stock_lot WHERE sales_order_id = $1`, [deal.orderId])).toEqual(lots);
    expect((await shipment(first['shipmentId']))['delivery']).toMatchObject({ exceptions: [expect.objectContaining({ kind: 'refused', status: 'resolved', resolution: 'returned_to_stock' })] });
  });

  it('re-dispatches; damage reported inside the window holds the leg and becomes a case', async () => {
    d1 = await p.proofOfDelivery(await p.dispatchToCustomer(deal.orderId, [['LOT-A', '60']], 'SX-11-0002'), { remarks: 'with_remarks', remarksNote: 'One carton corner crushed' });
    expect(d1['status']).toBe('receiving_check');
    const reported = ok(await p.as.buyer.post(`/api/v1/deliveries/${d1['shipmentId']}/issues`, { kind: 'damage', lotMarking: p.markingOf(d1), quantity: '2', description: 'Two dented on the flange', evidenceDocumentVersionIds: [await p.cleanDrawing(p.orgs.customer)] }), 201, 'report damage');
    expect(reported['status']).toBe('issue_reported');
    damage = (reported['exceptions'] as Body[]).find((e) => e['kind'] === 'damage')!;
    expect(damage).toMatchObject({ warrantyClaim: false, status: 'open' });

    const opened = ok(
      await p.as.support.post('/api/v1/cases', { salesOrderId: deal.orderId, kind: 'delivery_issue', title: 'Two dented on the flange', description: 'Reported inside the acceptance window', shipmentId: d1['shipmentId'], deliveryExceptionIds: [damage['exceptionId']], purchaseOrderId: deal.purchaseOrderId }),
      201,
      'open case',
    );
    caseId = opened['caseId'] as string;
    expect(await delivery(d1['shipmentId'])).toMatchObject({ status: 'issue_reported', exceptions: [expect.objectContaining({ kind: 'damage', resolution: 'handed_to_case', caseReference: opened['number'] })] });
    expect((await p.as.approver.post(`/api/v1/deliveries/${d1['shipmentId']}/accept`, { expectedVersion: (await delivery(d1['shipmentId']))['aggregateVersion'] })).body['code']).toBe('SHIPMENT_STATUS');
  });

  it('deems the second delivery accepted past the window, and records a later hidden defect as a warranty claim', async () => {
    d2 = await p.proofOfDelivery(await p.dispatchToCustomer(deal.orderId, [['LOT-B', '40']], 'SX-11-0003'));
    expect(await p.app.get(DeliveryCommand).acceptanceSweep({ id: '00000000-0000-4000-8000-000000000001' }, new Date(Date.now() + 9 * 86_400_000))).toEqual({ deemed: 1 });
    expect(await delivery(d2['shipmentId'])).toMatchObject({ status: 'accepted', acceptance: { basis: 'deemed' } });
    expect((await delivery(d1['shipmentId']))['status']).toBe('issue_reported');

    const claimed = ok(await p.as.buyer.post(`/api/v1/deliveries/${d2['shipmentId']}/issues`, { kind: 'quality_defect', lotMarking: p.markingOf(d2), quantity: '1', description: 'Porosity found after machining' }), 201, 'warranty claim');
    expect(claimed).toMatchObject({ status: 'accepted', exceptions: [expect.objectContaining({ kind: 'quality_defect', warrantyClaim: true })] });

    // Both legs reconcile: what JobWork received is on hand, dispatched or scrapped.
    const ledger = await p.ledger(deal.orderId);
    expect(ledger).toMatchObject({ 'JW-STOCK': '0', 'OUT-DISPATCHED': '100' });
    expect(Number(ledger['JW-STOCK'] ?? 0) + Number(ledger['OUT-DISPATCHED'] ?? 0) + Number(ledger['OUT-SCRAPPED'] ?? 0)).toBe(100);
    expect(total(ledger)).toBe(100);
  });

  it('resolves the case with a credit note and a supplier recovery that holds the supplier’s settlement', async () => {
    bill = ok(await p.as.supplierA.post('/api/v1/supplier/bills', { purchaseOrderId: deal.purchaseOrderId, supplierReference: 'AE/1101', billDate: new Date().toISOString().slice(0, 10), quantity: '100', taxableMinor: 100 * 12_350, taxMinor: 0 }), 201, 'bill');
    bill = ok(await p.as.finance.post(`/api/v1/supplier-bills/${bill['billId']}/match`, { expectedVersion: bill['aggregateVersion'] }), 201, 'match');

    let c = await caseOf();
    c = ok(await p.as.support.post(`/api/v1/cases/${caseId}/triage`, { expectedVersion: c['aggregateVersion'] }), 201, 'triage');
    c = ok(await p.as.support.post(`/api/v1/cases/${caseId}/investigate`, { expectedVersion: c['aggregateVersion'] }), 201, 'investigate');
    const proposed = ok(
      await p.as.support.post(`/api/v1/cases/${caseId}/proposal`, {
        expectedVersion: c['aggregateVersion'],
        actions: [
          { kind: 'credit_note', description: 'Credit two dented pieces', amountMinor: 23_600 },
          { kind: 'supplier_recovery', description: 'Recover two pieces from the supplier', amountMinor: 24_700 },
          { kind: 'concession', description: 'Customer keeps the two pieces for non-critical use' },
        ],
      }),
      201,
      'propose',
    );
    ok(await p.decide('finance2', proposed['approvalRequestId'] as string), 201, 'finance approves');
    bill = ok(await p.as.finance.post(`/api/v1/supplier-bills/${bill['billId']}/settlement/recheck`, {}), 201, 'recheck');
    expect(settlementOf(bill)).toMatchObject({ status: 'held', eligibility: { reasons: [expect.stringContaining('holds this supplier’s settlement')] } });

    c = await caseOf();
    c = ok(await p.as.finance.post(`/api/v1/case-actions/${action(c, 'credit_note')['actionId']}/execute`, { invoiceId: (await balance())['invoiceId'] }), 201, 'credit note');
    c = ok(await p.as.finance.post(`/api/v1/case-actions/${action(c, 'supplier_recovery')['actionId']}/execute`, { reference: 'DN-AE-1101' }), 201, 'recovery');
    c = ok(await p.as.support.post(`/api/v1/case-actions/${action(c, 'concession')['actionId']}/execute`, { note: 'Customer agreed by email' }), 201, 'concession');
    expect(c['status']).toBe('verifying');
    expect((await p.as.support.post(`/api/v1/cases/${caseId}/close`, { expectedVersion: c['aggregateVersion'], reason: 'Too early' })).body['code']).toBe('ACTIONS_UNVERIFIED');

    const seen = ok(await p.as.buyer.get(`/api/v1/support/cases/${caseId}`), 200, 'customer case');
    p.expectNothingOf(seen, ['Anand', deal.purchaseOrderId, deal.purchaseOrders[0]!['number'] as string, 'supplier_recovery', '24700', 'DN-AE-1101'], 'customer case');

    for (const [kind, by] of [['credit_note', 'finance2'], ['supplier_recovery', 'support'], ['concession', 'quality']] as const) {
      c = ok(await p.as[by].post(`/api/v1/case-actions/${action(c, kind)['actionId']}/verify`, { note: 'Checked against the record' }), 201, `verify ${kind}`);
    }
    c = ok(await p.as.support.post(`/api/v1/cases/${caseId}/close`, { expectedVersion: c['aggregateVersion'], reason: 'Credited, recovered, pieces kept' }), 201, 'close');
    expect(c['status']).toBe('closed');
  });

  it('lets the customer accept once the case closes, then pays the supplier and closes the order', async () => {
    const held = await delivery(d1['shipmentId']);
    expect(held).toMatchObject({ status: 'awaiting_your_confirmation', actions: { accept: true } });
    ok(await p.as.approver.post(`/api/v1/deliveries/${d1['shipmentId']}/accept`, { expectedVersion: held['aggregateVersion'], note: 'Fifty-eight good, two kept under concession' }), 201, 'accept');
    expect(await orderStatus()).toBe('customer_accepted');

    bill = ok(await p.as.finance.post(`/api/v1/supplier-bills/${bill['billId']}/settlement/recheck`, {}), 201, 'recheck');
    expect(settlementOf(bill)['status']).toBe('eligible');
    bill = ok(await p.as.finance.post(`/api/v1/supplier-bills/${bill['billId']}/settlement/schedule`, { expectedVersion: settlementOf(bill)['aggregateVersion'], scheduledFor: new Date().toISOString().slice(0, 10) }), 201, 'schedule');
    bill = ok(await p.as.finance.post(`/api/v1/supplier-bills/${bill['billId']}/settlement/pay`, { expectedVersion: settlementOf(bill)['aggregateVersion'], paymentReference: 'UTR-HDFC-1101' }), 201, 'pay');
    expect(settlementOf(bill)['status']).toBe('paid');
    expect(await orderStatus()).toBe('closed');
    expect(await p.auditActions(deal.orderId)).toEqual(expect.arrayContaining(['orders.sales_order_customer_accepted', 'orders.sales_order_closed']));
  });
});
