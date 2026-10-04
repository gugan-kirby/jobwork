import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './pilot/driver';

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * Quality plans, instruments and inspections over HTTP (IN-14 F-14.3; doc 09 §§9–10; doc 06 §10;
 * FR-701–702; BR-QLT-03, BR-QLT-05; doc 19 §6). A deal in production carries an approved plan from
 * the launch template; the supplier measures a first article with its own instruments, one past
 * its calibration; JobWork quality corrects a transcription, dispositions the instrument, and
 * decides. Units, boundaries and cannot-evaluate are judged by the engine as results arrive.
 */
describe('Quality plans and inspections (F-14.3)', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let prod: { workPackageId: string; qualityPlanId: string };
  const tools: Record<string, string> = {};
  let fai: Body;

  const byName = (i: Body, name: string): Body => (i['characteristics'] as Body[]).find((c) => c['name'] === name)!;
  const current = (i: Body): Body[] => (i['results'] as Body[]).filter((r) => r['supersededByResultId'] === null);

  async function instrument(assetTag: string, kind: string, calibration: { performedDaysAgo: number; dueDaysAgo: number } | null): Promise<string> {
    const made = ok(await p.as.supplierA.post('/api/v1/supplier/instruments', { assetTag, kind, unit: 'mm', resolution: '0.001' }), 201, `register ${assetTag}`);
    if (calibration) {
      const certificate = await p.cleanDrawing(p.orgs.supplierA);
      ok(
        await p.as.supplierA.post(`/api/v1/supplier/instruments/${made['instrumentId']}/calibrations`, {
          performedAt: daysAgo(calibration.performedDaysAgo),
          dueAt: daysAgo(calibration.dueDaysAgo),
          outcome: 'pass',
          certificateDocumentVersionId: certificate,
        }),
        201,
        `calibrate ${assetTag}`,
      );
    }
    return made['instrumentId'] as string;
  }

  beforeAll(async () => {
    p = await Pilot.start('quality');
    const { enquiryId } = await p.approvedEnquiry();
    deal = await p.sourceToPurchaseOrder(enquiryId);
    prod = await p.intoProduction(deal);
    tools['bore'] = await instrument('BG-01', 'Bore gauge 10–18 mm', { performedDaysAgo: 30, dueDaysAgo: -335 });
    tools['caliper'] = await instrument('VC-02', 'Vernier caliper 0–150 mm', { performedDaysAgo: 400, dueDaysAgo: 35 });
    tools['profilometer'] = await instrument('SR-03', 'Surface roughness tester', { performedDaysAgo: 10, dueDaysAgo: -170 });
  }, 240_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('keeps instruments to their owner: calibration needs its own clean certificate, and tags are unique', async () => {
    const list = ok(await p.as.supplierA.get('/api/v1/supplier/instruments'), 200, 'instruments') as unknown as Body[];
    expect(list.map((i) => [i['assetTag'], i['calibrationStatus']])).toEqual([
      ['BG-01', 'valid'],
      ['SR-03', 'valid'],
      ['VC-02', 'expired'],
    ]);
    expect((await p.as.supplierB.get('/api/v1/supplier/instruments')).body).toEqual([]);
    expect((await p.as.supplierB.get(`/api/v1/supplier/instruments/${tools['bore']}`)).status).toBe(404);
    expect((await p.as.supplierA.post('/api/v1/supplier/instruments', { assetTag: 'BG-01', kind: 'Again' })).body['code']).toBe('ASSET_TAG_TAKEN');
    const foreign = await p.cleanDrawing(p.orgs.supplierB);
    const refused = await p.as.supplierA.post(`/api/v1/supplier/instruments/${tools['caliper']}/calibrations`, { performedAt: daysAgo(1), dueAt: daysAgo(-364), outcome: 'pass', certificateDocumentVersionId: foreign });
    expect([refused.status, refused.body['code']]).toEqual([422, 'CERTIFICATE_UNAVAILABLE']);
    // JobWork quality sees every organization's equipment.
    expect(((await p.as.quality.get('/api/v1/instruments')).body as unknown as Body[]).length).toBe(3);
  });

  it('plans a first-article inspection of the stage’s characteristics, and tells only that supplier', async () => {
    expect((await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'incoming' })).body['code']).toBe('STAGE_NOT_IN_PLAN');
    expect((await p.as.engineering.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'fai' })).status).toBe(403);
    fai = ok(await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'fai', note: 'First off the VMC' }), 201, 'plan FAI');
    expect(fai).toMatchObject({ status: 'planned', stage: 'fai', sampleSize: 1, planVersionNo: 1 });
    expect((fai['characteristics'] as Body[]).map((c) => c['name'])).toEqual(['Visual: free of burrs and sharp edges', 'Surface roughness Ra', 'Bore diameter', 'Overall length']);
    await p.dispatchNotifications();
    expect((await p.notices('supplierA')).map((n) => n.template_key)).toContain('supplier.inspection_planned');
    expect((await p.notices('supplierB')).map((n) => n.template_key)).not.toContain('supplier.inspection_planned');
    // The supplier sees its own inspection, without JobWork's name for it; others see nothing.
    const mine = ok(await p.as.supplierA.get(`/api/v1/supplier/inspections/${fai['inspectionId']}`), 200, 'supplier view');
    expect(mine['supplierDisplayName']).toBe('');
    expect((await p.as.supplierB.get(`/api/v1/supplier/inspections/${fai['inspectionId']}`)).status).toBe(404);
    expect((await p.as.buyer.get(`/api/v1/supplier/inspections/${fai['inspectionId']}`)).status).toBe(403);
  });

  it('takes every sample against every characteristic at once, judging units, bounds and instruments as they arrive', async () => {
    fai = ok(await p.as.supplierA.post(`/api/v1/supplier/inspections/${fai['inspectionId']}/start`, { expectedVersion: fai['aggregateVersion'] }), 201, 'start');
    const base = { expectedVersion: fai['aggregateVersion'], inspectedAt: new Date().toISOString(), samples: [{ sampleNo: 1, serial: 'S-001' }] };
    const result = (name: string, value: string, unit: string | null, precision: number | null, tool: string | null) => ({
      sampleNo: 1,
      characteristicId: byName(fai, name)['characteristicId'],
      measurement: { value, unit, declaredPrecision: precision },
      instrumentId: tool ? tools[tool] : null,
    });
    const full = [
      result('Visual: free of burrs and sharp edges', 'conforming', null, null, null),
      // A transcription error: 32 µm for 3.2 µm.
      result('Surface roughness Ra', '32', 'um', 0, 'profilometer'),
      // Measured in inches: 0.4724 × 25.4 = 11.99896 mm, inside 11.98–12.02.
      result('Bore diameter', '0.4724', 'inch', 4, 'bore'),
      // Exactly on the inclusive upper limit, with a caliper past its calibration.
      result('Overall length', '80.10', 'mm', 2, 'caliper'),
    ];
    const post = (results: Body[]) => p.as.supplierA.post(`/api/v1/supplier/inspections/${fai['inspectionId']}/results`, { ...base, results });
    expect((await post(full.slice(0, 3))).body['code']).toBe('RESULTS_INCOMPLETE');
    expect((await post([...full.slice(0, 3), { ...full[3]!, instrumentId: null }])).body['code']).toBe('INSTRUMENT_REQUIRED');
    expect((await post([...full.slice(0, 3), result('Overall length', '80.101', 'mm', 2, 'caliper')])).body['code']).toBe('MEASUREMENT_PRECISION');
    // Only the inspecting organization records results.
    expect((await p.as.supplierB.post(`/api/v1/supplier/inspections/${fai['inspectionId']}/results`, { ...base, results: full })).status).toBe(404);

    fai = ok(await post(full), 201, 'submit results');
    expect(fai['status']).toBe('results_submitted');
    const r = (name: string) => current(fai).find((x) => x['characteristicId'] === byName(fai, name)['characteristicId'])!;
    expect(r('Bore diameter')).toMatchObject({ outcome: 'pass', original: { value: '0.4724', unit: 'inch', declaredPrecision: 4 }, normalized: { value: '11.99896', unit: 'mm' }, ruleVersion: 'MEAS-1', calibrationStatus: 'valid' });
    expect(r('Overall length')).toMatchObject({ outcome: 'pass', calibrationStatus: 'expired', instrument: { assetTag: 'VC-02' } });
    expect(r('Surface roughness Ra')).toMatchObject({ outcome: 'fail', normalized: { value: '0.032', unit: 'mm' } });
    expect(r('Visual: free of burrs and sharp edges')).toMatchObject({ outcome: 'pass', calibrationStatus: 'not_required', instrument: null });
    expect(fai['passBlockers']).toEqual([
      '2. Surface roughness Ra failed on sample 1, and it is mandatory.',
      '4. Overall length on sample 1 was measured with VC-02 past its calibration due date: it needs a calibration disposition.',
    ]);
  });

  it('is reviewed only by JobWork quality, who corrects with a reason and keeps the original', async () => {
    expect((await p.as.supplierA.post(`/api/v1/inspections/${fai['inspectionId']}/review`, { expectedVersion: fai['aggregateVersion'] })).status).toBe(403);
    expect((await p.as.engineering.post(`/api/v1/inspections/${fai['inspectionId']}/review`, { expectedVersion: fai['aggregateVersion'] })).status).toBe(403);
    fai = ok(await p.as.quality.post(`/api/v1/inspections/${fai['inspectionId']}/review`, { expectedVersion: fai['aggregateVersion'] }), 201, 'start review');
    // The supplier can no longer correct once review has started.
    const ra = current(fai).find((x) => x['characteristicId'] === byName(fai, 'Surface roughness Ra')['characteristicId'])!;
    expect((await p.as.supplierA.post(`/api/v1/supplier/inspections/${fai['inspectionId']}/corrections`, { expectedVersion: fai['aggregateVersion'], resultId: ra['resultId'], measurement: { value: '3.2', unit: 'um', declaredPrecision: 1 }, instrumentId: tools['profilometer'], reason: 'Typo' })).status).toBe(403);
    fai = ok(
      await p.as.quality.post(`/api/v1/inspections/${fai['inspectionId']}/corrections`, {
        expectedVersion: fai['aggregateVersion'],
        resultId: ra['resultId'],
        measurement: { value: '3.2', unit: 'um', declaredPrecision: 1 },
        instrumentId: tools['profilometer'],
        reason: 'Decimal point dropped in transcription; the tester printout reads 3.2',
      }),
      201,
      'correct Ra',
    );
    const rows = (fai['results'] as Body[]).filter((x) => x['characteristicId'] === ra['characteristicId']);
    expect(rows.map((x) => [x['original'] as Body, x['outcome'], x['supersededByResultId'] !== null])).toEqual([
      [{ value: '32', unit: 'um', declaredPrecision: 0 }, 'fail', true],
      [{ value: '3.2', unit: 'um', declaredPrecision: 1 }, 'pass', false],
    ]);
    // Correcting a result that was already corrected is refused: correct what stands now.
    expect((await p.as.quality.post(`/api/v1/inspections/${fai['inspectionId']}/corrections`, { expectedVersion: fai['aggregateVersion'], resultId: ra['resultId'], measurement: { value: '3.1', unit: 'um', declaredPrecision: 1 }, instrumentId: tools['profilometer'], reason: 'Again' })).body['code']).toBe('RESULT_NOT_CURRENT');
  });

  it('passes only once the expired caliper is dispositioned, and tells the supplier', async () => {
    const refused = await p.as.quality.post(`/api/v1/inspections/${fai['inspectionId']}/decide`, { expectedVersion: fai['aggregateVersion'], decision: 'passed' });
    expect([refused.status, refused.body['code']]).toEqual([409, 'INSPECTION_CANNOT_PASS']);
    expect(refused.body['detail']).toContain('VC-02');
    const length = current(fai).find((x) => x['characteristicId'] === byName(fai, 'Overall length')['characteristicId'])!;
    fai = ok(
      await p.as.quality.post(`/api/v1/inspections/${fai['inspectionId']}/dispositions`, { expectedVersion: fai['aggregateVersion'], resultId: length['resultId'], decision: 'accept', reason: 'Re-measured on a calibrated height gauge at JobWork: 80.09 mm' }),
      201,
      'disposition caliper',
    );
    expect(fai['passBlockers']).toEqual([]);
    fai = ok(await p.as.quality.post(`/api/v1/inspections/${fai['inspectionId']}/decide`, { expectedVersion: fai['aggregateVersion'], decision: 'passed' }), 201, 'pass');
    expect(fai['status']).toBe('passed');
    await p.dispatchNotifications();
    expect((await p.notices('supplierA')).map((n) => n.template_key)).toContain('supplier.inspection_decided');
    expect(await p.auditActions(fai['inspectionId'] as string)).toEqual([
      'quality.inspection_planned',
      'quality.inspection_started',
      'quality.results_submitted',
      'quality.review_started',
      'quality.result_corrected',
      'quality.calibration_dispositioned',
      'quality.inspection_passed',
    ]);
  });

  it('cannot pass what cannot be evaluated; a failed critical dimension fails with what an NCR needs', async () => {
    let second = ok(await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'fai', note: 'Second setup' }), 201, 'plan second FAI');
    second = ok(await p.as.supplierA.post(`/api/v1/supplier/inspections/${second['inspectionId']}/start`, { expectedVersion: second['aggregateVersion'] }), 201, 'start');
    const id = (name: string) => byName(second, name)['characteristicId'];
    second = ok(
      await p.as.supplierA.post(`/api/v1/supplier/inspections/${second['inspectionId']}/results`, {
        expectedVersion: second['aggregateVersion'],
        inspectedAt: new Date().toISOString(),
        samples: [{ sampleNo: 1 }],
        results: [
          { sampleNo: 1, characteristicId: id('Visual: free of burrs and sharp edges'), measurement: { value: 'conforming', unit: null, declaredPrecision: null } },
          // An instrument reading in a unit nobody defined: never judged by guess.
          { sampleNo: 1, characteristicId: id('Surface roughness Ra'), measurement: { value: '125', unit: 'microinch', declaredPrecision: 0 }, instrumentId: tools['profilometer'] },
          { sampleNo: 1, characteristicId: id('Bore diameter'), measurement: { value: '12.03', unit: 'mm', declaredPrecision: 2 }, instrumentId: tools['bore'] },
          { sampleNo: 1, characteristicId: id('Overall length'), measurement: { value: '80.00', unit: 'mm', declaredPrecision: 2 }, instrumentId: tools['bore'] },
        ],
      }),
      201,
      'submit',
    );
    expect(current(second).find((r) => r['characteristicId'] === id('Surface roughness Ra'))).toMatchObject({ outcome: 'cannot_evaluate', normalized: null });
    second = ok(await p.as.quality.post(`/api/v1/inspections/${second['inspectionId']}/review`, { expectedVersion: second['aggregateVersion'] }), 201, 'review');
    const refused = await p.as.quality.post(`/api/v1/inspections/${second['inspectionId']}/decide`, { expectedVersion: second['aggregateVersion'], decision: 'passed' });
    expect(refused.body['detail']).toContain('cannot be evaluated');
    expect(refused.body['detail']).toContain('3. Bore diameter failed on sample 1');
    expect((await p.as.quality.post(`/api/v1/inspections/${second['inspectionId']}/decide`, { expectedVersion: second['aggregateVersion'], decision: 'failed' })).body['code']).toBe('REASON_REQUIRED');
    second = ok(await p.as.quality.post(`/api/v1/inspections/${second['inspectionId']}/decide`, { expectedVersion: second['aggregateVersion'], decision: 'failed', reason: 'Bore oversize at 12.03 mm' }), 201, 'fail');
    const event = await p.one<{ data: Body }>(`SELECT data FROM platform.outbox_event WHERE event_type = 'quality.inspection_failed.v1' AND aggregate_id = $1`, [second['inspectionId']]);
    expect(event.data['failures']).toEqual([{ characteristicId: id('Bore diameter'), name: 'Bore diameter', drawingReference: '7', criticality: 'critical', mandatory: true, sampleNos: [1] }]);
    // A reinspection is a new inspection that names the one it follows (BR-QLT-04).
    const again = ok(await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'fai', reinspectionOf: second['inspectionId'] }), 201, 'reinspection');
    expect(again['reinspectionOf']).toBe(second['inspectionId']);
    expect((await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'fai', reinspectionOf: fai['inspectionId'] })).body['code']).toBe('REINSPECTION_INVALID');
  });

  it('keeps JobWork’s own inspection independent: the one who measured never decides', async () => {
    const jobworkTool = ok(await p.as.quality.post('/api/v1/instruments', { assetTag: 'JW-CMM-1', kind: 'Coordinate measuring machine', unit: 'mm' }), 201, 'JobWork instrument');
    ok(
      await p.as.quality.post(`/api/v1/instruments/${jobworkTool['instrumentId']}/calibrations`, { performedAt: daysAgo(5), dueAt: daysAgo(-360), outcome: 'pass', certificateDocumentVersionId: await p.cleanDrawing(p.orgs.internal) }),
      201,
      'calibrate CMM',
    );
    const plan = ok(await p.as.quality.get(`/api/v1/quality-plans/${prod.qualityPlanId}`), 200, 'plan');
    // The launch template has no JobWork incoming stage: the plan is revised to add one.
    const draft = ok(await p.as.quality.post(`/api/v1/quality-plans/${prod.qualityPlanId}/revise`, { expectedVersion: plan['aggregateVersion'] }), 201, 'revise');
    const characteristics = (draft['characteristics'] as Body[]).map((c) => (c['name'] === 'Bore diameter' ? { ...c, stages: ['fai', 'final', 'jobwork_incoming'] } : c));
    const saved = ok(await p.as.quality.post(`/api/v1/quality-plans/${draft['planId']}/draft`, { expectedVersion: draft['aggregateVersion'], stages: [...(draft['stages'] as Body[]), { stage: 'jobwork_incoming', sampleSize: 2 }], characteristics }), 201, 'save');
    ok(await p.as.quality.post(`/api/v1/quality-plans/${draft['planId']}/approve`, { expectedVersion: saved['aggregateVersion'] }), 201, 'approve v2');
    expect((ok(await p.as.quality.get(`/api/v1/quality-plans?workPackageId=${prod.workPackageId}`), 200, 'plans') as unknown as Body[]).map((x) => [x['versionNo'], x['status']])).toEqual([
      [2, 'approved'],
      [1, 'superseded'],
    ]);
    // The first inspection still names plan v1 and its results are as recorded.
    expect(ok(await p.as.quality.get(`/api/v1/inspections/${fai['inspectionId']}`), 200, 'old FAI')).toMatchObject({ planVersionNo: 1, status: 'passed' });

    let incoming = ok(await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'jobwork_incoming' }), 201, 'plan incoming');
    incoming = ok(await p.as.quality.post(`/api/v1/inspections/${incoming['inspectionId']}/start`, { expectedVersion: incoming['aggregateVersion'] }), 201, 'start incoming');
    // The supplier is not the inspector here, and cannot see it.
    expect((await p.as.supplierA.get(`/api/v1/supplier/inspections/${incoming['inspectionId']}`)).status).toBe(404);
    const bore = byName(incoming, 'Bore diameter')['characteristicId'];
    incoming = ok(
      await p.as.quality.post(`/api/v1/inspections/${incoming['inspectionId']}/results`, {
        expectedVersion: incoming['aggregateVersion'],
        inspectedAt: new Date().toISOString(),
        samples: [{ sampleNo: 1 }, { sampleNo: 2 }],
        results: [1, 2].map((n) => ({ sampleNo: n, characteristicId: bore, measurement: { value: '12.000', unit: 'mm', declaredPrecision: 3 }, instrumentId: jobworkTool['instrumentId'] })),
      }),
      201,
      'JobWork measures',
    );
    expect((await p.as.quality.post(`/api/v1/inspections/${incoming['inspectionId']}/review`, { expectedVersion: incoming['aggregateVersion'] })).body['code']).toBe('REVIEWER_NOT_INDEPENDENT');
    incoming = ok(await p.as.quality2.post(`/api/v1/inspections/${incoming['inspectionId']}/review`, { expectedVersion: incoming['aggregateVersion'] }), 201, 'independent review');
    incoming = ok(await p.as.quality2.post(`/api/v1/inspections/${incoming['inspectionId']}/decide`, { expectedVersion: incoming['aggregateVersion'], decision: 'passed' }), 201, 'pass incoming');
    expect(incoming['status']).toBe('passed');
  });

  it('refuses every shortcut through the inspection states', async () => {
    let i = ok(await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'final' }), 201, 'plan final');
    expect(i['sampleSize']).toBe(5);
    expect((await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/decide`, { expectedVersion: i['aggregateVersion'], decision: 'passed' })).body['code']).toBe('INSPECTION_STATUS');
    expect((await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/review`, { expectedVersion: i['aggregateVersion'] })).body['code']).toBe('INSPECTION_STATUS');
    i = ok(await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/start`, { expectedVersion: i['aggregateVersion'] }), 201, 'start');
    expect((await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/start`, { expectedVersion: i['aggregateVersion'] })).body['code']).toBe('INSPECTION_STATUS');
    expect((await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/start`, { expectedVersion: 1 })).body['code']).toBe('VERSION_CONFLICT');
    i = ok(await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/invalidate`, { expectedVersion: i['aggregateVersion'], reason: 'Wrong lot staged for the final' }), 201, 'invalidate');
    expect(i['status']).toBe('invalidated');
    expect((await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/invalidate`, { expectedVersion: i['aggregateVersion'], reason: 'Again' })).body['code']).toBe('INSPECTION_STATUS');
  });
});
