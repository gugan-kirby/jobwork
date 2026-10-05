import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './driver';

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * Pilot scenario 7 (IN-14 F-14.5; doc 09 §§9–10; UC-18, UC-28): the first-article cycle on the
 * launch template. JobWork quality's approved plan (two drawing dimensions, one critical, plus
 * the template's surface finish and visual) is what lets the work package release. The
 * supplier measures the first piece with a calibrated bore gauge and a caliper past its due
 * date; JobWork quality corrects a transcription with the original kept, accepts the caliper
 * reading with a reason, and passes it. A second first article with an oversize bore fails,
 * and the failure carries what an NCR will need. The customer sees none of it.
 */
describe('Pilot 7: first-article inspection on the launch template', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let prod: { workPackageId: string; qualityPlanId: string };
  let gauge: string;
  let caliper: string;
  let first: Body;
  let second: Body;
  let ncr: Body;

  const characteristic = (i: Body, name: string): string => ((i['characteristics'] as Body[]).find((c) => c['name'] === name)!['characteristicId']) as string;
  const standing = (i: Body, name: string): Body => (i['results'] as Body[]).find((r) => r['characteristicId'] === characteristic(i, name) && r['supersededByResultId'] === null)!;

  async function instrument(assetTag: string, kind: string, performedDaysAgo: number, dueDaysAgo: number): Promise<string> {
    const made = ok(await p.as.supplierA.post('/api/v1/supplier/instruments', { assetTag, kind, unit: 'mm', resolution: '0.001' }), 201, `register ${assetTag}`);
    ok(
      await p.as.supplierA.post(`/api/v1/supplier/instruments/${made['instrumentId']}/calibrations`, {
        performedAt: daysAgo(performedDaysAgo),
        dueAt: daysAgo(dueDaysAgo),
        outcome: 'pass',
        certificateDocumentVersionId: await p.cleanDrawing(p.orgs.supplierA),
      }),
      201,
      `calibrate ${assetTag}`,
    );
    return made['instrumentId'] as string;
  }

  async function measure(note: string, values: { visual: string; ra: string; bore: string; length: string }): Promise<Body> {
    let i = ok(await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'fai', note }), 201, 'plan FAI');
    i = ok(await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/start`, { expectedVersion: i['aggregateVersion'] }), 201, 'start FAI');
    const decimals = (v: string): number => (v.includes('.') ? v.split('.')[1]!.length : 0);
    return ok(
      await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/results`, {
        expectedVersion: i['aggregateVersion'],
        inspectedAt: new Date().toISOString(),
        samples: [{ sampleNo: 1, serial: 'FA-001' }],
        results: [
          { sampleNo: 1, characteristicId: characteristic(i, 'Visual: free of burrs and sharp edges'), measurement: { value: values.visual, unit: null, declaredPrecision: null } },
          { sampleNo: 1, characteristicId: characteristic(i, 'Surface roughness Ra'), measurement: { value: values.ra, unit: 'um', declaredPrecision: decimals(values.ra) }, instrumentId: gauge },
          { sampleNo: 1, characteristicId: characteristic(i, 'Bore diameter'), measurement: { value: values.bore, unit: 'mm', declaredPrecision: decimals(values.bore) }, instrumentId: gauge },
          { sampleNo: 1, characteristicId: characteristic(i, 'Overall length'), measurement: { value: values.length, unit: 'mm', declaredPrecision: decimals(values.length) }, instrumentId: caliper },
        ],
      }),
      201,
      'submit FAI',
    );
  }

  /** The supplier measures an inspection JobWork already planned (a reinspection), and JobWork decides it. */
  async function measureExisting(planned: Body, bore: string): Promise<Body> {
    let i = ok(await p.as.supplierA.post(`/api/v1/supplier/inspections/${planned['inspectionId']}/start`, { expectedVersion: planned['aggregateVersion'] }), 201, 'start reinspection');
    const decimals = (v: string): number => (v.includes('.') ? v.split('.')[1]!.length : 0);
    i = ok(
      await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/results`, {
        expectedVersion: i['aggregateVersion'],
        inspectedAt: new Date().toISOString(),
        samples: [{ sampleNo: 1, serial: 'FA-002' }],
        results: [
          { sampleNo: 1, characteristicId: characteristic(i, 'Visual: free of burrs and sharp edges'), measurement: { value: 'conforming', unit: null, declaredPrecision: null } },
          { sampleNo: 1, characteristicId: characteristic(i, 'Surface roughness Ra'), measurement: { value: '1.6', unit: 'um', declaredPrecision: 1 }, instrumentId: gauge },
          { sampleNo: 1, characteristicId: characteristic(i, 'Bore diameter'), measurement: { value: bore, unit: 'mm', declaredPrecision: decimals(bore) }, instrumentId: gauge },
          { sampleNo: 1, characteristicId: characteristic(i, 'Overall length'), measurement: { value: '80.00', unit: 'mm', declaredPrecision: 2 }, instrumentId: gauge },
        ],
      }),
      201,
      'submit reinspection',
    );
    i = ok(await p.as.quality2.post(`/api/v1/inspections/${i['inspectionId']}/review`, { expectedVersion: i['aggregateVersion'] }), 201, 'review reinspection');
    return ok(await p.as.quality2.post(`/api/v1/inspections/${i['inspectionId']}/decide`, { expectedVersion: i['aggregateVersion'], decision: 'passed' }), 201, 'pass reinspection');
  }

  beforeAll(async () => {
    p = await Pilot.start('s07');
    const { enquiryId } = await p.approvedEnquiry();
    deal = await p.sourceToPurchaseOrder(enquiryId);
    prod = await p.intoProduction(deal);
    gauge = await instrument('BG-01', 'Bore gauge 10–18 mm', 30, -335);
    caliper = await instrument('VC-02', 'Vernier caliper 0–150 mm', 400, 35);
  }, 240_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('releases the work package only on an approved plan from the launch template', async () => {
    const plan = ok(await p.as.quality.get(`/api/v1/quality-plans/${prod.qualityPlanId}`), 200, 'plan');
    expect(plan).toMatchObject({ status: 'approved', templateCode: 'cnc_machined_part', templateVersionNo: 1, baselineCurrent: true });
    expect((plan['characteristics'] as Body[]).map((c) => [c['name'], c['criticality'], c['drawingReference']])).toEqual([
      ['Visual: free of burrs and sharp edges', 'minor', ''],
      ['Surface roughness Ra', 'minor', ''],
      ['Bore diameter', 'critical', '7'],
      ['Overall length', 'major', '12'],
    ]);
    const release = await p.one<{ release_snapshot: Body }>(`SELECT release_snapshot FROM orders.work_package WHERE id = $1`, [prod.workPackageId]);
    const compliance = ((release.release_snapshot['gates'] as Body[]) ?? []).find((g) => g['key'] === 'compliance');
    expect(compliance).toMatchObject({ pass: true, evidence: expect.objectContaining({ qualityPlan: 'approved' }) });
  });

  it('passes the first article once a transcription is corrected and the out-of-calibration caliper is accepted', async () => {
    first = await measure('First off the VMC', { visual: 'conforming', ra: '32', bore: '12.004', length: '80.05' });
    expect(standing(first, 'Overall length')).toMatchObject({ outcome: 'pass', calibrationStatus: 'expired' });
    expect(standing(first, 'Surface roughness Ra')).toMatchObject({ outcome: 'fail' });
    first = ok(await p.as.quality.post(`/api/v1/inspections/${first['inspectionId']}/review`, { expectedVersion: first['aggregateVersion'] }), 201, 'review');
    first = ok(
      await p.as.quality.post(`/api/v1/inspections/${first['inspectionId']}/corrections`, {
        expectedVersion: first['aggregateVersion'],
        resultId: standing(first, 'Surface roughness Ra')['resultId'],
        measurement: { value: '3.2', unit: 'um', declaredPrecision: 1 },
        instrumentId: gauge,
        reason: 'Decimal point dropped; the tester printout reads 3.2',
      }),
      201,
      'correct Ra',
    );
    first = ok(
      await p.as.quality.post(`/api/v1/inspections/${first['inspectionId']}/dispositions`, {
        expectedVersion: first['aggregateVersion'],
        resultId: standing(first, 'Overall length')['resultId'],
        decision: 'accept',
        reason: 'Re-measured at JobWork on a calibrated height gauge: 80.04 mm',
      }),
      201,
      'accept caliper',
    );
    expect(first['passBlockers']).toEqual([]);
    first = ok(await p.as.quality.post(`/api/v1/inspections/${first['inspectionId']}/decide`, { expectedVersion: first['aggregateVersion'], decision: 'passed' }), 201, 'pass');
    expect(first['status']).toBe('passed');
    // Nothing was rewritten: four results plus one correction, the 32 µm still on record.
    const rows = await p.rows<{ original_value: string; outcome: string; supersedes_result_id: string | null }>(`SELECT original_value, outcome, supersedes_result_id FROM quality.inspection_result WHERE inspection_id = $1 ORDER BY recorded_at`, [first['inspectionId']]);
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.original_value === '32')).toMatchObject({ outcome: 'fail' });
    expect(await p.auditActions(first['inspectionId'] as string)).toEqual([
      'quality.inspection_planned',
      'quality.inspection_started',
      'quality.results_submitted',
      'quality.review_started',
      'quality.result_corrected',
      'quality.calibration_dispositioned',
      'quality.inspection_passed',
    ]);
  });

  it('fails a first article with an oversize critical bore, and says what an NCR needs', async () => {
    second = await measure('Second setup after tool change', { visual: 'conforming', ra: '1.6', bore: '12.031', length: '80.00' });
    second = ok(await p.as.quality.post(`/api/v1/inspections/${second['inspectionId']}/review`, { expectedVersion: second['aggregateVersion'] }), 201, 'review');
    const refused = await p.as.quality.post(`/api/v1/inspections/${second['inspectionId']}/decide`, { expectedVersion: second['aggregateVersion'], decision: 'passed' });
    expect(refused.body['code']).toBe('INSPECTION_CANNOT_PASS');
    second = ok(await p.as.quality.post(`/api/v1/inspections/${second['inspectionId']}/dispositions`, { expectedVersion: second['aggregateVersion'], resultId: standing(second, 'Overall length')['resultId'], decision: 'reinspect', reason: 'Caliper out of calibration; measure again on a calibrated one' }), 201, 'reinspect length');
    second = ok(await p.as.quality.post(`/api/v1/inspections/${second['inspectionId']}/decide`, { expectedVersion: second['aggregateVersion'], decision: 'failed', reason: 'Bore 12.031 mm over 12.02 mm after the tool change' }), 201, 'fail');
    const event = await p.one<{ data: Body }>(`SELECT data FROM platform.outbox_event WHERE event_type = 'quality.inspection_failed.v1' AND aggregate_id = $1`, [second['inspectionId']]);
    expect(event.data).toMatchObject({
      stage: 'fai',
      inspectedBySupplier: true,
      purchaseOrderId: deal.purchaseOrderId,
      failures: [{ name: 'Bore diameter', drawingReference: '7', criticality: 'critical', mandatory: true, sampleNos: [1] }],
    });
    await p.dispatchNotifications();
    expect((await p.notices('supplierA')).filter((n) => n.template_key === 'supplier.inspection_decided')).toHaveLength(2);
  });

  it('keeps every inspection away from the customer and the other supplier', async () => {
    const order = ok(await p.as.buyer.get(`/api/v1/orders/${deal.orderId}`), 200, 'customer order');
    p.expectNothingOf(order, ['QI-', 'Bore diameter', 'BG-01', 'VC-02', 'inspection'], 'customer order view');
    expect((await p.as.buyer.get(`/api/v1/supplier/inspections/${first['inspectionId']}`)).status).toBe(403);
    expect((await p.as.supplierB.get('/api/v1/supplier/inspections')).body).toEqual([]);
    expect((await p.as.supplierB.get(`/api/v1/supplier/inspections/${first['inspectionId']}`)).status).toBe(404);
  });

  it('takes the failed first article through an NCR, a rework and a reinspection to an independent closure (doc 19 §10 scenario 7)', async () => {
    const bore = standing(second, 'Bore diameter');
    ncr = ok(
      await p.as.quality.post('/api/v1/ncrs', { inspectionId: second['inspectionId'], resultIds: [bore['resultId']], title: 'Bore oversize after the tool change', description: 'Bore 12.031 mm against 11.98–12.02 mm', severity: 'critical', affectedQuantity: '40', lots: ['LOT-2'], costResponsibility: 'supplier' }),
      201,
      'open NCR',
    );
    ncr = ok(await p.as.supplierA.post(`/api/v1/supplier/ncrs/${ncr['ncrId']}/containment`, { action: 'LOT-2 tagged red and held', location: 'Hold rack' }), 201, 'contain');
    ncr = ok(await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/to-disposition`, { expectedVersion: ncr['aggregateVersion'] }), 201, 'to disposition');
    ncr = ok(await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/approve-rework`, { expectedVersion: ncr['aggregateVersion'], disposition: 'rework', plan: 'Re-bore LOT-2 to 12.000 with a new insert' }), 201, 'approve rework');
    ncr = ok(await p.as.supplierA.post(`/api/v1/supplier/ncrs/${ncr['ncrId']}/rework`, { expectedVersion: ncr['aggregateVersion'], note: 'LOT-2 re-bored' }), 201, 'record rework');
    ncr = ok(await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/reinspection`, { expectedVersion: ncr['aggregateVersion'] }), 201, 'plan reinspection');
    const reinspection = ok(await p.as.supplierA.get(`/api/v1/supplier/inspections/${((ncr['dispositions'] as Body[])[0]!['reinspection'] as Body)['inspectionId']}`), 200, 'reinspection');
    expect(reinspection['reinspectionOf']).toBe(second['inspectionId']);
    await measureExisting(reinspection, '12.003');
    ncr = ok(await p.as.quality.get(`/api/v1/ncrs/${ncr['ncrId']}`), 200, 'ncr');
    expect(ncr['status']).toBe('verified');

    const ca = () => ncr['correctiveAction'] as Body;
    ncr = ok(
      await p.as.supplierA.post(`/api/v1/supplier/ncrs/${ncr['ncrId']}/corrective-action`, {
        expectedVersion: ca()['aggregateVersion'],
        problemDefinition: 'Bores oversize after an insert change',
        occurrenceCause: 'New insert set 0.01 mm out; no offset check after an insert change',
        escapeCause: 'First-off after an insert change was not gauged',
        actions: [{ action: 'Gauge the first bore after every insert change', owner: 'Setter', dueDate: '2026-10-12' }],
      }),
      201,
      'corrective action',
    );
    ncr = ok(await p.as.quality2.post(`/api/v1/ncrs/${ncr['ncrId']}/corrective-action/review`, { expectedVersion: ca()['aggregateVersion'], decision: 'accept' }), 201, 'accept CA');
    ncr = ok(await p.as.quality2.post(`/api/v1/ncrs/${ncr['ncrId']}/corrective-action/verify`, { expectedVersion: ca()['aggregateVersion'], evidence: 'Next first article after an insert change gauged at 12.004 mm' }), 201, 'verify CA');
    // The person who approved the rework cannot close; another quality member does.
    expect((await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/close`, { expectedVersion: ncr['aggregateVersion'], note: 'Done' })).body['code']).toBe('NCR_CANNOT_CLOSE');
    ncr = ok(await p.as.quality2.post(`/api/v1/ncrs/${ncr['ncrId']}/close`, { expectedVersion: ncr['aggregateVersion'], note: 'Reworked lot passed reinspection; corrective action effective' }), 201, 'close');
    expect(ncr['status']).toBe('closed');
    // The failed result is still failed; the reinspection is a separate record (BR-QLT-04).
    expect(standing(ok(await p.as.quality.get(`/api/v1/inspections/${second['inspectionId']}`), 200, 'second'), 'Bore diameter')['outcome']).toBe('fail');
  });

  it('then releases the work package on a computed checklist', async () => {
    // A final inspection, and every milestone verified or waived.
    let fin = ok(await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'final', lot: 'LOT-2' }), 201, 'plan final');
    fin = ok(await p.as.supplierA.post(`/api/v1/supplier/inspections/${fin['inspectionId']}/start`, { expectedVersion: fin['aggregateVersion'] }), 201, 'start final');
    fin = ok(
      await p.as.supplierA.post(`/api/v1/supplier/inspections/${fin['inspectionId']}/results`, {
        expectedVersion: fin['aggregateVersion'],
        inspectedAt: new Date().toISOString(),
        samples: [1, 2, 3, 4, 5].map((n) => ({ sampleNo: n, lot: 'LOT-2' })),
        results: [1, 2, 3, 4, 5].flatMap((n) => [
          { sampleNo: n, characteristicId: characteristic(fin, 'Visual: free of burrs and sharp edges'), measurement: { value: 'conforming', unit: null, declaredPrecision: null } },
          { sampleNo: n, characteristicId: characteristic(fin, 'Bore diameter'), measurement: { value: '12.002', unit: 'mm', declaredPrecision: 3 }, instrumentId: gauge },
        ]),
      }),
      201,
      'submit final',
    );
    fin = ok(await p.as.quality.post(`/api/v1/inspections/${fin['inspectionId']}/review`, { expectedVersion: fin['aggregateVersion'] }), 201, 'review final');
    ok(await p.as.quality.post(`/api/v1/inspections/${fin['inspectionId']}/decide`, { expectedVersion: fin['aggregateVersion'], decision: 'passed' }), 201, 'pass final');
    for (;;) {
      const wp = ((await p.productionView(deal.orderId))['workPackages'] as Body[]).find((w) => w['workPackageId'] === prod.workPackageId)!;
      const m = (wp['milestones'] as Body[]).find((x) => x['status'] !== 'verified' && x['status'] !== 'waived');
      if (!m) break;
      if (m['status'] === 'evidence_submitted') ok(await p.as.quality.post(`/api/v1/milestones/${m['milestoneId']}/verify`, { expectedVersion: m['aggregateVersion'], decision: 'verified' }), 201, 'verify');
      else ok(await p.as.quality.post(`/api/v1/milestones/${m['milestoneId']}/waive`, { expectedVersion: m['aggregateVersion'], reason: 'Covered by the final inspection on record.' }), 201, 'waive');
    }
    const release = ok(await p.as.quality.post('/api/v1/quality-releases', { workPackageId: prod.workPackageId, quantity: '40', lots: ['LOT-2'], serials: [] }), 201, 'release');
    expect(release['quantity']).toBe('40.0000');
    const facts = ok(await p.as.quality.get(`/api/v1/work-packages/${prod.workPackageId}/release-facts`), 200, 'facts');
    expect(facts).toMatchObject({ releasedQuantity: '40', openNcrs: [] });
  });
});
