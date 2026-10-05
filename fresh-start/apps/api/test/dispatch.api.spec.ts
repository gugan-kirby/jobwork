import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, CARRIER_SECRET, ok, Pilot, type SourcedDeal } from './pilot/driver';

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * Leg 1, supplier to JobWork, over HTTP (IN-16 F-16.2; doc 06 §11; doc 10 §§11–12; BR-LOG-01, BR-LOG-02).
 * Only quality-released lots ship, never more than released less what already went; release by
 * JobWork logistics freezes the addresses; and a carrier's "delivered" moves the leg without
 * receiving a single piece.
 */
describe('Leg 1 dispatch (F-16.2)', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let prod: { workPackageId: string };
  let gauge: string;
  let first: Body;
  let second: Body;
  let failed: Body;
  let ncrId: string;

  const characteristic = (i: Body, name: string): string => ((i['characteristics'] as Body[]).find((c) => c['name'] === name)!['characteristicId']) as string;
  const packages = (lot: string, ...quantities: number[]) => quantities.map((q, i) => ({ packageNo: i + 1, weightG: 9000, items: [{ lotCode: lot, quantity: String(q) }] }));
  const documents = { challanNumber: 'DC-118', eWaybillNumber: '1811 2233 4455' };
  const plan = (pkgs: Body[], docs: Body = documents) => p.as.supplierA.post('/api/v1/supplier/shipments', { purchaseOrderId: deal.purchaseOrderId, originSiteId: p.sites.supplierA, packages: pkgs, documents: docs });
  const red = (s: Body): string[] => (s['guards'] as Body[]).filter((g) => !g['pass']).map((g) => g['key'] as string);

  async function inspect(stage: 'fai' | 'final', bore: string, lot: string): Promise<Body> {
    let i = ok(await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage, lot }), 201, `plan ${stage}`);
    i = ok(await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/start`, { expectedVersion: i['aggregateVersion'] }), 201, 'start');
    const samples = Array.from({ length: i['sampleSize'] as number }, (_, k) => k + 1);
    const value = (name: string) =>
      name.startsWith('Visual')
        ? { measurement: { value: 'conforming', unit: null, declaredPrecision: null } }
        : name.startsWith('Surface')
          ? { measurement: { value: '1.6', unit: 'um', declaredPrecision: 1 }, instrumentId: gauge }
          : name === 'Bore diameter'
            ? { measurement: { value: bore, unit: 'mm', declaredPrecision: 3 }, instrumentId: gauge }
            : { measurement: { value: '80.00', unit: 'mm', declaredPrecision: 2 }, instrumentId: gauge };
    i = ok(
      await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/results`, {
        expectedVersion: i['aggregateVersion'],
        inspectedAt: new Date().toISOString(),
        samples: samples.map((n) => ({ sampleNo: n, lot })),
        results: samples.flatMap((n) => (i['characteristics'] as Body[]).map((c) => ({ sampleNo: n, characteristicId: c['characteristicId'], ...value(c['name'] as string) }))),
      }),
      201,
      'submit',
    );
    i = ok(await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/review`, { expectedVersion: i['aggregateVersion'] }), 201, 'review');
    const pass = Number(bore) <= 12.02;
    return ok(await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/decide`, { expectedVersion: i['aggregateVersion'], decision: pass ? 'passed' : 'failed', reason: pass ? '' : 'Bore oversize' }), 201, 'decide');
  }

  function webhook(body: Body, secret = CARRIER_SECRET) {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    return fetch(`${p.baseUrl}/api/v1/webhooks/carriers/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-timestamp': ts, 'x-dev-signature': createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex') },
      body: raw,
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as Body }));
  }

  beforeAll(async () => {
    p = await Pilot.start('dispatch');
    const { enquiryId } = await p.approvedEnquiry();
    deal = await p.sourceToPurchaseOrder(enquiryId);
    prod = await p.intoProduction(deal);
    const made = ok(await p.as.supplierA.post('/api/v1/supplier/instruments', { assetTag: 'BG-01', kind: 'Bore gauge', unit: 'mm' }), 201, 'instrument');
    ok(await p.as.supplierA.post(`/api/v1/supplier/instruments/${made['instrumentId']}/calibrations`, { performedAt: daysAgo(10), dueAt: daysAgo(-300), outcome: 'pass', certificateDocumentVersionId: await p.cleanDrawing(p.orgs.supplierA) }), 201, 'calibrate');
    gauge = made['instrumentId'] as string;
    await inspect('fai', '12.004', 'LOT-A');
    await inspect('final', '12.006', 'LOT-A');
    for (;;) {
      const wp = ((await p.productionView(deal.orderId))['workPackages'] as Body[]).find((w) => w['workPackageId'] === prod.workPackageId)!;
      const m = (wp['milestones'] as Body[]).find((x) => x['status'] !== 'verified' && x['status'] !== 'waived');
      if (!m) break;
      if (m['status'] === 'evidence_submitted') ok(await p.as.quality.post(`/api/v1/milestones/${m['milestoneId']}/verify`, { expectedVersion: m['aggregateVersion'], decision: 'verified' }), 201, 'verify');
      else ok(await p.as.quality.post(`/api/v1/milestones/${m['milestoneId']}/waive`, { expectedVersion: m['aggregateVersion'], reason: 'Covered by the final inspection on record.' }), 201, 'waive');
    }
    ok(await p.as.quality.post('/api/v1/quality-releases', { workPackageId: prod.workPackageId, quantity: '20', lots: ['LOT-A'], serials: [] }), 201, 'release LOT-A');
  }, 240_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('ships only released lots, within the released quantity, with the statutory documents', async () => {
    expect((await p.as.supplierB.post('/api/v1/supplier/shipments', { purchaseOrderId: deal.purchaseOrderId, originSiteId: p.sites.supplierB, packages: packages('LOT-A', 5) })).status).toBe(404);
    const over = ok(await plan(packages('LOT-A', 15, 10)), 201, 'plan too many');
    expect(over).toMatchObject({ status: 'planned', totalQuantity: '25' });
    expect(red(over)).toEqual(['quantity']);
    expect((await p.as.supplierA.post(`/api/v1/supplier/shipments/${over['shipmentId']}/submit`, { expectedVersion: over['aggregateVersion'] })).body['code']).toBe('SHIPMENT_NOT_READY');
    const unknownLot = ok(await p.as.supplierA.post(`/api/v1/supplier/shipments/${over['shipmentId']}/replan`, { expectedVersion: over['aggregateVersion'], originSiteId: p.sites.supplierA, packages: packages('LOT-Z', 5), documents }), 201, 'replan');
    expect((unknownLot['guards'] as Body[]).find((g) => g['key'] === 'quantity')!['reasons']).toEqual(['LOT-Z is not quality released.']);
    const noDocs = ok(await p.as.supplierA.post(`/api/v1/supplier/shipments/${over['shipmentId']}/replan`, { expectedVersion: unknownLot['aggregateVersion'], originSiteId: p.sites.supplierA, packages: packages('LOT-A', 8, 4), documents: {} }), 201, 'replan');
    expect(red(noDocs)).toContain('documents');
    first = ok(await p.as.supplierA.post(`/api/v1/supplier/shipments/${over['shipmentId']}/replan`, { expectedVersion: noDocs['aggregateVersion'], originSiteId: p.sites.supplierA, packages: packages('LOT-A', 8, 4), documents }), 201, 'replan');
    expect(red(first)).toEqual([]);
    first = ok(await p.as.supplierA.post(`/api/v1/supplier/shipments/${first['shipmentId']}/submit`, { expectedVersion: first['aggregateVersion'] }), 201, 'submit');
    expect(first['status']).toBe('ready_for_release');
  });

  it('is released by JobWork logistics only, which freezes the addresses', async () => {
    expect((await p.as.supplierA.post(`/api/v1/shipments/${first['shipmentId']}/release`, { expectedVersion: first['aggregateVersion'] })).status).toBe(403);
    expect((await p.as.quality.post(`/api/v1/shipments/${first['shipmentId']}/release`, { expectedVersion: first['aggregateVersion'] })).status).toBe(403);
    first = ok(await p.as.logistics.post(`/api/v1/shipments/${first['shipmentId']}/release`, { expectedVersion: first['aggregateVersion'] }), 201, 'release');
    expect(first).toMatchObject({ status: 'released', origin: { city: 'Coimbatore' }, destination: { city: 'Chennai', label: 'JobWork receiving hub' } });
    // Doc 10 §11: a later edit to the supplier's site never rewrites the released shipment.
    await p.one(`UPDATE iam.organization_site SET city = 'Tiruppur' WHERE id = $1 RETURNING id`, [p.sites.supplierA]);
    expect(ok(await p.as.supplierA.get(`/api/v1/supplier/shipments/${first['shipmentId']}`), 200, 'view')['origin']).toMatchObject({ city: 'Coimbatore' });
    await p.dispatchNotifications();
    expect((await p.notices('supplierA')).map((n) => n.template_key)).toContain('supplier.shipment_released');
  });

  it('is handed to a named carrier, and the order is in transit to JobWork', async () => {
    expect((await p.as.supplierA.post(`/api/v1/supplier/shipments/${first['shipmentId']}/pickup`, { expectedVersion: first['aggregateVersion'], carrierMode: 'carrier', carrierName: 'Safe Carriers' })).body['code']).toBe('CARRIER_INCOMPLETE');
    first = ok(await p.as.supplierA.post(`/api/v1/supplier/shipments/${first['shipmentId']}/pickup`, { expectedVersion: first['aggregateVersion'], carrierMode: 'carrier', carrierName: 'Safe Carriers', trackingReference: 'LR-55021' }), 201, 'pickup');
    expect(first).toMatchObject({ status: 'picked_up', carrier: { mode: 'carrier', trackingReference: 'LR-55021' } });
    expect((await p.one<{ status: string }>(`SELECT status FROM orders.sales_order WHERE id = $1`, [deal.orderId])).status).toBe('in_supplier_to_jobwork_transit');
  });

  it('takes the carrier’s word as evidence only: "delivered" receives nothing (doc 06 §11)', async () => {
    expect((await webhook({ id: 'evt-1', reference: 'LR-55021', code: 'DL' }, 'wrong-secret')).status).toBe(401);
    expect((await webhook({ id: 'evt-1', reference: 'LR-55021', code: 'DL' })).body).toMatchObject({ outcome: 'processed' });
    expect((await webhook({ id: 'evt-1', reference: 'LR-55021', code: 'DL' })).body).toMatchObject({ outcome: 'duplicate' });
    expect((await webhook({ id: 'evt-2', reference: 'LR-55021', code: 'ZZ' })).body).toMatchObject({ outcome: 'ignored' });
    const s = ok(await p.as.logistics.get(`/api/v1/shipments/${first['shipmentId']}`), 200, 'shipment');
    expect(s).toMatchObject({ status: 'delivered_to_destination', carrierEvents: [expect.objectContaining({ normalizedStatus: 'delivered', rawStatus: 'DL' })] });
    expect(s['carrierDeliveredAt']).not.toBeNull();
    expect((await p.one<{ n: number }>(`SELECT count(*)::int AS n FROM logistics.stock_lot`)).n).toBe(0);
    expect((await p.one<{ n: number }>(`SELECT count(*)::int AS n FROM logistics.receiving_record`)).n).toBe(0);
    expect((await p.one<{ status: string }>(`SELECT status FROM orders.sales_order WHERE id = $1`, [deal.orderId])).status).toBe('in_supplier_to_jobwork_transit');
  });

  it('counts earlier shipments against the release, and holds a lot an NCR names', async () => {
    const tooMany = ok(await plan(packages('LOT-A', 10)), 201, 'second');
    expect((tooMany['guards'] as Body[]).find((g) => g['key'] === 'quantity')!['reasons']).toEqual(['LOT-A: 22 would ship against 20 released.', '22 would ship against 20 released in all.']);
    // A later inspection of LOT-A fails and an NCR holds the lot.
    failed = await inspect('final', '12.030', 'LOT-A');
    const bore = (failed['results'] as Body[]).find((r) => r['characteristicId'] === characteristic(failed, 'Bore diameter') && r['outcome'] === 'fail')!;
    ncrId = ok(await p.as.quality.post('/api/v1/ncrs', { inspectionId: failed['inspectionId'], resultIds: [bore['resultId']], title: 'LOT-A bore oversize', description: 'Found at a repeat final', severity: 'major', affectedQuantity: '20', lots: ['LOT-A'] }), 201, 'NCR')['ncrId'] as string;
    const held = ok(await p.as.supplierA.post(`/api/v1/supplier/shipments/${tooMany['shipmentId']}/replan`, { expectedVersion: tooMany['aggregateVersion'], originSiteId: p.sites.supplierA, packages: packages('LOT-A', 8), documents }), 201, 'replan');
    expect(red(held)).toEqual(['holds']);
    expect(((held['guards'] as Body[]).find((g) => g['key'] === 'holds')!['reasons'] as string[])[0]).toMatch(/^NCR-\d{4}-\d{4} holds LOT-A\.$/);
    second = held;
  });

  it('ships the same lot once a deviation accepts the NCR (BR-QUA-03)', async () => {
    let ncr = ok(await p.as.supplierA.post(`/api/v1/supplier/ncrs/${ncrId}/containment`, { action: 'LOT-A held in its boxes' }), 201, 'contain');
    ncr = ok(await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/to-disposition`, { expectedVersion: ncr['aggregateVersion'] }), 201, 'to disposition');
    const deviation = ok(
      await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/deviations`, {
        expectedVersion: ncr['aggregateVersion'],
        characteristicIds: [characteristic(failed, 'Bore diameter')],
        quantity: '20',
        lots: ['LOT-A'],
        expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        rationale: 'A 10 µm larger bore still gives a running fit with the customer shaft',
        riskAssessment: 'Low: within the shaft tolerance stack',
        fitFunctionSafety: 'Assembled on the customer gauge; no safety function',
        labelingEffect: 'LOT-A boxes labelled with the deviation number',
      }),
      201,
      'request deviation',
    );
    ok(await p.decide('quality2', deviation['approvalRequestId'] as string), 201, 'internal approval');
    const card = (ok(await p.as.approver.get(`/api/v1/orders/${deal.orderId}/deviations`), 200, 'customer list') as unknown as Body[])[0]!;
    ok(await p.as.approver.post(`/api/v1/customer/deviations/${deviation['deviationId']}/decide`, { expectedVersion: card['aggregateVersion'], decision: 'approved', acknowledgeScope: true }), 201, 'customer approves');
    const green = ok(await p.as.supplierA.get(`/api/v1/supplier/shipments/${second['shipmentId']}`), 200, 'shipment');
    expect(red(green)).toEqual([]);
    expect(ok(await p.as.supplierA.post(`/api/v1/supplier/shipments/${second['shipmentId']}/submit`, { expectedVersion: green['aggregateVersion'] }), 201, 'submit')['status']).toBe('ready_for_release');
  });

  it('shows a supplier only its own shipments, and the customer none', async () => {
    expect((await p.as.supplierB.get('/api/v1/supplier/shipments')).body).toEqual([]);
    expect((await p.as.supplierB.get(`/api/v1/supplier/shipments/${first['shipmentId']}`)).status).toBe(404);
    expect((await p.as.buyer.get('/api/v1/supplier/shipments')).status).toBe(403);
    expect((await p.as.buyer.get('/api/v1/shipments')).status).toBe(403);
  });
});
