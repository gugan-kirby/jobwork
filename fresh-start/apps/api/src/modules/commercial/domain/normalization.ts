import { createHash } from 'node:crypto';
import type {
  EvaluationComponents,
  EvaluationLine,
  EvaluationRow,
  EvaluationScenario,
} from '@jobwork/contracts';
import { allocateByWeights, allocateEqually, applyBasisPoints, exclusiveOf, lineAmount } from './money';

/**
 * Bid normalization (`FR-402`, doc 07 §4). Source bids are never altered; each one gets a
 * normalized landed-cost row built from the scenario:
 *
 *   normalized = item cost (ex tax)
 *              + NRE allocated by the declared policy
 *              + freight (as quoted, or one estimate for all)
 *              + inspection/packaging allowance
 *              + financing/risk adjustment
 *              + non-recoverable tax
 *
 * Every figure is integer minor units and every allocation conserves them, so the same
 * inputs and configuration produce the same rows and the same hash — which is what makes
 * a comparison defensible six months later.
 */

export const NORMALIZATION_CONFIG_VERSION = 'normalization-v1';

export interface BidForNormalization {
  bidVersionId: string;
  supplierOrganizationId: string;
  supplierDisplayName: string;
  versionNo: number;
  taxTreatment: string;
  nreAmountMinor: number;
  freightAmountMinor: number;
  totalAmountMinor: number;
  leadTimeDays: number;
  validityUntil: string;
  feasibility: string;
  late: boolean;
  receivedAt: Date;
  lines: ReadonlyArray<{
    rfqItemId: string;
    lineNo: number;
    quantity: number;
    unit: string;
    unitPriceMinor: number;
    setupAmountMinor: number;
  }>;
}

export function scenarioHash(scenario: EvaluationScenario): string {
  const canonical = {
    configVersion: NORMALIZATION_CONFIG_VERSION,
    freightPolicy: scenario.freightPolicy,
    freightEstimateMinor: scenario.freightEstimateMinor,
    nreAllocation: scenario.nreAllocation,
    inspectionPackagingMinor: scenario.inspectionPackagingMinor,
    financingRiskBp: scenario.financingRiskBp,
    gstRateBp: scenario.gstRateBp,
    taxAssumption: scenario.taxAssumption,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** NRE spread across lines by policy; `direct` leaves it as its own component, unallocated. */
export function allocateNre(
  nreMinor: number,
  lines: ReadonlyArray<{ quantity: number; originalLineMinor: number }>,
  policy: EvaluationScenario['nreAllocation'],
): number[] {
  if (lines.length === 0) return [];
  switch (policy) {
    case 'quantity':
      return allocateByWeights(nreMinor, lines.map((l) => Math.round(l.quantity * 10_000)));
    case 'value':
      return allocateByWeights(nreMinor, lines.map((l) => l.originalLineMinor));
    case 'equal':
      return allocateEqually(nreMinor, lines.length);
    case 'direct':
      return lines.map(() => 0);
  }
}

export function normalizeBid(
  bid: BidForNormalization,
  scenario: EvaluationScenario,
): { components: EvaluationComponents; lines: EvaluationLine[]; normalizedLandedMinor: number } {
  const originalLines = bid.lines.map((line) => ({
    ...line,
    originalLineMinor: lineAmount(line.unitPriceMinor, line.quantity) + line.setupAmountMinor,
  }));
  const itemCostMinor = originalLines.reduce((sum, l) => sum + l.originalLineMinor, 0);

  // Compare ex-tax: an inclusive bid has GST inside its prices, an extra bid does not.
  const itemCostExTaxMinor =
    bid.taxTreatment === 'gst_inclusive' ? exclusiveOf(itemCostMinor, scenario.gstRateBp) : itemCostMinor;
  const exTaxFactor = itemCostMinor === 0 ? 1 : itemCostExTaxMinor / itemCostMinor;

  const nreAllocated = allocateNre(bid.nreAmountMinor, originalLines, scenario.nreAllocation);
  const nreMinor = bid.nreAmountMinor;
  const freightMinor =
    scenario.freightPolicy === 'estimate' ? scenario.freightEstimateMinor : bid.freightAmountMinor;
  const inspectionPackagingMinor = scenario.inspectionPackagingMinor;
  const financingRiskMinor = applyBasisPoints(itemCostExTaxMinor, scenario.financingRiskBp);
  const nonRecoverableTaxMinor =
    scenario.taxAssumption === 'non_recoverable' && bid.taxTreatment !== 'exempt'
      ? applyBasisPoints(itemCostExTaxMinor, scenario.gstRateBp)
      : 0;

  const lines: EvaluationLine[] = originalLines.map((line, index) => {
    const exTax = Math.round(line.originalLineMinor * exTaxFactor);
    return {
      rfqItemId: line.rfqItemId,
      lineNo: line.lineNo,
      quantity: line.quantity,
      unit: line.unit,
      originalLineMinor: line.originalLineMinor,
      nreAllocatedMinor: nreAllocated[index] ?? 0,
      normalizedLineMinor: exTax + (nreAllocated[index] ?? 0),
    };
  });

  const components: EvaluationComponents = {
    itemCostMinor,
    itemCostExTaxMinor,
    nreMinor,
    freightMinor,
    inspectionPackagingMinor,
    financingRiskMinor,
    nonRecoverableTaxMinor,
  };
  const normalizedLandedMinor =
    itemCostExTaxMinor + nreMinor + freightMinor + inspectionPackagingMinor + financingRiskMinor + nonRecoverableTaxMinor;
  return { components, lines, normalizedLandedMinor };
}

/**
 * The whole comparison: every live bid normalized, ranked by landed cost (ties: shorter
 * lead time, then earlier receipt), flagged for the things a reviewer must not miss.
 */
export function evaluateBids(
  bids: readonly BidForNormalization[],
  scenario: EvaluationScenario,
  now: Date,
): EvaluationRow[] {
  const rows = bids.map((bid) => {
    const { components, lines, normalizedLandedMinor } = normalizeBid(bid, scenario);
    const flags: EvaluationRow['flags'] = [];
    if (bid.late) flags.push('late');
    const daysLeft = Math.floor((new Date(`${bid.validityUntil}T23:59:59Z`).getTime() - now.getTime()) / 86_400_000);
    if (daysLeft <= 7) flags.push('expiring_validity');
    if (bid.feasibility === 'feasible_with_deviation') flags.push('deviation');
    if (bid.feasibility === 'not_feasible') flags.push('not_feasible');
    if (bids.length === 1) flags.push('single_source');
    return {
      bidVersionId: bid.bidVersionId,
      supplierOrganizationId: bid.supplierOrganizationId,
      supplierDisplayName: bid.supplierDisplayName,
      versionNo: bid.versionNo,
      originalTotalMinor: bid.totalAmountMinor,
      normalizedLandedMinor,
      components,
      lines,
      leadTimeDays: bid.leadTimeDays,
      validityUntil: bid.validityUntil,
      feasibility: bid.feasibility,
      rank: 0,
      flags,
      receivedAt: bid.receivedAt,
    };
  });

  rows.sort(
    (a, b) =>
      a.normalizedLandedMinor - b.normalizedLandedMinor ||
      a.leadTimeDays - b.leadTimeDays ||
      a.receivedAt.getTime() - b.receivedAt.getTime(),
  );
  return rows.map(({ receivedAt: _received, ...row }, index) => ({ ...row, rank: index + 1 }));
}
