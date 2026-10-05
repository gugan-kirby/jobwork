import { createHash } from 'node:crypto';
import type { OverridableGuard, PackingCheck, ShipmentGuard } from '@jobwork/contracts';
import { Rational } from '../../quality';
import { E_WAYBILL_THRESHOLD_MINOR } from './shipment';

/**
 * Leg 2, JobWork to the customer (IN-17 F-17.2; doc 10 §12; doc 06 §11; BR-LOG-03). Eight guards,
 * each computed from authoritative facts with the reasons it is red. Four belong to another owner,
 * who may approve an override for exactly the reasons shown (doc 03 §4); the other four are
 * logistics' own preconditions, fixed rather than overridden.
 */

/** The owner who may approve an override of each overridable guard; the policy names the roles. */
export const OVERRIDABLE: readonly OverridableGuard[] = ['quality', 'payment', 'commitment', 'holds'];

export const PACKING_CHECKS: ReadonlyArray<{ key: keyof PackingCheck; label: string }> = [
  { key: 'neutralCartons', label: 'Packed in neutral or JobWork cartons' },
  { key: 'supplierMarksRemoved', label: 'Workshop tags, stickers and paperwork removed' },
  { key: 'jobworkLabelsApplied', label: 'JobWork labels applied' },
  { key: 'packagingNoteFollowed', label: 'The customer’s packaging instructions followed' },
];

