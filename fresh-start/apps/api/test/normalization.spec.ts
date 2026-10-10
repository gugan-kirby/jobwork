import { describe, expect, it } from 'vitest';
import {
  allocateByWeights,
  allocateEqually,
  applyBasisPoints,
  exclusiveOf,
  lineAmount,
  marginBpOf,
  roundDiv,
  sellForMargin,
} from '../src/modules/commercial/domain/money';
import {
  allocateNre,
  evaluateBids,
  normalizeBid,
  scenarioHash,
  type BidForNormalization,
} from '../src/modules/commercial/domain/normalization';
import { computeCostSheet } from '../src/modules/commercial/domain/cost-sheet';
import { computeQuoteTotals, diffQuoteVersions, hashQuoteContent } from '../src/modules/commercial/domain/quote';
import { evaluationScenarioSchema } from '@jobwork/contracts';

/**
 * Doc 13 §9 property checks for the commercial arithmetic (F-07.2): allocation conserves
 * every minor unit, the same inputs always produce the same rows and hash, and originals
 * are untouched by normalization.
 */

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('integer money (BR-FIN-01, doc 10 §3)', () => {
  it('rounds half away from zero and never produces a fraction', () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(-5, 2)).toBe(-3);
    expect(roundDiv(7, 3)).toBe(2);
    expect(applyBasisPoints(100_000, 1800)).toBe(18_000);
    expect(applyBasisPoints(1, 1800)).toBe(0);
    expect(lineAmount(4850, 100)).toBe(485_000);
    expect(lineAmount(333, 3.3333)).toBe(1110);
    expect(exclusiveOf(118_000, 1800)).toBe(100_000);
  });

  it('allocates by largest remainder and conserves the total for any weights', () => {
    const random = seeded(7);
    for (let trial = 0; trial < 500; trial += 1) {
      const parts = 1 + Math.floor(random() * 9);
      const weights = Array.from({ length: parts }, () => Math.floor(random() * 1000));
      const total = Math.floor(random() * 1_000_000);
      const out = allocateByWeights(total, weights);
      expect(out).toHaveLength(parts);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
      expect(out.every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
      expect(allocateEqually(total, parts).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('round-trips margin on sell within one minor unit', () => {
    // Below a few minor units a margin cannot be expressed at all; realistic figures only.
    for (const landed of [999, 100_000, 57_230_017]) {
      for (const bp of [0, 500, 1000, 2500, 4000]) {
        const sell = sellForMargin(landed, bp);
        // One minor unit of rounding on the sell price is `10000 / sell` basis points.
        expect(Math.abs(marginBpOf(sell, landed) - bp)).toBeLessThanOrEqual(Math.ceil(10_000 / sell) + 1);
      }
    }
    expect(marginBpOf(100, 120)).toBe(-2000);
  });
});

const scenario = evaluationScenarioSchema.parse({});

function bid(overrides: Partial<BidForNormalization> = {}): BidForNormalization {
  return {
    bidVersionId: '11111111-1111-4111-8111-111111111111',
    supplierOrganizationId: '22222222-2222-4222-8222-222222222222',
    supplierDisplayName: 'A',
    versionNo: 1,
    taxTreatment: 'gst_extra',
    nreAmountMinor: 100_000,
    freightAmountMinor: 25_000,
    totalAmountMinor: 0,
    leadTimeDays: 21,
    validityUntil: '2099-01-01',
    feasibility: 'feasible',
    late: false,
    receivedAt: new Date('2026-10-01T00:00:00Z'),
    lines: [
      { rfqItemId: 'a', lineNo: 1, quantity: 100, unit: 'piece', unitPriceMinor: 4850, setupAmountMinor: 50_000 },
      { rfqItemId: 'b', lineNo: 2, quantity: 30, unit: 'piece', unitPriceMinor: 12_000, setupAmountMinor: 0 },
      { rfqItemId: 'c', lineNo: 3, quantity: 7, unit: 'piece', unitPriceMinor: 999, setupAmountMinor: 0 },
    ],
    ...overrides,
  };
}

describe('bid normalization (FR-402, doc 07 §4)', () => {
  it('allocates NRE by every policy without losing a minor unit', () => {
    const lines = bid().lines.map((l) => ({ quantity: l.quantity, originalLineMinor: lineAmount(l.unitPriceMinor, l.quantity) + l.setupAmountMinor }));
    for (const policy of ['quantity', 'value', 'equal'] as const) {
      const out = allocateNre(123_457, lines, policy);
      expect(out.reduce((a, b) => a + b, 0)).toBe(123_457);
    }
    expect(allocateNre(123_457, lines, 'direct')).toEqual([0, 0, 0]);
  });

  it('builds the landed cost from the stated components and leaves the original alone', () => {
    const b = bid({ totalAmountMinor: 1_000_000 });
    const { components, lines, normalizedLandedMinor } = normalizeBid(b, scenario);
    expect(components.itemCostMinor).toBe(485_000 + 50_000 + 360_000 + 6_993);
    expect(components.itemCostExTaxMinor).toBe(components.itemCostMinor);
    expect(components.nreMinor).toBe(100_000);
    expect(components.freightMinor).toBe(25_000);
    expect(normalizedLandedMinor).toBe(components.itemCostMinor + 100_000 + 25_000);
    expect(lines.reduce((s, l) => s + l.nreAllocatedMinor, 0)).toBe(100_000);
    // The original figure is reported, not recomputed.
    expect(b.totalAmountMinor).toBe(1_000_000);
  });

  it('compares an inclusive bid ex-tax and adds non-recoverable tax only when told to', () => {
    const inclusive = normalizeBid(bid({ taxTreatment: 'gst_inclusive' }), scenario);
    expect(inclusive.components.itemCostExTaxMinor).toBe(exclusiveOf(inclusive.components.itemCostMinor, 1800));
    const nonRecoverable = normalizeBid(bid(), { ...scenario, taxAssumption: 'non_recoverable' });
    expect(nonRecoverable.components.nonRecoverableTaxMinor).toBe(applyBasisPoints(nonRecoverable.components.itemCostExTaxMinor, 1800));
    const exempt = normalizeBid(bid({ taxTreatment: 'exempt' }), { ...scenario, taxAssumption: 'non_recoverable' });
    expect(exempt.components.nonRecoverableTaxMinor).toBe(0);
  });

  it('ranks deterministically and flags what a reviewer must not miss', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const cheap = bid({ bidVersionId: 'c', supplierDisplayName: 'Cheap', lines: [{ rfqItemId: 'a', lineNo: 1, quantity: 100, unit: 'piece', unitPriceMinor: 4000, setupAmountMinor: 0 }], nreAmountMinor: 0, freightAmountMinor: 0 });
    const dear = bid({ bidVersionId: 'd', supplierDisplayName: 'Dear', late: true, validityUntil: '2026-10-05', feasibility: 'feasible_with_deviation' });
    const first = evaluateBids([dear, cheap], scenario, now);
    const second = evaluateBids([cheap, dear], scenario, now);
    expect(first.map((r) => r.bidVersionId)).toEqual(['c', 'd']);
    expect(first).toEqual(second);
    expect(first[1]!.flags).toEqual(expect.arrayContaining(['late', 'expiring_validity', 'deviation']));
    expect(first[0]!.flags).not.toContain('single_source');
    expect(evaluateBids([cheap], scenario, now)[0]!.flags).toContain('single_source');
    expect(scenarioHash(scenario)).toBe(scenarioHash({ ...scenario }));
    expect(scenarioHash(scenario)).not.toBe(scenarioHash({ ...scenario, gstRateBp: 1200 }));
  });
});

describe('cost sheet arithmetic (FR-404, BR-COM-10)', () => {
  it('conserves the sell total across lines and reproduces its hash from inputs', () => {
    const input = {
      currency: 'INR',
      awardLines: [
        { rfqItemId: 'a', lineNo: 1, description: 'Bracket', quantity: 60, unit: 'piece', lineTotalMinor: 300_000 },
        { rfqItemId: 'a', lineNo: 1, description: 'Bracket', quantity: 40, unit: 'piece', lineTotalMinor: 210_000 },
        { rfqItemId: 'b', lineNo: 2, description: 'Collar', quantity: 30, unit: 'piece', lineTotalMinor: 360_001 },
      ],
      components: [{ code: 'freight_outbound' as const, label: 'Freight to customer', amountMinor: 12_345, basis: 'estimate' }],
      pricing: { targetMarginBp: 1500 },
      note: 'first pass',
    };
    const a = computeCostSheet(input);
    const b = computeCostSheet(input);
    expect(a).toEqual(b);
    expect(a.buyTotalMinor).toBe(870_001);
    expect(a.landedTotalMinor).toBe(882_346);
    expect(a.sellLines.reduce((s, l) => s + l.amountMinor, 0)).toBe(a.sellTotalMinor);
    expect(a.sellLines).toHaveLength(2);
    expect(a.sellLines[0]!.quantity).toBe(100);
    expect(Math.abs(a.marginBp - 1500)).toBeLessThanOrEqual(1);
    expect(computeCostSheet({ ...input, pricing: { targetMarginBp: -500 } }).marginMinor).toBeLessThan(0);
  });

  it('takes JobWork’s customer price per line exactly and lets the margin follow (FR-409)', () => {
    const awardLines = [
      { rfqItemId: 'a', lineNo: 1, description: 'Bracket', quantity: 100, unit: 'piece', lineTotalMinor: 1_100_000 },
      { rfqItemId: 'b', lineNo: 2, description: 'Collar', quantity: 30, unit: 'piece', lineTotalMinor: 360_000 },
    ];
    const base = { currency: 'INR', awardLines, components: [], note: '' };
    const priced = computeCostSheet({ ...base, pricing: { unitSellByLine: new Map([[1, 14_000], [2, 15_000]]) } });
    expect(priced.sellLines.map((l) => [l.lineNo, l.unitSellMinor, l.amountMinor])).toEqual([
      [1, 14_000, 1_400_000],
      [2, 15_000, 450_000],
    ]);
    expect(priced).toMatchObject({ sellTotalMinor: 1_850_000, landedTotalMinor: 1_460_000, marginMinor: 390_000 });
    expect(priced.marginBp).toBe(Math.round((390_000 * 10_000) / 1_850_000));
    // Below cost is allowed to compute and shows a negative margin; the approval rail blocks it.
    expect(computeCostSheet({ ...base, pricing: { unitSellByLine: new Map([[1, 10_000], [2, 12_000]]) } }).marginMinor).toBeLessThan(0);
    expect(() => computeCostSheet({ ...base, pricing: { unitSellByLine: new Map([[1, 14_000]]) } })).toThrow(/prices were given for/);
    expect(() => computeCostSheet({ ...base, pricing: { unitSellByLine: new Map([[1, 14_000], [3, 1]]) } })).toThrow(/prices were given for/);
  });
});

describe('quote totals and diff (FR-406)', () => {
  it('computes tax on subtotal plus freight and hashes canonically', () => {
    const content = {
      lines: [
        { lineNo: 2, description: 'Collar', quantity: 30, unit: 'piece', unitPriceMinor: 15_000 },
        { lineNo: 1, description: 'Bracket', quantity: 100, unit: 'piece', unitPriceMinor: 4850 },
      ],
      taxRateBp: 1800,
      freightMinor: 10_000,
      deliveryLeadDays: 7,
      paymentTerms: '50% advance',
      advanceBp: 5000,
      balanceTrigger: 'before_dispatch' as const,
      validityUntil: '2026-10-31',
      assumptions: '',
      exclusions: '',
      scopeNote: '',
    };
    const totals = computeQuoteTotals(content);
    expect(totals.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(totals.subtotalMinor).toBe(485_000 + 450_000);
    expect(totals.taxMinor).toBe(applyBasisPoints(935_000 + 10_000, 1800));
    expect(totals.totalMinor).toBe(935_000 + 10_000 + totals.taxMinor);
    const h1 = hashQuoteContent({ currency: 'INR', content, totals, termsVersionId: 't' });
    const h2 = hashQuoteContent({ currency: 'INR', content: { ...content, assumptions: ' ' }, totals, termsVersionId: 't' });
    expect(h1).toBe(h2);
    expect(hashQuoteContent({ currency: 'INR', content, totals, termsVersionId: 'u' })).not.toBe(h1);

    const next = computeQuoteTotals({ ...content, lines: [content.lines[1]!, { ...content.lines[0]!, unitPriceMinor: 14_000 }], deliveryLeadDays: 10 });
    const changes = diffQuoteVersions({ ...content, totalMinor: totals.totalMinor, lines: totals.lines }, { ...content, deliveryLeadDays: 10, totalMinor: next.totalMinor, lines: next.lines });
    expect(changes.map((c) => c.field)).toEqual(['Total', 'Delivery (days)', 'Line 2 price']);
  });
});
