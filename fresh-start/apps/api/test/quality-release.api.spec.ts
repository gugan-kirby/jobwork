import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, snapshotHash } from '../src/modules/quality/domain/release-checklist';
import { type Body, ok, Pilot, type SourcedDeal } from './pilot/driver';

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * Quality release over HTTP (IN-15 F-15.4; doc 09 §14; FR-706; BR-QLT-03). The checklist is
 * computed, never ticked; a release needs every item green, freezes the checklist with a hash
 * anyone can recompute, and a defect found afterwards holds its lot without rewriting it.
 */
describe('Quality release (F-15.4)', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let prod: { workPackageId: string; milestoneId: string };
  let gauge: string;
  let release: Body;

  const characteristic = (i: Body, name: string): string => ((i['characteristics'] as Body[]).find((c) => c['name'] === name)!['characteristicId']) as string;
  const scope = (quantity: string, lots: string[] = ['LOT-A']) => ({ workPackageId: prod.workPackageId, quantity, lots, serials: [] as string[] });
  const red = (c: Body): string[] => (c['items'] as Body[]).filter((i) => !i['pass']).map((i) => i['key'] as string);

  async function inspect(stage: 'fai' | 'final', bore: string, lot: string): Promise<Body> {
    let i = ok(await p.as.quality.post('/api/v1/inspections', { workPackageId: prod.workPackageId, stage, lot }), 201, `plan ${stage}`);
    i = ok(await p.as.supplierA.post(`/api/v1/supplier/inspections/${i['inspectionId']}/start`, { expectedVersion: i['aggregateVersion'] }), 201, 'start');
    const samples = Array.from({ length: i['sampleSize'] as number }, (_, k) => k + 1);
    const names = (i['characteristics'] as Body[]).map((c) => c['name'] as string);
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
        results: samples.flatMap((n) => names.map((name) => ({ sampleNo: n, characteristicId: characteristic(i, name), ...value(name) }))),
      }),
      201,
      'submit',
    );
    i = ok(await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/review`, { expectedVersion: i['aggregateVersion'] }), 201, 'review');
    const pass = Number(bore) <= 12.02;
    return ok(await p.as.quality.post(`/api/v1/inspections/${i['inspectionId']}/decide`, { expectedVersion: i['aggregateVersion'], decision: pass ? 'passed' : 'failed', reason: pass ? '' : 'Bore oversize' }), 201, 'decide');
  }

  beforeAll(async () => {
    p = await Pilot.start('release');
    const { enquiryId } = await p.approvedEnquiry();
    deal = await p.sourceToPurchaseOrder(enquiryId);
    prod = await p.intoProduction(deal);
    const made = ok(await p.as.supplierA.post('/api/v1/supplier/instruments', { assetTag: 'BG-01', kind: 'Bore gauge', unit: 'mm' }), 201, 'instrument');
    ok(await p.as.supplierA.post(`/api/v1/supplier/instruments/${made['instrumentId']}/calibrations`, { performedAt: daysAgo(10), dueAt: daysAgo(-300), outcome: 'pass', certificateDocumentVersionId: await p.cleanDrawing(p.orgs.supplierA) }), 201, 'calibrate');
    gauge = made['instrumentId'] as string;
  }, 240_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('computes every doc 09 §14 item and refuses while any is red', async () => {
    const checklist = ok(await p.as.quality.post('/api/v1/quality-releases/checklist', scope('5')), 201, 'checklist');
    expect((checklist['items'] as Body[]).map((i) => i['key'])).toEqual(['baseline', 'milestones', 'certificates', 'inspections', 'calibrations', 'ncrs', 'quantity', 'packaging', 'releaser']);
    expect(red(checklist)).toEqual(['milestones', 'inspections', 'packaging']);
    expect((checklist['items'] as Body[]).find((i) => i['key'] === 'inspections')!['reasons']).toEqual(['No fai inspection yet.', 'No final inspection yet.']);
    const refused = await p.as.quality.post('/api/v1/quality-releases', scope('5'));
    expect([refused.status, refused.body['code']]).toEqual([409, 'RELEASE_BLOCKED']);
    // BR-QLT-03: the supplier never releases; engineering may read the checklist but is not a releaser.
    expect((await p.as.supplierA.post('/api/v1/quality-releases', scope('5'))).status).toBe(403);
    expect(red(ok(await p.as.engineering.post('/api/v1/quality-releases/checklist', scope('5')), 201, 'engineering view'))).toContain('releaser');
  });

  it('releases a stated quantity and lot once every item is green, frozen with a reproducible hash', async () => {
    await inspect('fai', '12.004', 'LOT-A');
    await inspect('final', '12.006', 'LOT-A');
    // Each verification or waiver moves the next milestone, so read them afresh every time.
    for (;;) {
      const wp = ((await p.productionView(deal.orderId))['workPackages'] as Body[]).find((w) => w['workPackageId'] === prod.workPackageId)!;
      const m = (wp['milestones'] as Body[]).find((x) => x['status'] !== 'verified' && x['status'] !== 'waived');
      if (!m) break;
      if (m['status'] === 'evidence_submitted') ok(await p.as.quality.post(`/api/v1/milestones/${m['milestoneId']}/verify`, { expectedVersion: m['aggregateVersion'], decision: 'verified' }), 201, 'verify');
      else ok(await p.as.quality.post(`/api/v1/milestones/${m['milestoneId']}/waive`, { expectedVersion: m['aggregateVersion'], reason: 'Covered by the final inspection on record.' }), 201, 'waive');
    }
    const facts = ok(await p.as.quality.get(`/api/v1/work-packages/${prod.workPackageId}/release-facts`), 200, 'facts');
    const ordered = facts['orderedQuantity'] as string;
    expect(red(ok(await p.as.quality.post('/api/v1/quality-releases/checklist', scope(String(Number(ordered) + 1))), 201, 'too many'))).toEqual(['quantity']);

    release = ok(await p.as.quality.post('/api/v1/quality-releases', scope('5')), 201, 'authorize');
    expect(release).toMatchObject({ number: expect.stringMatching(/^QR-\d{4}-0001$/), quantity: '5.0000', lots: ['LOT-A'] });
    // Anyone can recompute the hash from the stored snapshot.
    expect(snapshotHash(release['snapshot'])).toBe(release['snapshotSha256']);
    expect(canonicalJson(release['snapshot'])).toContain('"items"');
    expect(((release['snapshot'] as Body)['items'] as Body[]).every((i) => i['pass'])).toBe(true);
    const after = ok(await p.as.quality.get(`/api/v1/work-packages/${prod.workPackageId}/release-facts`), 200, 'facts after');
    expect(after).toMatchObject({ releasedQuantity: '5', openNcrs: [], ncrsSinceLastRelease: [] });
  });

  it('holds a lot a later defect touches, without rewriting the release', async () => {
    const failed = await inspect('final', '12.031', 'LOT-B');
    const bore = (failed['results'] as Body[]).find((r) => r['characteristicId'] === characteristic(failed, 'Bore diameter') && r['outcome'] === 'fail')!;
    ok(await p.as.quality.post('/api/v1/ncrs', { inspectionId: failed['inspectionId'], resultIds: [bore['resultId']], title: 'LOT-B bore oversize', description: 'Found at final inspection', severity: 'major', affectedQuantity: '5', lots: ['LOT-B'] }), 201, 'NCR');
    const facts = ok(await p.as.quality.get(`/api/v1/work-packages/${prod.workPackageId}/release-facts`), 200, 'facts');
    expect(facts['openNcrs']).toEqual([expect.objectContaining({ lots: ['LOT-B'] })]);
    expect((facts['ncrsSinceLastRelease'] as Body[]).length).toBe(1);
    expect(facts['releases']).toEqual([expect.objectContaining({ number: release['number'], snapshotSha256: release['snapshotSha256'] })]);
    const blocked = ok(await p.as.quality.post('/api/v1/quality-releases/checklist', scope('5', ['LOT-B'])), 201, 'LOT-B');
    expect(red(blocked)).toEqual(expect.arrayContaining(['inspections', 'ncrs', 'quantity']));
    expect((blocked['items'] as Body[]).find((i) => i['key'] === 'quantity')!['reasons']).toContain('Held under an NCR: LOT-B.');
    // The release itself is untouched.
    const stored = ok(await p.as.quality.get(`/api/v1/quality-releases?workPackageId=${prod.workPackageId}`), 200, 'history') as unknown as Body[];
    expect(stored).toHaveLength(1);
    expect(snapshotHash(stored[0]!['snapshot'])).toBe(release['snapshotSha256']);
  });
});
