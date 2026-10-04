import type { BalanceTrigger, CommercialGate } from '@jobwork/contracts';
import { applyBasisPoints } from '../../commercial';

/**
 * The payment schedule (doc 10 §4) and the commercial release gate (doc 06 §7), as pure
 * arithmetic on integers. Everything that reads the database stays in the application
 * layer; this is the part a unit test can pin down to the minor unit.
 */

export interface ScheduledInstallment {
  seq: number;
  kind: 'advance' | 'balance';
  label: string;
  trigger: BalanceTrigger;
  /** Tax-inclusive amount the customer pays for this instalment. */
  amountMinor: number;
  /** Its share of the quotation's tax, so the invoice reconciles to the quotation exactly. */
  taxMinor: number;
  subtotalMinor: number;
}

export const BALANCE_TRIGGER_LABEL: Record<BalanceTrigger, string> = {
  on_acceptance: 'due on acceptance',
  before_dispatch: 'due before dispatch',
  on_delivery: 'due on delivery',
  net_30: 'due 30 days from invoice',
};

/**
 * Split the accepted total into advance and balance by the version's advance share.
 * The advance is rounded half-up once; the balance is the exact remainder, so the two
 * always sum to the quotation total and their taxes to the quotation tax (`BR-COM-10`).
 */
export function splitSchedule(input: {
  totalMinor: number;
  taxMinor: number;
  advanceBp: number;
  balanceTrigger: BalanceTrigger;
}): ScheduledInstallment[] {
  const advanceTotal = applyBasisPoints(input.totalMinor, input.advanceBp);
  const advanceTax = applyBasisPoints(input.taxMinor, input.advanceBp);
  const out: ScheduledInstallment[] = [];
  if (advanceTotal > 0) {
    out.push({
      seq: 1,
      kind: 'advance',
      label: `Advance (${(input.advanceBp / 100).toFixed(0)} %)`,
      trigger: 'on_acceptance',
      amountMinor: advanceTotal,
      taxMinor: advanceTax,
      subtotalMinor: advanceTotal - advanceTax,
    });
  }
  const balanceTotal = input.totalMinor - advanceTotal;
  if (balanceTotal > 0) {
    const balanceTax = input.taxMinor - advanceTax;
    out.push({
      seq: out.length + 1,
      kind: 'balance',
      label: out.length === 0 ? 'Full amount' : `Balance (${((10_000 - input.advanceBp) / 100).toFixed(0)} %)`,
      trigger: input.balanceTrigger,
      amountMinor: balanceTotal,
      taxMinor: balanceTax,
      subtotalMinor: balanceTotal - balanceTax,
    });
  }
  return out;
}

export interface GateInputs {
  currency: string;
  orderTotalMinor: number;
  advanceDueMinor: number;
  advancePaidMinor: number;
  /** Receivables already open for this customer, excluding this order's own invoices. */
  otherOpenReceivablesMinor: number;
  credit: { limitMinor: number; currency: string; validUntil: string | null } | null;
  activeHolds: Array<{ reason: string }>;
  today: string;
}

function money(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Commercial release (doc 06 §7, doc 10 §4): either the advance has been received, or
 * approved credit covers the exposure this order adds. A hold blocks either path. The
 * result carries its reasons, because a gate that just says "no" sends operations
 * hunting through five screens.
 */
export function evaluateGate(input: GateInputs): CommercialGate {
  const reasons: string[] = [];
  for (const hold of input.activeHolds) {
    reasons.push(`Credit hold in place: ${hold.reason}.`);
  }
  const exposure = input.otherOpenReceivablesMinor + (input.orderTotalMinor - input.advancePaidMinor);
  const creditUsable =
    input.credit !== null &&
    input.credit.currency === input.currency &&
    (input.credit.validUntil === null || input.credit.validUntil >= input.today);
  const base = {
    advanceDueMinor: input.advanceDueMinor,
    advancePaidMinor: input.advancePaidMinor,
    creditLimitMinor: input.credit?.limitMinor ?? null,
    creditExposureMinor: input.credit ? exposure : null,
    activeHolds: input.activeHolds.length,
  };
  if (input.activeHolds.length > 0) return { pass: false, basis: null, reasons, ...base };

  if (input.orderTotalMinor === 0) return { pass: true, basis: 'no_advance_due', reasons: [], ...base };
  if (input.advanceDueMinor > 0 && input.advancePaidMinor >= input.advanceDueMinor) {
    return { pass: true, basis: 'advance_paid', reasons: [], ...base };
  }
  if (creditUsable && exposure <= input.credit!.limitMinor) {
    return { pass: true, basis: 'credit_covered', reasons: [], ...base };
  }

  if (input.advanceDueMinor > 0) {
    reasons.push(
      `Advance of ${money(input.advanceDueMinor, input.currency)} not yet received (${money(input.advancePaidMinor, input.currency)} received).`,
    );
  } else {
    reasons.push('No advance is due on this order, so release depends on approved credit.');
  }
  if (input.credit === null) reasons.push('The customer has no approved credit terms.');
  else if (!creditUsable) reasons.push('The customer’s credit profile has lapsed or is in another currency.');
  else reasons.push(`Credit limit ${money(input.credit.limitMinor, input.currency)} would be exceeded (exposure ${money(exposure, input.currency)}).`);
  return { pass: false, basis: null, reasons, ...base };
}
