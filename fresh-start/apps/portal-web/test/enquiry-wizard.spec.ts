import { describe, expect, it } from 'vitest';
import { INITIAL, emptyItem, extensionOf, stageIssues, toPayload, type DraftState } from '../app/enquiries/new/wizard/types';

/** VF-17: what each wizard stage asks before Next, and what a save carries. */
describe('enquiry wizard rules', () => {
  const filled: DraftState = {
    ...INITIAL,
    title: 'Bracket Support',
    deliverySiteId: 'site',
    items: [
      {
        ...emptyItem(1),
        processCapabilityId: 'process',
        materialCapabilityId: 'material',
        quantityBreakpoints: [{ quantity: 100, unit: 'piece', kind: 'production' }],
      },
    ],
  };

  it('holds step 1 back on each empty field', () => {
    expect(stageIssues(0, INITIAL).map((issue) => issue.path)).toEqual([
      'title',
      'items[1].processCapabilityId',
      'items[1].materialCapabilityId',
      'items[1].quantityBreakpoints',
      'deliverySiteId',
    ]);
    expect(stageIssues(0, filled)).toEqual([]);
  });

  it('holds step 2 back until a file is attached', () => {
    expect(stageIssues(1, filled).map((issue) => issue.path)).toEqual(['documents']);
    const attached = { ...filled, documents: [{ documentVersionId: 'v', role: 'reference' as const, note: '' }] };
    expect(stageIssues(1, attached)).toEqual([]);
  });

  it('saves as job work with JobWork sourcing the material, and never sends an empty quantity', () => {
    const payload = toPayload(INITIAL, null) as { jobType: string; materialSupply: string; items: Array<{ quantityBreakpoints: unknown[] }> };
    expect(payload.jobType).toBe('job_work');
    expect(payload.materialSupply).toBe('to_be_sourced');
    expect(payload.items[0]!.quantityBreakpoints).toEqual([]);
  });

  it('reads a file type from its name', () => {
    expect(extensionOf('Bracket Drawing.pdf')).toBe('PDF');
    expect(extensionOf('drawing')).toBe('FILE');
  });
});
