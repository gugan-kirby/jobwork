import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './driver';

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString();

/**
 * Pilot scenario 8 (doc 19 §10; IN-15 F-15.6): a scoped, customer-approved deviation. Two lots
 * go through final inspection; LOT-B's bores are a few microns over. JobWork asks to deliver
 * LOT-B as it is, scoped to that lot and a period, with a labelling effect; another quality
 * member and then the customer's approver accept it. LOT-A and LOT-B release separately; a
 * release mixing them is refused; the failed results stay failed; and once the deviation
 * expires nothing more of LOT-B releases (doc 19 §6: the rest stays held).
 */
describe('Pilot 8: scoped customer-approved deviation', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let prod: { workPackageId: string };
  let gauge: string;
  let lotB: Body;
  let ncr: Body;
  let deviation: Body;

  const characteristic = (i: Body, name: string): string => ((i['characteristics'] as Body[]).find((c) => c['name'] === name)!['characteristicId']) as string;
  const release = (quantity: string, lots: string[]) => p.as.quality.post('/api/v1/quality-releases', { workPackageId: prod.workPackageId, quantity, lots, serials: [] });

  async function inspect(stage: 'fai' | 'final', bore: string, lot: string): Promise<Body> {
    let i = ok(await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage, lot }), 201, `plan ${stage} ${lot}`);
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
    return ok(await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/decide`, { expectedVersion: i['aggregateVersion'], decision: pass ? 'passed' : 'failed', reason: pass ? '' : `LOT ${lot} bores ${bore} mm` }), 201, 'decide');
  }

  beforeAll(async () => {
    p = await Pilot.start('s08');
    const { enquiryId } = await p.approvedEnquiry();
    deal = await p.sourceToPurchaseOrder(enquiryId);
    prod = await p.intoProduction(deal);
    const made = ok(await p.as.supplierA.post('/api/v1/supplier/instruments', { assetTag: 'BG-01', kind: 'Bore gauge', unit: 'mm' }), 201, 'instrument');
    ok(await p.as.supplierA.post(`/api/v1/supplier/instruments/${made['instrumentId']}/calibrations`, { performedAt: daysAgo(10), dueAt: daysAgo(-300), outcome: 'pass', certificateDocumentVersionId: await p.cleanDrawing(p.orgs.supplierA) }), 201, 'calibrate');
    gauge = made['instrumentId'] as string;
    await inspect('fai', '12.004', 'LOT-A');
    await inspect('final', '12.006', 'LOT-A');
    lotB = await inspect('final', '12.024', 'LOT-B');
    for (;;) {
      const wp = ((await p.productionView(deal.orderId))['workPackages'] as Body[]).find((w) => w['workPackageId'] === prod.workPackageId)!;
      const m = (wp['milestones'] as Body[]).find((x) => x['status'] !== 'verified' && x['status'] !== 'waived');
      if (!m) break;
      if (m['status'] === 'evidence_submitted') ok(await p.as.quality.post(`/api/v1/milestones/${m['milestoneId']}/verify`, { expectedVersion: m['aggregateVersion'], decision: 'verified' }), 201, 'verify');
      else ok(await p.as.quality.post(`/api/v1/milestones/${m['milestoneId']}/waive`, { expectedVersion: m['aggregateVersion'], reason: 'Covered by the final inspections on record.' }), 201, 'waive');
    }
  }, 240_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('holds everything while LOT-B’s failure stands', async () => {
    const failing = (lotB['results'] as Body[]).filter((r) => r['outcome'] === 'fail' && r['characteristicId'] === characteristic(lotB, 'Bore diameter'));
    expect(failing).toHaveLength(5);
    ncr = ok(
      await p.as.quality.post('/api/v1/ncrs', { inspectionId: lotB['inspectionId'], resultIds: failing.map((r) => r['resultId']), title: 'LOT-B bores 4 µm over', description: 'Final inspection: five of five at 12.024 mm', severity: 'major', affectedQuantity: '20', lots: ['LOT-B'] }),
      201,
      'open NCR',
    );
    ncr = ok(await p.as.supplierA.post(`/api/v1/supplier/ncrs/${ncr['ncrId']}/containment`, { action: 'LOT-B held in its boxes' }), 201, 'contain');
    ncr = ok(await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/to-disposition`, { expectedVersion: ncr['aggregateVersion'] }), 201, 'to disposition');
    const blocked = await release('20', ['LOT-A']);
    expect(blocked.body['code']).toBe('RELEASE_BLOCKED');
    expect(blocked.body['detail']).toContain('not covered by an active deviation');
  });

  it('is accepted for LOT-B only, inside JobWork and by the customer approver', async () => {
    deviation = ok(
      await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/deviations`, {
        expectedVersion: ncr['aggregateVersion'],
        characteristicIds: [characteristic(lotB, 'Bore diameter')],
        quantity: '20',
        lots: ['LOT-B'],
        expiresAt: inDays(30),
        rationale: 'A 4 µm larger bore still gives a running fit with the customer shaft',
        riskAssessment: 'Low: within the shaft tolerance stack',
        fitFunctionSafety: 'Assembled on the customer gauge; no safety function',
        labelingEffect: 'LOT-B boxes labelled with the deviation number',
      }),
      201,
      'request deviation',
    );
    expect(deviation).toMatchObject({ customerApprovalRequired: true, status: 'pending_internal' });
    ok(await p.decide('quality2', deviation['approvalRequestId'] as string), 201, 'internal approval');
    const card = (ok(await p.as.approver.get(`/api/v1/orders/${deal.orderId}/deviations`), 200, 'customer list') as unknown as Body[])[0]!;
    expect(card).toMatchObject({ decisionNeeded: true, lots: [], effects: expect.objectContaining({ labeling: 'LOT-B boxes labelled with the deviation number' }) });
    ok(await p.as.approver.post(`/api/v1/customer/deviations/${deviation['deviationId']}/decide`, { expectedVersion: card['aggregateVersion'], decision: 'approved', acknowledgeScope: true }), 201, 'customer approves');
    expect(ok(await p.as.quality.get(`/api/v1/ncrs/${ncr['ncrId']}`), 200, 'ncr')['status']).toBe('accepted_under_deviation');
  });

  it('releases the lots separately, never mixed, and keeps the failed results failed', async () => {
    const mixed = await release('40', ['LOT-A', 'LOT-B']);
    expect(mixed.body['code']).toBe('RELEASE_BLOCKED');
    expect(mixed.body['detail']).toContain('release on their own');
    expect((await release('21', ['LOT-B'])).body['detail']).toContain('covers 20 more parts at most');
    const b = ok(await release('20', ['LOT-B']), 201, 'release LOT-B');
    expect((b['snapshot'] as Body)['deviationsReliedOn']).toEqual([deviation['number']]);
    const a = ok(await release('20', ['LOT-A']), 201, 'release LOT-A');
    expect((a['snapshot'] as Body)['deviationsReliedOn']).toEqual([]);
    const outcomes = await p.rows<{ outcome: string }>(`SELECT r.outcome FROM quality.inspection_result r JOIN quality.characteristic c ON c.id = r.characteristic_id WHERE r.inspection_id = $1 AND c.name = 'Bore diameter'`, [lotB['inspectionId']]);
    expect(outcomes.map((o) => o.outcome)).toEqual(['fail', 'fail', 'fail', 'fail', 'fail']);
  });

  it('stops releasing LOT-B once the deviation expires', async () => {
    // Time passing, simulated in this test's own database: a deviation's dates never change in use.
    await p.one(`ALTER TABLE quality.deviation DISABLE TRIGGER trg_deviation_transition`);
    await p.one(`UPDATE quality.deviation SET requested_at = now() - interval '40 days', expires_at = now() - interval '1 minute' WHERE id = $1 RETURNING id`, [deviation['deviationId']]);
    await p.one(`ALTER TABLE quality.deviation ENABLE TRIGGER trg_deviation_transition`);
    const after = await p.as.quality.post('/api/v1/quality-releases/checklist', { workPackageId: prod.workPackageId, quantity: '1', lots: ['LOT-B'], serials: [] });
    const items = (after.body['items'] as Body[]).filter((i) => !i['pass']).map((i) => i['key']);
    expect(items).toEqual(expect.arrayContaining(['inspections', 'ncrs', 'quantity']));
    const facts = ok(await p.as.quality.get(`/api/v1/work-packages/${prod.workPackageId}/release-facts`), 200, 'facts');
    expect(facts).toMatchObject({ releasedQuantity: '40', activeDeviations: [] });
  });
});
