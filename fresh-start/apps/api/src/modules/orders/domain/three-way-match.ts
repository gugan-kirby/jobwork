import type { BillMatch } from '@jobwork/contracts';

/**
 * The three-way match (IN-18 F-18.1; FR-805; BR-FIN-07; doc 10 §5): what the purchase order
 * committed, what JobWork accepted into stock, and what the supplier billed. A bill passes when it
 * asks for no more pieces than were accepted and not yet billed, and for no more money than those
 * pieces are worth at the PO's price, within a small tolerance. Anything else is an exception a
 * second finance member decides — never a silent adjustment (doc 19 §7).
 */

export interface MatchInput {
  purchaseOrder: { number: string; quantity: number; totalMinor: number };
  acceptedQuantity: number;
  billedBefore: { quantity: number; taxableMinor: number };
  bill: { quantity: number; taxableMinor: number };
  /** Basis points of the billable value, capped in minor units (policy v1: 1 %, ₹500). */
  tolerance: { basisPoints: number; capMinor: number };
}

const money = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (n: number): string => String(Math.round(n * 10_000) / 10_000);

export function threeWayMatch(m: MatchInput): BillMatch {
  const unitPrice = m.purchaseOrder.quantity > 0 ? m.purchaseOrder.totalMinor / m.purchaseOrder.quantity : 0;
  const receiptValue = Math.round(m.acceptedQuantity * unitPrice);
  const billableQuantity = m.acceptedQuantity - m.billedBefore.quantity;
  const billableValue = Math.min(receiptValue, m.purchaseOrder.totalMinor) - m.billedBefore.taxableMinor;
  const tolerance = Math.min(Math.round((Math.max(billableValue, 0) * m.tolerance.basisPoints) / 10_000), m.tolerance.capMinor);
  const reasons: string[] = [];
  if (m.acceptedQuantity <= 0) reasons.push('Nothing from this purchase order has been accepted at JobWork yet.');
  if (m.bill.quantity > billableQuantity + 1e-9) {
    reasons.push(`${qty(m.bill.quantity)} billed against ${qty(Math.max(billableQuantity, 0))} accepted and not yet billed.`);
  }
  if (m.bill.taxableMinor > billableValue + tolerance) {
    reasons.push(`${money(m.bill.taxableMinor)} billed against ${money(Math.max(billableValue, 0))} owed at the PO price (tolerance ${money(tolerance)}).`);
  }
  return {
    purchaseOrder: { number: m.purchaseOrder.number, quantity: qty(m.purchaseOrder.quantity), totalMinor: m.purchaseOrder.totalMinor, unitPriceMinor: Math.round(unitPrice * 100) / 100 },
    receipt: { acceptedQuantity: qty(m.acceptedQuantity), valueMinor: receiptValue },
    bill: { quantity: qty(m.bill.quantity), taxableMinor: m.bill.taxableMinor },
    billedBeforeQuantity: qty(m.billedBefore.quantity),
    toleranceMinor: tolerance,
    pass: reasons.length === 0,
    reasons,
  };
}

/** Doc 10 §5: what must hold before a supplier is paid. Each fact is read, never assumed. */
export interface EligibilityFacts {
  billStatus: string;
  purchaseOrderStatus: string;
  workReleased: boolean;
  qualityReleased: boolean;
  openNcrs: string[];
  supplierActive: boolean;
  bankVerified: boolean;
  holdingCases: string[];
}

export function settlementEligibility(f: EligibilityFacts): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!['matched', 'exception_approved'].includes(f.billStatus)) reasons.push('The bill is not matched.');
  if (f.purchaseOrderStatus !== 'acknowledged') reasons.push(`The purchase order is ${f.purchaseOrderStatus}.`);
  if (!f.workReleased) reasons.push('The work package was never released to production.');
  if (!f.qualityReleased) reasons.push('Nothing is quality released on this purchase order.');
  for (const n of f.openNcrs) reasons.push(`${n} is open on the work package.`);
  if (!f.supplierActive) reasons.push('The supplier is not active in the network.');
  if (!f.bankVerified) reasons.push('The supplier’s bank account is not verified.');
  for (const c of f.holdingCases) reasons.push(`${c} holds this supplier’s settlement (dispute or recovery).`);
  return { pass: reasons.length === 0, reasons };
}
