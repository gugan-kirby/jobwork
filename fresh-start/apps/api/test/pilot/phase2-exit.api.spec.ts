import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './driver';

const AREAS = ['configuration', 'wip', 'process_tooling', 'quality', 'commercial', 'schedule', 'contract', 'logistics'] as const;

/**
 * Phase 2 exit (doc 15 §5; TP.6): one deal from the customer's enquiry to a closed order, with one
 * engineering change and one NCR drill on the way. The change is priced, approved by the customer
 * and released as a new baseline; the first article fails, is reworked, and passes reinspection,
 * and the NCR closes on a verified corrective action. Both legs move every piece; the customer
 * accepts; the supplier's bill is matched and paid; the order is `closed`.
 */
describe('Phase 2 exit: enquiry to a closed order through a change and an NCR', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let prod: { baselineId: string; workPackageId: string; qualityPlanId: string };
  let changeId: string;
  let gauge: string;
  let ncr: Body;
  let delivery: Body;
  const customerPriceDelta = 23_600;
  // Above the match's 1 % tolerance, so the bill matches only if the amendment counts (D10).
  const supplierCostDelta = 120_000;

  const change = async (): Promise<Body> => ok(await p.as.engineering.get(`/api/v1/changes/${changeId}`), 200, 'change');
  const changeVersion = async (): Promise<number> => (await change())['aggregateVersion'] as number;
  const orderStatus = async (): Promise<string> => (await p.one<{ status: string }>(`SELECT status FROM orders.sales_order WHERE id = $1`, [deal.orderId])).status;
  const characteristic = (i: Body, name: string): string => (i['characteristics'] as Body[]).find((c) => c['name'] === name)!['characteristicId'] as string;
  const bore = (i: Body): Body => (i['results'] as Body[]).find((r) => r['characteristicId'] === characteristic(i, 'Bore diameter') && r['supersededByResultId'] === null)!;

  /** Supplier A measures a planned inspection (the bore at `value` mm, the rest in tolerance); quality reviews and decides. */
  async function measure(planned: Body, value: string): Promise<Body> {
    let i = ok(await p.as.supplierA.post(`/api/v1/supplier/inspections/${planned['inspectionId']}/start`, { expectedVersion: planned['aggregateVersion'] }), 201, 'start');
    const samples = Array.from({ length: i['sampleSize'] as number }, (_, k) => k + 1);
    const reading = (name: string): Body =>
      name.startsWith('Visual')
        ? { measurement: { value: 'conforming', unit: null, declaredPrecision: null } }
        : name.startsWith('Surface')
          ? { measurement: { value: '1.6', unit: 'um', declaredPrecision: 1 }, instrumentId: gauge }
          : name === 'Bore diameter'
            ? { measurement: { value, unit: 'mm', declaredPrecision: 3 }, instrumentId: gauge }
            : { measurement: { value: '80.00', unit: 'mm', declaredPrecision: 2 }, instrumentId: gauge };
    i = ok(
      await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/results`, {
        expectedVersion: i['aggregateVersion'],
        inspectedAt: new Date().toISOString(),
        samples: samples.map((n) => ({ sampleNo: n, lot: 'LOT-A' })),
        results: samples.flatMap((n) => (i['characteristics'] as Body[]).map((c) => ({ sampleNo: n, characteristicId: c['characteristicId'], ...reading(c['name'] as string) }))),
      }),
      201,
      'results',
    );
    i = ok(await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/review`, { expectedVersion: i['aggregateVersion'] }), 201, 'review');
    const pass = Number(value) <= 12.02;
    return ok(await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/decide`, { expectedVersion: i['aggregateVersion'], decision: pass ? 'passed' : 'failed', reason: pass ? '' : `Bore ${value} mm oversize` }), 201, 'decide');
  }

  beforeAll(async () => {
    p = await Pilot.start('phase2exit');
    await p.customerSite();
  }, 60_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('takes the enquiry through sourcing, a quote the customer accepts, a PO and production', async () => {
    deal = await p.sourceToPurchaseOrder((await p.approvedEnquiry()).enquiryId);
    prod = await p.intoProduction(deal);
    expect(await p.one(`SELECT status FROM orders.purchase_order WHERE id = $1`, [deal.purchaseOrderId])).toMatchObject({ status: expect.any(String) });
    expect(await orderStatus()).not.toBe('pending_commercial_release');
  }, 240_000);

  it('runs one engineering change from the customer’s request to a released baseline the supplier acknowledges', async () => {
    const spec = await p.cleanDrawing(p.orgs.customer);
    changeId = ok(await p.as.buyer.post(`/api/v1/orders/${deal.orderId}/changes`, { title: 'Laser-mark the part number', reason: 'Traceability on every bracket; marking spec attached.', urgency: 'normal', contextDocumentVersionIds: [spec] }), 201, 'request')['changeRequestId'] as string;
    ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/triage`, { expectedVersion: await changeVersion() }), 201, 'triage');
    ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/classify`, { expectedVersion: await changeVersion(), classification: 'scope', supplierBrief: 'Add a laser-marked part number per the marking drawing. Quote the step.' }), 201, 'classify');
    ok(await p.as.supplierA.post(`/api/v1/supplier/changes/${changeId}/impact`, { purchaseOrderId: deal.purchaseOrderId, costDeltaMinor: supplierCostDelta, leadTimeDeltaDays: 3, wip: [], note: 'Marking adds a fixture' }), 201, 'supplier estimate');
    const assembled = ok(
      await p.as.engineering.post(`/api/v1/sales-orders/${deal.orderId}/baselines`, {
        items: [
          { documentVersionId: p.drawingVersionId, purpose: 'governing', governingPriority: 1 },
          { documentVersionId: spec, purpose: 'governing', governingPriority: 2 },
        ],
      }),
      201,
      'candidate',
    );
    const candidateId = (assembled['baselines'] as Body[]).find((b) => b['status'] === 'draft')!['baselineId'] as string;
    ok(
      await p.as.engineering.post(`/api/v1/changes/${changeId}/impact`, {
        expectedVersion: await changeVersion(),
        areas: Object.fromEntries(AREAS.map((a) => [a, a === 'contract' ? { applicable: false, reason: 'Terms unchanged' } : { applicable: true, answer: `${a}: laser mark added` }])),
        customerPriceDeltaMinor: customerPriceDelta,
        deliveryDateDeltaDays: 3,
        purchaseOrders: [{ purchaseOrderId: deal.purchaseOrderId, costDeltaMinor: supplierCostDelta, leadTimeDeltaDays: 3 }],
        wip: [],
        candidateBaselineId: candidateId,
      }),
      201,
      'impact',
    );
    ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/complete-impact`, { expectedVersion: await changeVersion() }), 201, 'complete impact');
    ok(await p.decide('sales', (await change())['approvalRequestId'] as string), 201, 'sales approves');
    const seen = ok(await p.as.approver.get(`/api/v1/customer/changes/${changeId}`), 200, 'customer view');
    ok(await p.as.approver.post(`/api/v1/customer/changes/${changeId}/decide`, { expectedVersion: seen['aggregateVersion'], decision: 'approved', acknowledgeEffect: true }), 201, 'customer approves');
    expect(ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/release`, { expectedVersion: await changeVersion() }), 201, 'release')).toMatchObject({ status: 'released', releasedBaselineId: candidateId });
    expect(ok(await p.as.supplierA.post(`/api/v1/supplier/changes/${changeId}/acknowledge`, { purchaseOrderId: deal.purchaseOrderId, note: 'Marking drawing received.' }), 201, 'acknowledge')['status']).toBe('implemented');
    ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/verify`, { expectedVersion: await changeVersion(), note: 'First marked part checked.' }), 201, 'verify');
    expect(ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/close`, { expectedVersion: await changeVersion() }), 201, 'close')['status']).toBe('closed');
    expect(await p.one(`SELECT supersedes_baseline_id FROM dms.baseline WHERE id = $1`, [candidateId])).toEqual({ supersedes_baseline_id: prod.baselineId });

    // The quality plan follows the baseline in force before the next inspection (IN-14).
    expect((await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'fai', lot: 'LOT-A' })).body['code']).toBe('PLAN_BASELINE_STALE');
    const plan = ok(await p.as.quality.get(`/api/v1/quality-plans/${prod.qualityPlanId}`), 200, 'plan');
    const revised = ok(await p.as.quality.post(`/api/v1/quality-plans/${prod.qualityPlanId}/revise`, { expectedVersion: plan['aggregateVersion'] }), 201, 'revise plan');
    expect(revised).toMatchObject({ baselineId: candidateId, baselineCurrent: true });
    ok(await p.as.quality.post(`/api/v1/quality-plans/${revised['planId']}/approve`, { expectedVersion: revised['aggregateVersion'] }), 201, 'approve revised plan');
  });

  it('drills one NCR: a failed first article, contained, reworked, passed on reinspection and closed on a verified corrective action', async () => {
    gauge = await p.calibratedGauge();
    const failed = await measure(ok(await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'fai', lot: 'LOT-A' }), 201, 'plan FAI'), '12.030');
    expect(failed['status']).toBe('failed');
    ncr = ok(
      await p.as.quality.post('/api/v1/ncrs', { inspectionId: failed['inspectionId'], resultIds: [bore(failed)['resultId']], title: 'Bore oversize on first article', description: 'Bore 12.030 mm against 11.98–12.02 mm', severity: 'critical', affectedQuantity: '60', lots: ['LOT-A'], costResponsibility: 'supplier' }),
      201,
      'open NCR',
    );
    ok(await p.as.supplierA.post(`/api/v1/supplier/ncrs/${ncr['ncrId']}/containment`, { action: 'LOT-A tagged red', location: 'Hold rack 1', quantity: '60' }), 201, 'contain');
    ncr = ok(await p.as.quality.get(`/api/v1/ncrs/${ncr['ncrId']}`), 200, 'ncr');
    ncr = ok(await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/to-disposition`, { expectedVersion: ncr['aggregateVersion'] }), 201, 'to disposition');
    ncr = ok(await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/approve-rework`, { expectedVersion: ncr['aggregateVersion'], disposition: 'rework', plan: 'Re-bore LOT-A to 12.000 with a new boring bar' }), 201, 'approve rework');
    ncr = ok(await p.as.supplierA.post(`/api/v1/supplier/ncrs/${ncr['ncrId']}/rework`, { expectedVersion: ncr['aggregateVersion'], note: 'LOT-A re-bored' }), 201, 'record rework');
    ncr = ok(await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/reinspection`, { expectedVersion: ncr['aggregateVersion'] }), 201, 'plan reinspection');
    const planned = ok(await p.as.quality.get(`/api/v1/inspections/${((ncr['dispositions'] as Body[])[0]!['reinspection'] as Body)['inspectionId']}`), 200, 'reinspection');
    expect((await measure(planned, '12.004'))['status']).toBe('passed');
    ncr = ok(await p.as.quality.get(`/api/v1/ncrs/${ncr['ncrId']}`), 200, 'ncr');
    expect(ncr).toMatchObject({ status: 'verified', attemptNo: 1 });

    // The NCR holds the supplier's settlement while it is open (doc 10 §5).
    const ca = (): Body => ncr['correctiveAction'] as Body;
    ncr = ok(
      await p.as.supplierA.post(`/api/v1/supplier/ncrs/${ncr['ncrId']}/corrective-action`, {
        expectedVersion: ca()['aggregateVersion'],
        problemDefinition: 'LOT-A bores 0.01 mm oversize after the first article',
        occurrenceCause: 'Boring bar insert past its wear limit; no tool-life counter on the VMC',
        escapeCause: 'Bore gauged only at first-off, not at insert change',
        actions: [{ action: 'Tool-life counter set to 40 parts', owner: 'Setter', dueDate: '2026-10-20' }],
      }),
      201,
      'corrective action',
    );
    ncr = ok(await p.as.quality2.post(`/api/v1/ncrs/${ncr['ncrId']}/corrective-action/review`, { expectedVersion: ca()['aggregateVersion'], decision: 'accept', note: 'Causes evidenced' }), 201, 'accept CA');
    ncr = ok(await p.as.quality2.post(`/api/v1/ncrs/${ncr['ncrId']}/corrective-action/verify`, { expectedVersion: ca()['aggregateVersion'], evidence: 'Next first article at 12.002 mm' }), 201, 'verify CA');
    expect(ok(await p.as.quality2.post(`/api/v1/ncrs/${ncr['ncrId']}/close`, { expectedVersion: ncr['aggregateVersion'], note: 'Reworked lot passed reinspection; corrective action effective' }), 201, 'close NCR')['status']).toBe('closed');
  });

  it('releases both lots, ships them to JobWork and receives every piece', async () => {
    await p.releasedLots(deal, prod.workPackageId, [{ lot: 'LOT-A', quantity: '60' }, { lot: 'LOT-B', quantity: '40' }]);
    const shipped = await p.shippedToJobWork(deal.purchaseOrderId, [
      { packageNo: 1, weightG: 9000, items: [{ lotCode: 'LOT-A', quantity: '60' }] },
      { packageNo: 2, weightG: 6000, items: [{ lotCode: 'LOT-B', quantity: '40' }] },
    ]);
    expect((await p.receivedInFull(shipped))['status']).toBe('accepted');
    expect(await orderStatus()).toBe('received_jobwork');
    expect(await p.ledger(deal.orderId)).toMatchObject({ 'JW-STOCK': '100' });
  });

  it('invoices the change, delivers to the customer and has the delivery accepted', async () => {
    const so = ok(await p.as.finance.get(`/api/v1/sales-orders/${deal.orderId}`), 200, 'order');
    const installment = (so['installments'] as Body[]).find((i) => i['kind'] === 'change')!;
    const invoiced = ok(await p.as.finance.post(`/api/v1/sales-orders/${deal.orderId}/invoices`, { expectedVersion: so['aggregateVersion'], installmentId: installment['installmentId'] }), 201, 'invoice change');
    const changeInvoice = (invoiced['invoices'] as Body[]).find((i) => i['kind'] === 'change')!;
    expect(changeInvoice['totalMinor']).toBe(customerPriceDelta);
    await p.payInvoice(changeInvoice['invoiceId'] as string);

    delivery = await p.proofOfDelivery(await p.dispatchToCustomer(deal.orderId, [['LOT-A', '60'], ['LOT-B', '40']]));
    expect(await orderStatus()).toBe('delivered');
    const seen = ok(await p.as.buyer.get(`/api/v1/deliveries/${delivery['shipmentId']}`), 200, 'delivery');
    ok(await p.as.approver.post(`/api/v1/deliveries/${delivery['shipmentId']}/accept`, { expectedVersion: seen['aggregateVersion'], note: 'One hundred counted and marked' }), 201, 'accept');
    expect(await orderStatus()).toBe('customer_accepted');
    expect(await p.ledger(deal.orderId)).toMatchObject({ 'JW-STOCK': '0', 'OUT-DISPATCHED': '100' });
  });

  it('matches and pays the supplier’s bill, closes the order, and the margin is complete', async () => {
    const po = await p.one<{ total_minor: string }>(`SELECT total_minor::text FROM orders.purchase_order WHERE id = $1`, [deal.purchaseOrderId]);
    const amended = Number(po.total_minor) + supplierCostDelta;
    let bill = ok(await p.as.supplierA.post('/api/v1/supplier/bills', { purchaseOrderId: deal.purchaseOrderId, supplierReference: 'AE/EXIT-1', billDate: new Date().toISOString().slice(0, 10), quantity: '100', taxableMinor: amended, taxMinor: 0 }), 201, 'bill');
    bill = ok(await p.as.finance.post(`/api/v1/supplier-bills/${bill['billId']}/match`, { expectedVersion: bill['aggregateVersion'] }), 201, 'match');
    expect(bill['status']).toBe('matched');
    const settlement = (b: Body): Body => b['settlement'] as Body;
    expect(settlement(bill)['status']).toBe('eligible');
    bill = ok(await p.as.finance.post(`/api/v1/supplier-bills/${bill['billId']}/settlement/schedule`, { expectedVersion: settlement(bill)['aggregateVersion'], scheduledFor: new Date().toISOString().slice(0, 10) }), 201, 'schedule');
    expect(await orderStatus()).toBe('customer_accepted');
    bill = ok(await p.as.finance.post(`/api/v1/supplier-bills/${bill['billId']}/settlement/pay`, { expectedVersion: settlement(bill)['aggregateVersion'], paymentReference: 'UTR-HDFC-EXIT' }), 201, 'pay');
    expect(settlement(bill)['status']).toBe('paid');
    expect(await orderStatus()).toBe('closed');

    const margin = ok(await p.as.finance.get(`/api/v1/finance/margin/${deal.orderId}`), 200, 'margin');
    expect(margin).toMatchObject({ status: 'closed', billsComplete: true, varianceMinor: expect.any(Number), actual: expect.objectContaining({ costOfGoodsMinor: amended, creditNotesMinor: 0 }) });
    expect(await p.auditActions(deal.orderId)).toEqual(expect.arrayContaining(['orders.sales_order_customer_accepted', 'orders.sales_order_closed']));
  });
});
