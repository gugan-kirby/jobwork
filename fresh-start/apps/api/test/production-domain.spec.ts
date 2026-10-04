import { describe, expect, it } from 'vitest';
import {
  baselineHash,
  computeReleaseGates,
  defaultMilestones,
  governingConflicts,
  type GateInput,
  type ManifestItem,
} from '../src/modules/orders/domain/production';

/** IN-09 pure rules (F-09.2/F-09.3). */
describe('baseline hash, governing conflicts and the release gate matrix', () => {
  const items: ManifestItem[] = [
    { documentId: 'b', documentVersionId: 'b1', fileSha256: 'bb', purpose: 'reference', governingPriority: 1, logicalType: 'specification' },
    { documentId: 'a', documentVersionId: 'a2', fileSha256: 'aa', purpose: 'governing', governingPriority: 1, logicalType: 'drawing_2d' },
  ];

  it('hashes the manifest independently of the order it was assembled in', () => {
    expect(baselineHash(items)).toBe(baselineHash([...items].reverse()));
    expect(baselineHash(items)).toMatch(/^[0-9a-f]{64}$/);
    // Any change to an exact version or its bytes changes the hash.
    expect(baselineHash([{ ...items[0]!, fileSha256: 'bc' }, items[1]!])).not.toBe(baselineHash(items));
    expect(baselineHash([items[0]!, { ...items[1]!, purpose: 'reference' }])).not.toBe(baselineHash(items));
  });

  it('blocks two governing documents of one kind at one priority, and a manifest with nothing governing', () => {
    expect(governingConflicts(items)).toEqual([]);
    const clash = [...items, { documentId: 'c', documentVersionId: 'c1', fileSha256: 'cc', purpose: 'governing' as const, governingPriority: 1, logicalType: 'drawing_2d', title: 'Old drawing' }];
    expect(governingConflicts(clash)).toHaveLength(1);
    expect(governingConflicts([{ ...clash[2]!, governingPriority: 2 }, ...items])).toEqual([]);
    expect(governingConflicts([items[0]!])[0]).toMatch(/No governing document/);
  });

  const green: GateInput = {
    order: { status: 'pending_technical_release', commercialReleasedAt: '2026-10-04T00:00:00Z' },
    activeHolds: [],
    baseline: { baselineId: 'b', number: 'BL-2026-0001', manifestHash: 'h' },
    transmittal: { transmittalId: 't', number: 'TR-2026-0001', status: 'acknowledged', manifestHash: 'h', acknowledgedAt: '2026-10-04T00:00:00Z' },
    purchaseOrder: { number: 'PO-2026-0001', status: 'acknowledged', contentHash: 'p' },
    plan: { plannedStart: '2026-10-05', plannedFinish: '2026-10-25', milestoneCount: 5 },
    supplier: { profileStatus: 'active', acceptingWork: true },
    qualityPlanPresent: true,
  };

  it('is all green only when every input is', () => {
    expect(computeReleaseGates(green).every((g) => g.pass)).toBe(true);
  });

  // Every single-gate-red combination blocks release (F-09.3 combinatorial).
  const breakers: Array<[string, Partial<GateInput>, string]> = [
    ['commercial: not released', { order: { status: 'pending_commercial_release', commercialReleasedAt: null } }, 'commercial'],
    ['commercial: hold', { activeHolds: [{ reason: 'Cheque bounced' }] }, 'commercial'],
    ['technical: no baseline', { baseline: null }, 'technical'],
    ['technical: no transmittal', { transmittal: null }, 'technical'],
    ['technical: unacknowledged', { transmittal: { ...green.transmittal!, status: 'issued', acknowledgedAt: null } }, 'technical'],
    ['technical: stale transmittal', { transmittal: { ...green.transmittal!, manifestHash: 'old' } }, 'technical'],
    ['technical: PO not acknowledged', { purchaseOrder: { ...green.purchaseOrder, status: 'issued' } }, 'technical'],
    ['planning: no dates', { plan: { plannedStart: null, plannedFinish: null, milestoneCount: 5 } }, 'planning'],
    ['planning: no milestones', { plan: { ...green.plan, milestoneCount: 0 } }, 'planning'],
    ['compliance: supplier paused', { supplier: { profileStatus: 'paused', acceptingWork: true } }, 'compliance'],
    ['compliance: not accepting work', { supplier: { profileStatus: 'active', acceptingWork: false } }, 'compliance'],
    ['compliance: no quality plan', { qualityPlanPresent: false }, 'compliance'],
  ];
  it.each(breakers)('blocks on %s', (_name, change, key) => {
    const gates = computeReleaseGates({ ...green, ...change });
    const red = gates.filter((g) => !g.pass);
    expect(red.map((g) => g.key)).toEqual([key]);
    expect(red[0]!.reasons.length).toBeGreaterThan(0);
  });

  it('spreads the default checkpoints between start and finish and shows the customer four of five', () => {
    const plan = defaultMilestones('2026-10-05', '2026-10-25');
    expect(plan).toHaveLength(5);
    expect(plan[0]!.plannedDate >= '2026-10-05').toBe(true);
    expect(plan[4]!.plannedDate).toBe('2026-10-25');
    expect(plan.filter((m) => m.customerLabel).length).toBe(4);
    for (let i = 1; i < plan.length; i += 1) expect(plan[i]!.plannedDate >= plan[i - 1]!.plannedDate).toBe(true);
  });
});
