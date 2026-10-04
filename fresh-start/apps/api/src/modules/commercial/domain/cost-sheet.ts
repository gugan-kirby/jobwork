import { createHash } from 'node:crypto';
import type { CostComponent, CostSheetStatus, SellLine } from '@jobwork/contracts';
import { DomainError } from '../../../platform/http/domain-error';
import { allocateByWeights, lineAmount, marginBpOf, roundDiv, sellForMargin } from './money';

/**
 * The cost sheet (`FR-404`, doc 10 §2): landed cost from the award, JobWork's own
 * components, one margin, and the sell lines that fall out of it. Everything here is
 * JobWork-only and never leaves the internal API (`BR-COM-05`).
 *
 *   landed = buy total (award lines) + Σ components
 *   sell   = landed / (1 − margin)         ← margin is on sell price, in basis points
 *   lines  = sell spread over award lines by their landed share (largest remainder)
 */

const TRANSITIONS: Record<CostSheetStatus, readonly CostSheetStatus[]> = {
  draft: ['pending_approval', 'superseded'],
  pending_approval: ['approved', 'returned'],
  returned: ['pending_approval', 'superseded'],
  approved: ['superseded'],
  superseded: [],
};

export class CostSheetTransitionRejected extends DomainError {
  constructor(from: string, to: string) {
    super('COST_SHEET_TRANSITION_REJECTED', 409, 'That is not a step this cost sheet can take', `${from} -> ${to}.`);
  }
}

export class CostSheetNotFound extends DomainError {
  constructor() {
    super('COST_SHEET_NOT_FOUND', 404, 'Cost sheet not found');
  }
}

export class CostSheetNotEditable extends DomainError {
  constructor(status: string) {
    super(
      'COST_SHEET_NOT_EDITABLE',
      409,
      'This cost sheet version is frozen',
      `It is ${status}. A change now is a new version, not an edit.`,
    );
  }
}

export class CostSheetNotApproved extends DomainError {
  constructor(status: string) {
    super(
      'COST_SHEET_NOT_APPROVED',
      409,
      'A quotation needs an approved cost sheet',
      `The cost sheet version is ${status}. A negative or below-floor margin needs its exception approved first (doc 19 §4).`,
    );
  }
}

export function assertCostSheetTransition(from: CostSheetStatus, to: CostSheetStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new CostSheetTransitionRejected(from, to);
}

export interface AwardLineForCosting {
  rfqItemId: string;
  lineNo: number;
  description: string;
  quantity: number;
  unit: string;
  lineTotalMinor: number;
}

export interface CostSheetFigures {
  buyTotalMinor: number;
  landedTotalMinor: number;
  marginMinor: number;
  marginBp: number;
  sellTotalMinor: number;
  sellLines: SellLine[];
  contentHash: string;
}

/**
 * Build the figures from their inputs. Pure, so the API test can assert that the stored
 * version reproduces exactly from stored inputs (`BR-COM-10`).
 */
export function computeCostSheet(input: {
  awardLines: readonly AwardLineForCosting[];
  components: readonly CostComponent[];
  targetMarginBp: number;
  note: string;
  currency: string;
}): CostSheetFigures {
  // Several award lines may cover one RFQ item (a split): the sell line is per item.
  const byItem = new Map<string, AwardLineForCosting & { quantity: number; lineTotalMinor: number }>();
  for (const line of input.awardLines) {
    const existing = byItem.get(line.rfqItemId);
    if (existing) {
      existing.quantity += line.quantity;
      existing.lineTotalMinor += line.lineTotalMinor;
    } else {
      byItem.set(line.rfqItemId, { ...line });
    }
  }
  const items = [...byItem.values()].sort((a, b) => a.lineNo - b.lineNo);

  const buyTotalMinor = items.reduce((sum, l) => sum + l.lineTotalMinor, 0);
  const componentsTotal = input.components.reduce((sum, c) => sum + c.amountMinor, 0);
  const landedTotalMinor = buyTotalMinor + componentsTotal;
  const sellTotalMinor = sellForMargin(landedTotalMinor, input.targetMarginBp);
  const marginMinor = sellTotalMinor - landedTotalMinor;
  const marginBp = marginBpOf(sellTotalMinor, landedTotalMinor);

  // Components are spread over items by buy value, then the sell total by landed share.
  const landedShares = allocateByWeights(componentsTotal, items.map((l) => l.lineTotalMinor));
  const landedLines = items.map((l, i) => l.lineTotalMinor + (landedShares[i] ?? 0));
  const sellShares = allocateByWeights(sellTotalMinor, landedLines);

  const sellLines: SellLine[] = items.map((l, i) => {
    const amountMinor = sellShares[i] ?? 0;
    const unitSellMinor = roundDiv(amountMinor * 10_000, Math.round(l.quantity * 10_000));
    return {
      rfqItemId: l.rfqItemId,
      lineNo: l.lineNo,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      landedLineMinor: landedLines[i] ?? 0,
      unitSellMinor,
      amountMinor,
    };
  });

  const contentHash = createHash('sha256')
    .update(
      JSON.stringify({
        currency: input.currency,
        buyTotalMinor,
        components: input.components.map((c) => ({ code: c.code, label: c.label, amountMinor: c.amountMinor, basis: c.basis })),
        landedTotalMinor,
        marginMinor,
        marginBp,
        sellTotalMinor,
        sellLines,
        note: input.note.trim(),
      }),
    )
    .digest('hex');

  return { buyTotalMinor, landedTotalMinor, marginMinor, marginBp, sellTotalMinor, sellLines, contentHash };
}

/** The reproducible check: a line amount is its unit price times its quantity, rounded once. */
export function sellLineConsistent(line: SellLine): boolean {
  // Unit price is derived from the amount, so the reverse product may differ by rounding
  // of up to half a minor unit per quantity unit; the stored amount is the truth.
  return Math.abs(lineAmount(line.unitSellMinor, line.quantity) - line.amountMinor) <= Math.ceil(line.quantity);
}
