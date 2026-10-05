import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './pilot/driver';

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * NCRs over HTTP (IN-15 F-15.2; doc 06 §10; doc 09 §§11, 13; FR-703, FR-705; BR-QLT-04, BR-QLT-06).
 * A first article fails on an oversize critical bore. JobWork quality opens an NCR; the supplier
 * contains the lot; a rework is approved, recorded and judged by a new inspection that fails
 * again, so a second attempt follows and passes. The supplier's corrective action must name real
 * causes; someone other than the disposition decider closes it, and not while a branched NCR is
 * open.
 */
describe('NCR, rework and corrective action (F-15.2)', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let prod: { workPackageId: string; qualityPlanId: string };
  let gauge: string;
  let failedFai: Body;
  let ncr: Body;

  const characteristic = (i: Body, name: string): string => ((i['characteristics'] as Body[]).find((c) => c['name'] === name)!['characteristicId']) as string;

  /** Plan (or take) an inspection, have the supplier measure it with `bore`, and decide it. */
  async function measured(inspection: Body | null, bore: string, decision: 'passed' | 'failed'): Promise<Body> {
    let i = inspection ?? ok(await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'fai' }), 201, 'plan FAI');
    i = ok(await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/start`, { expectedVersion: i['aggregateVersion'] }), 201, 'start');
    i = ok(
      await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/results`, {
        expectedVersion: i['aggregateVersion'],
        inspectedAt: new Date().toISOString(),
        samples: [{ sampleNo: 1, serial: 'FA-001' }],
        results: [
          { sampleNo: 1, characteristicId: characteristic(i, 'Visual: free of burrs and sharp edges'), measurement: { value: 'conforming', unit: null, declaredPrecision: null } },
          { sampleNo: 1, characteristicId: characteristic(i, 'Surface roughness Ra'), measurement: { value: '1.6', unit: 'um', declaredPrecision: 1 }, instrumentId: gauge },
          { sampleNo: 1, characteristicId: characteristic(i, 'Bore diameter'), measurement: { value: bore, unit: 'mm', declaredPrecision: 3 }, instrumentId: gauge },
          { sampleNo: 1, characteristicId: characteristic(i, 'Overall length'), measurement: { value: '80.00', unit: 'mm', declaredPrecision: 2 }, instrumentId: gauge },
        ],
      }),
      201,
      'submit',
    );
    i = ok(await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/review`, { expectedVersion: i['aggregateVersion'] }), 201, 'review');
    return ok(await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/decide`, { expectedVersion: i['aggregateVersion'], decision, reason: decision === 'failed' ? `Bore ${bore} mm out of tolerance` : '' }), 201, 'decide');
  }

  const failedBore = (i: Body): Body => (i['results'] as Body[]).find((r) => r['characteristicId'] === characteristic(i, 'Bore diameter') && r['supersededByResultId'] === null)!;
  const reload = async (): Promise<Body> => ok(await p.as.quality.get(`/api/v1/ncrs/${ncr['ncrId']}`), 200, 'ncr');

  beforeAll(async () => {
    p = await Pilot.start('ncr');
    const { enquiryId } = await p.approvedEnquiry();
    deal = await p.sourceToPurchaseOrder(enquiryId);
    prod = await p.intoProduction(deal);
    const made = ok(await p.as.supplierA.post('/api/v1/supplier/instruments', { assetTag: 'BG-01', kind: 'Bore gauge', unit: 'mm' }), 201, 'instrument');
    ok(await p.as.supplierA.post(`/api/v1/supplier/instruments/${made['instrumentId']}/calibrations`, { performedAt: daysAgo(10), dueAt: daysAgo(-300), outcome: 'pass', certificateDocumentVersionId: await p.cleanDrawing(p.orgs.supplierA) }), 201, 'calibrate');
    gauge = made['instrumentId'] as string;
    failedFai = await measured(null, '12.030', 'failed');
  }, 240_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('opens on the failed results of a failed inspection only, and tells the supplier', async () => {
    const passed = await measured(null, '12.000', 'passed');
    expect((await p.as.quality.post('/api/v1/ncrs', { inspectionId: passed['inspectionId'], resultIds: [failedBore(passed)['resultId']], title: 'Bore oversize', description: 'Bore out of tolerance', severity: 'critical', affectedQuantity: '5' })).body['code']).toBe('INSPECTION_NOT_FAILED');
    const visual = (failedFai['results'] as Body[]).find((r) => r['characteristicId'] === characteristic(failedFai, 'Visual: free of burrs and sharp edges'))!;
    expect((await p.as.quality.post('/api/v1/ncrs', { inspectionId: failedFai['inspectionId'], resultIds: [visual['resultId']], title: 'Bore oversize', description: 'Bore out of tolerance', severity: 'critical', affectedQuantity: '5' })).body['code']).toBe('RESULT_NOT_FAILED');
    expect((await p.as.engineering.post('/api/v1/ncrs', { inspectionId: failedFai['inspectionId'], resultIds: [failedBore(failedFai)['resultId']], title: 'Bore oversize', description: 'Bore out of tolerance', severity: 'critical', affectedQuantity: '5' })).status).toBe(403);

    ncr = ok(
      await p.as.quality.post('/api/v1/ncrs', {
        inspectionId: failedFai['inspectionId'],
        resultIds: [failedBore(failedFai)['resultId']],
        title: 'Bore oversize on first article',
        description: 'Bore measured 12.030 mm against 11.98–12.02 mm',
        severity: 'critical',
        affectedQuantity: '20',
        lots: ['LOT-A'],
        costResponsibility: 'supplier',
      }),
      201,
      'open NCR',
    );
    expect(ncr).toMatchObject({ status: 'open', severity: 'critical', affectedQuantity: '20.0000', lots: ['LOT-A'], attemptNo: 0, correctiveAction: { status: 'requested' } });
    expect((ncr['defects'] as Body[])[0]).toMatchObject({ characteristicName: 'Bore diameter', original: { value: '12.030', unit: 'mm' }, outcome: 'fail' });
    await p.dispatchNotifications();
    expect((await p.notices('supplierA')).map((n) => n.template_key)).toContain('supplier.ncr_opened');
    expect((await p.notices('supplierB')).map((n) => n.template_key)).not.toContain('supplier.ncr_opened');
  });

  it('is contained by the supplier and seen only by it', async () => {
    const mine = ok(await p.as.supplierA.post(`/api/v1/supplier/ncrs/${ncr['ncrId']}/containment`, { action: 'LOT-A tagged red, moved to the hold rack', location: 'Hold rack 2', quantity: '20' }), 201, 'contain');
    expect(mine).toMatchObject({ status: 'containment', supplierDisplayName: '' });
    expect((mine['containment'] as Body[])[0]).toMatchObject({ by: 'supplier', location: 'Hold rack 2' });
    expect((await p.as.supplierB.get(`/api/v1/supplier/ncrs/${ncr['ncrId']}`)).status).toBe(404);
    expect((await p.as.buyer.get(`/api/v1/supplier/ncrs/${ncr['ncrId']}`)).status).toBe(403);
    expect((await p.as.supplierA.post(`/api/v1/ncrs/${ncr['ncrId']}/to-disposition`, { expectedVersion: mine['aggregateVersion'] })).status).toBe(403);
    ncr = ok(await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/to-disposition`, { expectedVersion: mine['aggregateVersion'] }), 201, 'to disposition');
    expect(ncr['status']).toBe('disposition_pending');
  });

  it('judges a rework only by a new inspection; a second failure is a second attempt, the first kept', async () => {
    ncr = ok(await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/approve-rework`, { expectedVersion: ncr['aggregateVersion'], disposition: 'rework', plan: 'Re-bore LOT-A to 12.000 on the VMC with a new boring bar' }), 201, 'approve rework');
    expect(ncr).toMatchObject({ status: 'rework', attemptNo: 1 });
    expect((await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/reinspection`, { expectedVersion: ncr['aggregateVersion'] })).body['code']).toBe('REWORK_NOT_RECORDED');
    // The rework record is the supplier's; JobWork cannot record it for them.
    expect((await p.as.quality.post(`/api/v1/supplier/ncrs/${ncr['ncrId']}/rework`, { expectedVersion: ncr['aggregateVersion'], note: 'done' })).status).toBe(404);
    ncr = ok(await p.as.supplierA.post(`/api/v1/supplier/ncrs/${ncr['ncrId']}/rework`, { expectedVersion: ncr['aggregateVersion'], note: 'LOT-A re-bored on 5 Oct' }), 201, 'record rework');
    ncr = ok(await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/reinspection`, { expectedVersion: ncr['aggregateVersion'] }), 201, 'plan reinspection');
    const first = (ncr['dispositions'] as Body[])[0]!;
    const reinspection1 = ok(await p.as.quality.get(`/api/v1/inspections/${(first['reinspection'] as Body)['inspectionId']}`), 200, 'reinspection 1');
    expect(reinspection1).toMatchObject({ reinspectionOf: failedFai['inspectionId'], stage: 'fai', status: 'planned' });

    // Still oversize: the NCR returns to a disposition, attempt 1 recorded as still nonconforming.
    await measured(reinspection1, '12.025', 'failed');
    ncr = await reload();
    expect(ncr).toMatchObject({ status: 'disposition_pending', attemptNo: 1 });
    expect((ncr['dispositions'] as Body[])[0]).toMatchObject({ outcome: 'still_nonconforming' });

    ncr = ok(await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/approve-rework`, { expectedVersion: ncr['aggregateVersion'], disposition: 'rework', plan: 'Hone LOT-A bores to 12.005' }), 201, 'approve rework 2');
    ncr = ok(await p.as.supplierA.post(`/api/v1/supplier/ncrs/${ncr['ncrId']}/rework`, { expectedVersion: ncr['aggregateVersion'], note: 'Honed' }), 201, 'record rework 2');
    ncr = ok(await p.as.quality.post(`/api/v1/ncrs/${ncr['ncrId']}/reinspection`, { expectedVersion: ncr['aggregateVersion'] }), 201, 'plan reinspection 2');
    const reinspection2 = ok(await p.as.quality.get(`/api/v1/inspections/${((ncr['dispositions'] as Body[])[1]!['reinspection'] as Body)['inspectionId']}`), 200, 'reinspection 2');
    expect(reinspection2['reinspectionOf']).toBe(reinspection1['inspectionId']);
    await measured(reinspection2, '12.004', 'passed');
    ncr = await reload();
    expect(ncr).toMatchObject({ status: 'verified', attemptNo: 2 });
    expect((ncr['dispositions'] as Body[]).map((d) => [d['attemptNo'], d['outcome']])).toEqual([
      [1, 'still_nonconforming'],
      [2, 'verified'],
    ]);
    // The original failed result is untouched.
    expect(failedBore(ok(await p.as.quality.get(`/api/v1/inspections/${failedFai['inspectionId']}`), 200, 'original'))['outcome']).toBe('fail');
  });

  it('asks for real causes in the corrective action, accepted and verified by JobWork', async () => {
    const ca = () => ncr['correctiveAction'] as Body;
    const thin = await p.as.supplierA.post(`/api/v1/supplier/ncrs/${ncr['ncrId']}/corrective-action`, {
      expectedVersion: ca()['aggregateVersion'],
      problemDefinition: 'Bore oversize',
      occurrenceCause: 'Operator mistake',
      escapeCause: 'Operator mistake',
      actions: [{ action: 'Retrain operator', owner: 'Supervisor', dueDate: '2026-10-20' }],
    });
    expect([thin.status, thin.body['code']]).toEqual([422, 'CA_CAUSE_TOO_THIN']);
    ncr = ok(
      await p.as.supplierA.post(`/api/v1/supplier/ncrs/${ncr['ncrId']}/corrective-action`, {
        expectedVersion: ca()['aggregateVersion'],
        problemDefinition: 'LOT-A bores 0.01 mm oversize after 60 parts',
        occurrenceCause: 'Boring bar insert past its wear limit; no tool-life counter on the VMC',
        escapeCause: 'Bore gauged only at first-off, not at insert change',
        actions: [
          { action: 'Tool-life counter set to 40 parts', owner: 'Setter', dueDate: '2026-10-10' },
          { action: 'Gauge every tenth bore', owner: 'Quality', dueDate: '2026-10-10' },
        ],
      }),
      201,
      'respond CA',
    );
    expect((await p.as.supplierA.post(`/api/v1/ncrs/${ncr['ncrId']}/corrective-action/review`, { expectedVersion: ca()['aggregateVersion'], decision: 'accept' })).status).toBe(403);
    ncr = ok(await p.as.quality2.post(`/api/v1/ncrs/${ncr['ncrId']}/corrective-action/review`, { expectedVersion: ca()['aggregateVersion'], decision: 'accept', note: 'Causes are evidenced' }), 201, 'accept CA');
    ncr = ok(await p.as.quality2.post(`/api/v1/ncrs/${ncr['ncrId']}/corrective-action/verify`, { expectedVersion: ca()['aggregateVersion'], evidence: 'Next two first articles at 12.002 and 12.004 mm' }), 201, 'verify CA');
    expect(ca()['status']).toBe('verified');
  });

  it('branches a new defect into a child NCR, and closes neither circularly nor by its decider', async () => {
    // While reworking, the supplier found burrs on two parts: a new, minor NCR under the first.
    const failed = await measured(null, '12.030', 'failed');
    const child = ok(
      await p.as.quality.post('/api/v1/ncrs', { inspectionId: failed['inspectionId'], resultIds: [failedBore(failed)['resultId']], title: 'Second setup oversize', description: 'Found during rework', severity: 'minor', affectedQuantity: '2', parentNcrId: ncr['ncrId'] }),
      201,
      'branch',
    );
    expect(child).toMatchObject({ parent: { ncrId: ncr['ncrId'] }, correctiveAction: null });
    ncr = await reload();
    expect(ncr['children']).toEqual([expect.objectContaining({ ncrId: child['ncrId'], status: 'open' })]);

    // The decider of the disposition cannot close; nobody can while the child is open.
    expect(ncr['closeBlockers']).toEqual(['You decided its disposition; another member of JobWork quality verifies and closes it.', `Branched NCRs are still open: ${child['number']}.`]);
    expect((await p.as.quality2.post(`/api/v1/ncrs/${ncr['ncrId']}/close`, { expectedVersion: ncr['aggregateVersion'], note: 'Reworked and verified' })).body['code']).toBe('NCR_CANNOT_CLOSE');

    let c = ok(await p.as.quality2.post(`/api/v1/ncrs/${child['ncrId']}/containment`, { action: 'Two parts set aside' }), 201, 'contain child');
    c = ok(await p.as.quality2.post(`/api/v1/ncrs/${child['ncrId']}/to-disposition`, { expectedVersion: c['aggregateVersion'] }), 201, 'child disposition');
    c = ok(await p.as.quality2.post(`/api/v1/ncrs/${child['ncrId']}/reject`, { expectedVersion: c['aggregateVersion'], disposition: 'scrap', costResponsibility: 'supplier', reason: 'Two parts, not worth reworking' }), 201, 'scrap child');
    expect((await p.as.quality2.post(`/api/v1/ncrs/${child['ncrId']}/close`, { expectedVersion: c['aggregateVersion'], note: 'Scrapped' })).body['code']).toBe('NCR_CANNOT_CLOSE');
    ok(await p.as.quality.post(`/api/v1/ncrs/${child['ncrId']}/close`, { expectedVersion: c['aggregateVersion'], note: 'Two parts scrapped at the supplier' }), 201, 'close child');

    ncr = await reload();
    const closed = ok(await p.as.quality2.post(`/api/v1/ncrs/${ncr['ncrId']}/close`, { expectedVersion: ncr['aggregateVersion'], note: 'Reworked lot passed reinspection; corrective action effective' }), 201, 'close');
    expect(closed['status']).toBe('closed');
    expect(await p.auditActions(ncr['ncrId'] as string)).toEqual([
      'quality.ncr_opened',
      'quality.ncr_contained',
      'quality.ncr_disposition_pending',
      'quality.rework_approved',
      'quality.rework_recorded',
      'quality.reinspection_planned',
      'quality.ncr_still_nonconforming',
      'quality.rework_approved',
      'quality.rework_recorded',
      'quality.reinspection_planned',
      'quality.ncr_verified',
      'quality.corrective_action_responded',
      'quality.corrective_action_accepted',
      'quality.corrective_action_verified',
      'quality.ncr_closed',
    ]);
    // Nothing of it reaches the customer.
    p.expectNothingOf(ok(await p.as.buyer.get(`/api/v1/orders/${deal.orderId}`), 200, 'order'), ['NCR-', 'oversize', 'rework'], 'customer order view');
  });
});
