import type { ShipmentGuard } from '@jobwork/contracts';
import { DomainError } from '../../../platform/http/domain-error';
import { Rational } from '../../quality';

/**
 * Leg-1 dispatch rules (IN-16 F-16.2; doc 06 §11; doc 10 §12; BR-LOG-02). The guard set is the
 * doc 10 §12 list, each guard with the reasons it is red; release re-runs it inside the
 * transaction and freezes it into the release record.
 */

export class LogisticsRefused extends DomainError {
  constructor(code: string, title: string, detail?: string, status = 409) {
    super(code, status, title, detail);
  }
}

/** CGST Rule 138: an e-way bill above ₹50,000 of consignment value (owner default; legal review open). */
export const E_WAYBILL_THRESHOLD_MINOR = 5_000_000;

export interface LegOneFacts {
  purchaseOrder: { number: string; status: string };
  workPackage: { number: string; status: string } | null;
  releases: Array<{ lots: string[]; quantity: string }>;
  /** Items already on this work package's live leg-1 shipments, this one excluded. */
  shippedBefore: Array<{ lotCode: string; quantity: string }>;
  items: Array<{ packageNo: number; lotCode: string; quantity: string }>;
  packageNos: number[];
  openNcrs: Array<{ number: string; lots: string[] }>;
  interimStop: { changeNumber: string } | null;
  supplierActive: boolean;
  documents: { challanNumber: string; invoiceNumber: string; eWaybillNumber: string };
  consignmentValueMinor: number;
  originProblem: string | null;
  hubPresent: boolean;
}

const sum = (xs: Array<{ quantity: string }>): Rational => xs.reduce((t, x) => t.add(Rational.parse(x.quantity)), Rational.of(0));
const show = (r: Rational): string => r.toDisplay(4);

export function legOneGuards(f: LegOneFacts): ShipmentGuard[] {
  const guard = (key: string, label: string, reasons: string[]): ShipmentGuard => ({ key, label, pass: reasons.length === 0, reasons, overridable: false, override: null });

  const eligible: string[] = [];
  if (f.purchaseOrder.status !== 'acknowledged') eligible.push(`${f.purchaseOrder.number} is ${f.purchaseOrder.status}: the supplier acknowledges it first.`);
  if (!f.workPackage) eligible.push('The work package is not planned.');
  else if (!['released', 'in_production', 'completed'].includes(f.workPackage.status)) eligible.push(`${f.workPackage.number} is ${f.workPackage.status.replace(/_/g, ' ')}.`);

  // BR-LOG-02: never more than quality released, less what earlier shipments took.
  const released: string[] = [];
  if (f.releases.length === 0) released.push('Nothing is quality released yet.');
  else {
    const lotted = f.releases.some((r) => r.lots.length > 0);
    const lots = [...new Set(f.items.map((i) => i.lotCode))];
    for (const lot of lots) {
      const covering = f.releases.filter((r) => (lot === '' ? r.lots.length === 0 : r.lots.includes(lot)));
      if (lot === '' && lotted) released.push('Name the lot of every item: quality released by lot.');
      else if (covering.length === 0) released.push(`${lot} is not quality released.`);
      else {
        const want = sum(f.items.filter((i) => i.lotCode === lot)).add(sum(f.shippedBefore.filter((s) => s.lotCode === lot)));
        const cap = sum(covering);
        if (want.compare(cap) > 0) released.push(`${lot}: ${show(want)} would ship against ${show(cap)} released.`);
      }
    }
    const total = sum(f.items).add(sum(f.shippedBefore));
    if (total.compare(sum(f.releases)) > 0) released.push(`${show(total)} would ship against ${show(sum(f.releases))} released in all.`);
  }

  const holds: string[] = [];
  const lots = new Set(f.items.map((i) => i.lotCode));
  for (const n of f.openNcrs) {
    if (n.lots.length === 0) holds.push(`${n.number} is open on the whole work package.`);
    else if (n.lots.some((l) => lots.has(l))) holds.push(`${n.number} holds ${n.lots.filter((l) => lots.has(l)).join(', ')}.`);
  }
  if (f.interimStop) holds.push(`Work is stopped under ${f.interimStop.changeNumber}.`);
  if (!f.supplierActive) holds.push('The supplier is not active in the network.');

  const packing: string[] = [];
  if (f.items.length === 0) packing.push('No items are packed.');
  if (new Set(f.packageNos).size !== f.packageNos.length) packing.push('Package numbers repeat.');
  for (const p of f.packageNos) if (!f.items.some((i) => i.packageNo === p)) packing.push(`Package ${p} is empty.`);

  const documents: string[] = [];
  if (!f.documents.challanNumber && !f.documents.invoiceNumber) documents.push('Give the delivery challan or tax invoice number.');
  if (f.consignmentValueMinor > E_WAYBILL_THRESHOLD_MINOR && !f.documents.eWaybillNumber) {
    documents.push(`The consignment is worth ₹${(f.consignmentValueMinor / 100).toLocaleString('en-IN')}: give the e-way bill number.`);
  }

  const addresses: string[] = [];
  if (f.originProblem) addresses.push(f.originProblem);
  if (!f.hubPresent) addresses.push('JobWork’s receiving hub has no active works address.');

  return [
    guard('eligibility', 'Purchase order and work package eligible', eligible),
    guard('quantity', 'Within the quality-released quantity', released),
    guard('holds', 'No NCR, stop or supplier hold', holds),
    guard('packing', 'Packed, every package mapped', packing),
    guard('documents', 'Statutory documents', documents),
    guard('addresses', 'Pickup and receiving addresses', addresses),
  ];
}

/** Carrier statuses move the leg forward; none of them receives or accepts anything (doc 06 §11). */
export function carrierTarget(current: string, status: string): string | null {
  if (status === 'delivered' && ['picked_up', 'in_transit'].includes(current)) return 'delivered_to_destination';
  if ((status === 'in_transit' || status === 'out_for_delivery') && current === 'picked_up') return 'in_transit';
  return null;
}
