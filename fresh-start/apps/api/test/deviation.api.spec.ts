import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './pilot/driver';

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString();

/**
 * Deviations over HTTP (IN-15 F-15.3; doc 09 §12; FR-704; BR-QLT-02; doc 03 §4; doc 19 §6).
 * A deviation is authoritative only through the approval rail and, where the customer must
 * decide, its approver's recorded decision. Its scope stays inside the NCR's; it expires; and
 * the failed results it covers stay failed, shown as accepted under deviation.
 */
describe('Deviation (F-15.3)', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let prod: { workPackageId: string };
  let gauge: string;
  let boreFai: Body;
  let raFai: Body;
  let boreNcr: Body;
  let raNcr: Body;

  const characteristic = (i: Body, name: string): string => ((i['characteristics'] as Body[]).find((c) => c['name'] === name)!['characteristicId']) as string;
  const result = (i: Body, name: string): Body => (i['results'] as Body[]).find((r) => r['characteristicId'] === characteristic(i, name) && r['supersededByResultId'] === null)!;

  async function failedFai(values: { ra: string; bore: string }): Promise<Body> {
    let i = ok(await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage: 'fai' }), 201, 'plan FAI');
    i = ok(await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/start`, { expectedVersion: i['aggregateVersion'] }), 201, 'start');
    i = ok(
      await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/results`, {
        expectedVersion: i['aggregateVersion'],
        inspectedAt: new Date().toISOString(),
        samples: [{ sampleNo: 1, lot: 'LOT-A' }],
        results: [
          { sampleNo: 1, characteristicId: characteristic(i, 'Visual: free of burrs and sharp edges'), measurement: { value: 'conforming', unit: null, declaredPrecision: null } },
          { sampleNo: 1, characteristicId: characteristic(i, 'Surface roughness Ra'), measurement: { value: values.ra, unit: 'um', declaredPrecision: 1 }, instrumentId: gauge },
          { sampleNo: 1, characteristicId: characteristic(i, 'Bore diameter'), measurement: { value: values.bore, unit: 'mm', declaredPrecision: 3 }, instrumentId: gauge },
          { sampleNo: 1, characteristicId: characteristic(i, 'Overall length'), measurement: { value: '80.00', unit: 'mm', declaredPrecision: 2 }, instrumentId: gauge },
        ],
      }),
      201,
      'submit',
    );
    i = ok(await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/review`, { expectedVersion: i['aggregateVersion'] }), 201, 'review');
    return ok(await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/decide`, { expectedVersion: i['aggregateVersion'], decision: 'failed', reason: 'Out of tolerance' }), 201, 'fail');
  }

  async function ncrReadyForDisposition(inspection: Body, name: string, severity: string, quantity: string): Promise<Body> {
    let n = ok(
      await p.as.quality.post('/api/v1/ncrs', { inspectionId: inspection['inspectionId'], resultIds: [result(inspection, name)['resultId']], title: `${name} out of tolerance`, description: 'Found at first article', severity, affectedQuantity: quantity, lots: ['LOT-A'] }),
      201,
      'open',
    );
    n = ok(await p.as.quality.post(`/api/v1/ncrs/${n['ncrId']}/containment`, { action: 'LOT-A held' }), 201, 'contain');
    return ok(await p.as.quality.post(`/api/v1/ncrs/${n['ncrId']}/to-disposition`, { expectedVersion: n['aggregateVersion'] }), 201, 'to disposition');
  }

  const request = (n: Body, overrides: Body = {}) =>
    p.as.quality.post(`/api/v1/ncrs/${n['ncrId']}/deviations`, {
      expectedVersion: n['aggregateVersion'],
      characteristicIds: [(n['defects'] as Body[])[0]!['characteristicId']],
      quantity: '20',
      lots: ['LOT-A'],
      expiresAt: inDays(60),
      rationale: 'Bore at 12.030 still gives a running fit with the mating shaft',
      riskAssessment: 'Low: clearance 0.02 mm larger than drawn',
      fitFunctionSafety: 'Fit checked on the customer gauge; no safety function',
      ...overrides,
    });
  const ncr = async (n: Body): Promise<Body> => ok(await p.as.quality.get(`/api/v1/ncrs/${n['ncrId']}`), 200, 'ncr');

  beforeAll(async () => {
    p = await Pilot.start('deviation');
    const { enquiryId } = await p.approvedEnquiry();
    deal = await p.sourceToPurchaseOrder(enquiryId);
    prod = await p.intoProduction(deal);
    const made = ok(await p.as.supplierA.post('/api/v1/supplier/instruments', { assetTag: 'BG-01', kind: 'Bore gauge', unit: 'mm' }), 201, 'instrument');
    ok(await p.as.supplierA.post(`/api/v1/supplier/instruments/${made['instrumentId']}/calibrations`, { performedAt: daysAgo(10), dueAt: daysAgo(-300), outcome: 'pass', certificateDocumentVersionId: await p.cleanDrawing(p.orgs.supplierA) }), 201, 'calibrate');
    gauge = made['instrumentId'] as string;
    boreFai = await failedFai({ ra: '1.6', bore: '12.030' });
    raFai = await failedFai({ ra: '4.0', bore: '12.000' });
    boreNcr = await ncrReadyForDisposition(boreFai, 'Bore diameter', 'critical', '20');
    raNcr = await ncrReadyForDisposition(raFai, 'Surface roughness Ra', 'minor', '20');
  }, 240_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('keeps a deviation inside the NCR’s scope and period', async () => {
    const other = characteristic(boreFai, 'Overall length');
    expect((await request(boreNcr, { characteristicIds: [other] })).body['code']).toBe('DEVIATION_SCOPE');
    expect((await request(boreNcr, { quantity: '21' })).body['code']).toBe('DEVIATION_SCOPE');
    expect((await request(boreNcr, { lots: ['LOT-B'] })).body['code']).toBe('DEVIATION_SCOPE');
    expect((await request(boreNcr, { expiresAt: inDays(200) })).body['code']).toBe('DEVIATION_EXPIRY');
    expect((await p.as.engineering.post(`/api/v1/ncrs/${boreNcr['ncrId']}/deviations`, {})).status).toBeGreaterThanOrEqual(400);
  });

  it('has no informal path: only the approval rail and the customer’s recorded decision make it count', async () => {
    let first = ok(await request(boreNcr, { quantity: '12' }), 201, 'request');
    expect(first).toMatchObject({ status: 'pending_internal', customerApprovalRequired: true, active: false });
    boreNcr = await ncr(boreNcr);
    expect(boreNcr['status']).toBe('deviation_pending');
    // A "verbal" yes is no state at all: nothing but these commands moves it.
    expect((await p.as.quality2.post(`/api/v1/ncrs/${boreNcr['ncrId']}/close`, { expectedVersion: boreNcr['aggregateVersion'], note: 'Customer said OK on the phone' })).body['code']).toBe('NCR_TRANSITION_REFUSED');
    // Withdrawn before anyone decides: the NCR returns to a disposition, the attempt kept.
    first = ok(await p.as.quality.post(`/api/v1/deviations/${first['deviationId']}/withdraw`, { expectedVersion: first['aggregateVersion'], reason: 'Quantity was wrong' }), 201, 'withdraw');
    expect(first['status']).toBe('withdrawn');
    boreNcr = await ncr(boreNcr);
    expect(boreNcr).toMatchObject({ status: 'disposition_pending', attemptNo: 1 });

    const dv = ok(await request(boreNcr), 201, 'request again');
    const approvalId = dv['approvalRequestId'] as string;
    // The requester never approves; engineering may.
    expect((await p.decide('quality', approvalId)).status).toBeGreaterThanOrEqual(403);
    ok(await p.decide('engineering', approvalId), 201, 'engineering approves');
    expect(ok(await p.as.quality.get(`/api/v1/deviations/${dv['deviationId']}`), 200, 'deviation')['status']).toBe('pending_customer');
    expect((await ncr(boreNcr))['status']).toBe('deviation_pending');
    await p.dispatchNotifications();
    expect((await p.notices('approver')).map((n) => n.template_key)).toContain('customer.deviation_decision_needed');

    // The customer sees its requirement, the actual value and the effects; nothing of the supplier.
    const list = ok(await p.as.approver.get(`/api/v1/orders/${deal.orderId}/deviations`), 200, 'customer list') as unknown as Body[];
    expect(list).toHaveLength(1);
    const view = list[0]!;
    // The lots are still at the supplier: the customer gets no lot code at all, only JobWork's markings once received (D13).
    expect(view).toMatchObject({ decisionNeeded: true, canDecide: true, quantity: '20.0000', lots: [] });
    expect((view['requirements'] as Body[])[0]).toMatchObject({ name: 'Bore diameter', drawingReference: '7', limits: '≥ 11.98 and ≤ 12.02 mm', actual: [{ sampleNo: 1, value: '12.030', unit: 'mm' }] });
    p.expectNothingOf(view, ['Anand', 'BG-01', 'supplier', 'LOT-A'], 'customer deviation view');
    // The requester may not decide for the company.
    expect((await p.as.buyer.post(`/api/v1/customer/deviations/${dv['deviationId']}/decide`, { expectedVersion: view['aggregateVersion'], decision: 'approved', acknowledgeScope: true })).status).toBe(403);
    const decided = ok(await p.as.approver.post(`/api/v1/customer/deviations/${dv['deviationId']}/decide`, { expectedVersion: view['aggregateVersion'], decision: 'approved', acknowledgeScope: true }), 201, 'customer approves');
    expect(decided).toMatchObject({ status: 'approved', decisionNeeded: false });
    expect(await ncr(boreNcr)).toMatchObject({ status: 'accepted_under_deviation', deviations: expect.arrayContaining([expect.objectContaining({ status: 'approved', active: true })]) });
    await p.dispatchNotifications();
    expect((await p.notices('supplierA')).map((n) => n.template_key)).toContain('supplier.ncr_disposition');
  });

  it('never turns the failed result into a pass: it is shown as accepted under deviation', async () => {
    const inspection = ok(await p.as.quality.get(`/api/v1/inspections/${boreFai['inspectionId']}`), 200, 'inspection');
    expect(result(inspection, 'Bore diameter')).toMatchObject({ outcome: 'fail', coveredByDeviation: { active: true } });
    expect(result(inspection, 'Overall length')['coveredByDeviation']).toBeNull();
    const row = await p.one<{ outcome: string }>(`SELECT outcome FROM quality.inspection_result WHERE id = $1`, [result(inspection, 'Bore diameter')['resultId']]);
    expect(row.outcome).toBe('fail');
  });

  it('keeps a minor deviation inside JobWork, and a rejection returns the NCR to a disposition', async () => {
    const refused = ok(await request(raNcr, { rationale: 'Ra 4.0 on a non-sealing face', riskAssessment: 'Cosmetic only', fitFunctionSafety: 'No functional face' }), 201, 'request Ra');
    expect(refused['customerApprovalRequired']).toBe(false);
    ok(await p.decide('quality2', refused['approvalRequestId'] as string, 'rejected', 'Face is visible to the end user'), 201, 'reject');
    raNcr = await ncr(raNcr);
    expect(raNcr).toMatchObject({ status: 'disposition_pending', attemptNo: 1 });
    expect((raNcr['dispositions'] as Body[])[0]).toMatchObject({ disposition: 'use_as_is', outcome: 'deviation_rejected' });

    const accepted = ok(await request(raNcr, { rationale: 'Ra 4.0 on the hidden mounting face only', riskAssessment: 'Cosmetic only', fitFunctionSafety: 'No functional face' }), 201, 'request Ra again');
    ok(await p.decide('quality2', accepted['approvalRequestId'] as string), 201, 'approve');
    raNcr = await ncr(raNcr);
    expect(raNcr).toMatchObject({ status: 'accepted_under_deviation', attemptNo: 2 });
    // The customer is not asked about a minor, effect-free deviation.
    expect(((await p.as.approver.get(`/api/v1/orders/${deal.orderId}/deviations`)).body as unknown as Body[]).map((d) => d['number'])).not.toContain(accepted['number']);
    // The internal approver decided the disposition; someone else closes.
    expect((await p.as.quality2.post(`/api/v1/ncrs/${raNcr['ncrId']}/close`, { expectedVersion: raNcr['aggregateVersion'], note: 'Accepted under deviation' })).body['code']).toBe('NCR_CANNOT_CLOSE');
    const closed = ok(await p.as.quality.post(`/api/v1/ncrs/${raNcr['ncrId']}/close`, { expectedVersion: raNcr['aggregateVersion'], note: 'LOT-A accepted under deviation; Ra face hidden' }), 201, 'close');
    expect(closed['status']).toBe('closed');
  });
});
