import type { DeliveryExceptionKind, DeliveryExceptionResolution, DeliveryIssueKind, ShipmentStatus } from '@jobwork/contracts';

/**
 * Delivery, POD and acceptance rules for leg 2 (IN-17 F-17.3; doc 06 §11; BR-LOG-05; FR-905;
 * doc 19 §8). POD is the carrier's or driver's evidence of the handover; acceptance is the
 * customer's, explicit or by the window running out. What a customer may report depends on where
 * the delivery stands, and acceptance never takes away a warranty claim.
 */

/** India Standard Time has no daylight saving: UTC+05:30 all year. */
const IST_OFFSET_MS = 330 * 60_000;

/** The end of the last day of the window, in IST: `windowDays` whole days after the day of delivery. */
export function acceptanceDueAt(deliveredAt: Date, windowDays: number): Date {
  const local = new Date(deliveredAt.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + windowDays, 23, 59, 59, 999) - IST_OFFSET_MS);
}

export type IssueVerdict = { ok: true; warrantyClaim: boolean; holds: boolean } | { ok: false; code: string; title: string; detail?: string };

/**
 * Doc 19 §8: "not received" when the carrier says delivered; a shortage, damage or defect inside the
 * window holds the delivery; a defect found after acceptance is a warranty claim and holds nothing.
 */
export function issueAllowed(status: ShipmentStatus, kind: DeliveryIssueKind, now: Date, dueAt: Date | null): IssueVerdict {
  if (kind === 'not_received') {
    return status === 'delivered_to_destination'
      ? { ok: true, warrantyClaim: false, holds: true }
      : { ok: false, code: 'NOT_RECEIVED_STATUS', title: 'Report a delivery not received once the carrier says it was delivered' };
  }
  const late = { ok: false as const, code: 'WINDOW_CLOSED', title: 'The time to report a shortage, damage or wrong item has passed', detail: 'Acceptance confirmed the quantity and visible condition. A defect found later is reported as a warranty claim.' };
  if (status === 'accepted') return kind === 'quality_defect' ? { ok: true, warrantyClaim: true, holds: false } : late;
  if (status === 'receiving_check') {
    if (dueAt && now.getTime() > dueAt.getTime()) return kind === 'quality_defect' ? { ok: true, warrantyClaim: true, holds: false } : late;
    return { ok: true, warrantyClaim: false, holds: true };
  }
  if (status === 'discrepancy_hold') return { ok: true, warrantyClaim: false, holds: true };
  return { ok: false, code: 'NOT_DELIVERED', title: 'Report an issue once the delivery has arrived' };
}

/** How each exception may be closed. `customer_withdrew` is the customer's own act, never JobWork's. */
export const RESOLUTIONS: Record<DeliveryExceptionKind, readonly DeliveryExceptionResolution[]> = {
  address_change: ['redirected', 'declined'],
  refused: ['returned_to_stock', 'handed_to_case'],
  not_received: ['found_delivered', 'handed_to_case'],
  shortage: ['handed_to_case', 'declined'],
  damage: ['handed_to_case', 'declined'],
  wrong_item: ['handed_to_case', 'declined'],
  quality_defect: ['handed_to_case', 'declined'],
  documents: ['handed_to_case', 'declined'],
};

/** Who resolves: an address change is logistics' (the carrier is logistics'); the rest, support or logistics. */
export function resolverRoles(kind: DeliveryExceptionKind): readonly string[] {
  return kind === 'address_change' ? ['jobwork_logistics'] : ['jobwork_support', 'jobwork_logistics'];
}

/**
 * Whether an exception still holds its delivery. A report inside the window holds until it is
 * withdrawn, found delivered or declined; one handed to a case holds until the case (IN-18) decides.
 * An address change, a refusal and a warranty claim never hold the leg.
 */
export function holdsDelivery(x: { kind: DeliveryExceptionKind; warrantyClaim: boolean; status: 'open' | 'resolved'; resolution: DeliveryExceptionResolution | null }): boolean {
  if (x.warrantyClaim || x.kind === 'address_change' || x.kind === 'refused') return false;
  return x.status === 'open' || x.resolution === 'handed_to_case';
}