/** JobWork's own lot marking for a stock lot: the supplier's lot code never reaches the customer. */
export function customerLotMarking(stockLotId: string): string {
  return `JW-${stockLotId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/** What an override is bound to: the exact reasons its owner saw. */
export function reasonsHash(reasons: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(reasons)).digest('hex');
}

export interface LegTwoItem {
  packageNo: number;
  stockLotId: string;
  marking: string;
  lotCode: string;
  quantity: string;
  workPackageId: string | null;
}

export interface LegTwoFacts {
  order: { number: string; ordered: string; partialDelivery: 'allowed' | 'not_allowed'; packagingNote: string };
  items: LegTwoItem[];
  packageNos: number[];
  /** Per stock lot of the items: whether it is this order's made-part stock, what `JW-STOCK` holds, and an open receipt. */
  lots: Map<string, { ofOrder: boolean; inStock: string; openReceipt: string | null }>;
  /** Already at `OUT-DISPATCHED` for this order, net of returns. */
  dispatchedBefore: string;
  /** Per work package: quality's release facts (IN-15). */
  quality: Map<string, { releases: Array<{ lots: string[]; quantity: string }>; openNcrs: Array<{ number: string; lots: string[] }> }>;
  /** Per work package and lot code: already at `OUT-DISPATCHED`. */
  dispatchedOfLot: Map<string, string>;
  payment: {
    currency: string;
    holds: string[];
    /** Instalments due before dispatch with something still open, or not yet invoiced. */
    unpaid: Array<{ label: string; invoiceNumber: string | null; openMinor: number }>;
    credit: { usable: boolean; limitMinor: number; exposureMinor: number } | null;
  };
  holds: { stops: Array<{ purchaseOrderNumber: string; changeNumber: string }>; openChanges: Array<{ number: string; status: string }> };
  identity: { packingCheck: PackingCheck; findings: Array<{ field: string; text: string }> };
  address: { problem: string | null; contactMissing: boolean; confirmation: 'current' | 'stale' | 'none' };
  documents: { invoiceNumber: string; invoice: { status: string } | null; eWaybillNumber: string; consignmentValueMinor: number };
}

const q = (s: string): Rational => Rational.parse(s);
const ZERO = Rational.of(0);
const show = (r: Rational): string => r.toDisplay(4);
const sum = (xs: readonly string[]): Rational => xs.reduce((t, x) => t.add(q(x)), ZERO);
const money = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const lotKey = (workPackageId: string | null, lotCode: string): string => `${workPackageId ?? ''}|${lotCode}`;

export function legTwoGuards(f: LegTwoFacts): ShipmentGuard[] {
  const guard = (key: string, label: string, reasons: string[]): ShipmentGuard => ({ key, label, pass: reasons.length === 0, reasons, overridable: (OVERRIDABLE as readonly string[]).includes(key), override: null });
  const shipping = sum(f.items.map((i) => i.quantity));
  const name = (i: LegTwoItem): string => (i.lotCode ? `${i.marking} (${i.lotCode})` : i.marking);

  // Doc 10 §12: JobWork receiving accepted and discrepancies resolved; BR-LOG-02 within what stock holds.
  const stock: string[] = [];
  if (f.items.length === 0) stock.push('No items are packed.');
  if (new Set(f.packageNos).size !== f.packageNos.length) stock.push('Package numbers repeat.');
  for (const p of f.packageNos) if (!f.items.some((i) => i.packageNo === p)) stock.push(`Package ${p} is empty.`);
  for (const stockLotId of new Set(f.items.map((i) => i.stockLotId))) {
    const first = f.items.find((i) => i.stockLotId === stockLotId)!;
    const lot = f.lots.get(stockLotId);
    if (!lot || !lot.ofOrder) {
      stock.push(`${name(first)} is not this order’s stock.`);
      continue;
    }
    const want = sum(f.items.filter((i) => i.stockLotId === stockLotId).map((i) => i.quantity));
    if (want.compare(q(lot.inStock)) > 0) stock.push(`${name(first)}: ${show(want)} to ship, ${show(q(lot.inStock))} in JobWork stock.`);
    if (lot.openReceipt) stock.push(`${name(first)}: receipt ${lot.openReceipt} still has an open discrepancy.`);
  }
  const delivered = q(f.dispatchedBefore).add(shipping);
  if (delivered.compare(q(f.order.ordered)) > 0) stock.push(`${show(delivered)} would be delivered against ${show(q(f.order.ordered))} ordered.`);

  // Doc 10 §12: independent quality release valid for the shipped quantity (IN-15 facts).
  const quality: string[] = [];
  const groups = new Map<string, LegTwoItem[]>();
  for (const i of f.items) groups.set(lotKey(i.workPackageId, i.lotCode), [...(groups.get(lotKey(i.workPackageId, i.lotCode)) ?? []), i]);
  for (const [key, items] of groups) {
    const first = items[0]!;
    const facts = first.workPackageId ? f.quality.get(first.workPackageId) : undefined;
    const covering = facts ? facts.releases.filter((r) => r.lots.length === 0 || r.lots.includes(first.lotCode)) : [];
    if (covering.length === 0) {
      quality.push(`${name(first)} is not quality released.`);
      continue;
    }
    for (const n of facts!.openNcrs) {
      if (n.lots.length === 0) quality.push(`${n.number} is open on the whole work package.`);
      else if (n.lots.includes(first.lotCode)) quality.push(`${n.number} holds ${first.lotCode}.`);
    }
    const want = sum(items.map((i) => i.quantity)).add(q(f.dispatchedOfLot.get(key) ?? '0'));
    const cap = sum(covering.map((r) => r.quantity));
    if (want.compare(cap) > 0) quality.push(`${first.lotCode}: ${show(want)} would be dispatched against ${show(cap)} quality released.`);
  }

  // Doc 10 §4: sell-side payment or credit release; a hold blocks either.
  const payment: string[] = f.payment.holds.map((h) => `Credit hold: ${h}.`);
  if (f.payment.unpaid.length > 0) {
    const credit = f.payment.credit;
    const covered = credit !== null && credit.usable && credit.exposureMinor <= credit.limitMinor;
    if (!covered) {
      for (const u of f.payment.unpaid) payment.push(u.invoiceNumber ? `${u.label} (${u.invoiceNumber}): ${money(u.openMinor)} open.` : `${u.label} is not invoiced yet.`);
      if (credit === null) payment.push('The customer has no approved credit terms.');
      else if (!credit.usable) payment.push('The customer’s credit terms have lapsed or are in another currency.');
      else payment.push(`Credit limit ${money(credit.limitMinor)} would be exceeded (exposure ${money(credit.exposureMinor)}).`);
    }
  }

  // The customer's delivery terms from the enquiry (doc 10 §14: partial shipment needs policy).
  const commitment: string[] = [];
  if (f.order.partialDelivery === 'not_allowed' && f.items.length > 0 && delivered.compare(q(f.order.ordered)) < 0) {
    const outstanding = q(f.order.ordered).sub(q(f.dispatchedBefore));
    commitment.push(`The customer asked for one complete delivery: this ships ${show(shipping)} of the ${show(outstanding)} outstanding.`);
  }

  const holds: string[] = [];
  for (const s of f.holds.stops) holds.push(`Work on ${s.purchaseOrderNumber} is stopped under ${s.changeNumber}.`);
  for (const c of f.holds.openChanges) holds.push(`${c.number} is open on this order (${c.status.replace(/_/g, ' ')}).`);

  // Doc 10 §12 "no unintended supplier identity": the packer's check and the registry's scan (R-08).
  const identity: string[] = [];
  for (const c of PACKING_CHECKS) if (!f.identity.packingCheck[c.key]) identity.push(`Confirm: ${c.label.charAt(0).toLowerCase()}${c.label.slice(1)}.`);
  for (const x of f.identity.findings) identity.push(`“${x.text}” in ${x.field} names another party.`);

  const address: string[] = [];
  if (f.address.problem) address.push(f.address.problem);
  else {
    if (f.address.contactMissing) address.push('Give the receiving contact’s name and phone on the delivery address.');
    if (f.address.confirmation === 'none') address.push('The customer has not confirmed the delivery address and receiving contact.');
    if (f.address.confirmation === 'stale') address.push('The address changed after it was confirmed: confirm it again.');
  }

  // Doc 10 §8: presence and consistency, without inventing applicability.
  const documents: string[] = [];
  if (!f.documents.invoiceNumber) documents.push('Give the tax invoice number that travels with the goods.');
  else if (!f.documents.invoice) documents.push(`${f.documents.invoiceNumber} is not an invoice of ${f.order.number}.`);
  else if (f.documents.invoice.status === 'void') documents.push(`${f.documents.invoiceNumber} is void.`);
  const eWaybill = f.documents.eWaybillNumber.replace(/\s/g, '');
  if (eWaybill && !/^\d{12}$/.test(eWaybill)) documents.push(`${f.documents.eWaybillNumber} is not a 12-digit e-way bill number.`);
  else if (!eWaybill && f.documents.consignmentValueMinor > E_WAYBILL_THRESHOLD_MINOR) documents.push(`The consignment is worth ${money(f.documents.consignmentValueMinor)}: give the e-way bill number.`);

  return [
    guard('stock', 'From JobWork stock, receipts closed', stock),
    guard('quality', 'Quality released, no open NCR', quality),
    guard('payment', 'Paid, or covered by approved credit', payment),
    guard('commitment', 'Within the customer’s delivery terms', commitment),
    guard('holds', 'No change stop or open change', holds),
    guard('identity', 'Neutral packing, no other party named', identity),
    guard('address', 'Delivery address and contact confirmed', address),
    guard('documents', 'Tax invoice and e-way bill', documents),
  ];
}

export interface OverrideFact {
  overrideId: string;
  guardKey: string;
  status: 'requested' | 'approved' | 'rejected' | 'returned';
  approvalRequestId: string;
  reasonsHash: string;
  requestedAt: Date;
}

/**
 * An approved override turns its guard green only while the guard's reasons are exactly those the
 * owner approved; a new or changed reason makes it red again. Logistics' own guards are never
 * overridden, whatever is recorded.
 */
export function applyOverrides(guards: readonly ShipmentGuard[], overrides: readonly OverrideFact[]): ShipmentGuard[] {
  return guards.map((g) => {
    const latest = overrides.filter((o) => o.guardKey === g.key).sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0];
    if (!latest || !g.overridable) return g;
    const covers = !g.pass && latest.status === 'approved' && latest.reasonsHash === reasonsHash(g.reasons);
    return { ...g, pass: g.pass || covers, override: { overrideId: latest.overrideId, status: latest.status, approvalRequestId: latest.approvalRequestId, covers } };
  });
}
