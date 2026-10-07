import type { CarrierMode, DeliveryExceptionKind, DeliveryExceptionResolution, DiscrepancyKind, DiscrepancyResolution, ShipmentStatus } from '@jobwork/contracts';
import type { Tone } from '@jobwork/ui';

/** JobWork's words for a shipment's state (IN-16 F-16.4; doc 06 §11). */
export const SHIPMENT_STATUS: Record<ShipmentStatus, { label: string; tone: Tone }> = {
  draft: { label: 'draft', tone: 'neutral' },
  planned: { label: 'supplier preparing', tone: 'neutral' },
  ready_for_release: { label: 'to release', tone: 'attention' },
  released: { label: 'released, awaiting pickup', tone: 'progress' },
  picked_up: { label: 'picked up', tone: 'progress' },
  in_transit: { label: 'in transit', tone: 'progress' },
  delivered_to_destination: { label: 'carrier delivered — receive it', tone: 'attention' },
  receiving_check: { label: 'receiving', tone: 'progress' },
  accepted: { label: 'received', tone: 'positive' },
  discrepancy_hold: { label: 'discrepancy hold', tone: 'blocked' },
  cancelled: { label: 'cancelled', tone: 'neutral' },
  refused: { label: 'refused at delivery — coming back', tone: 'blocked' },
};

export const CARRIER_MODE: Record<CarrierMode, string> = {
  carrier: 'Transporter (LR)',
  courier: 'Courier',
  supplier_vehicle: 'Supplier vehicle',
  jobwork_vehicle: 'JobWork vehicle',
};

export const DISCREPANCY: Record<DiscrepancyKind, string> = {
  shortage: 'Shortage',
  overage: 'Overage',
  damage: 'Damage',
  wrong_item: 'Wrong item',
  document_mismatch: 'Document mismatch',
  identity: 'Identity',
};

export const RESOLUTION: Record<DiscrepancyResolution, string> = {
  accept_shortage: 'Accept the shortage (stays owed)',
  replacement_expected: 'Replacement expected',
  scrapped: 'Scrap the quarantined pieces',
  released_to_stock: 'Release quarantine to stock',
  return_to_supplier: 'Return to the supplier',
  overage_accepted: 'Accept the overage into stock',
  document_corrected: 'Documents corrected',
};

/** The server's matrix (receiving.command.ts), so only valid choices are offered. */
export const RESOLUTIONS: Record<DiscrepancyKind, readonly DiscrepancyResolution[]> = {
  shortage: ['accept_shortage', 'replacement_expected'],
  overage: ['overage_accepted', 'return_to_supplier'],
  damage: ['scrapped', 'released_to_stock', 'return_to_supplier'],
  wrong_item: ['return_to_supplier', 'scrapped'],
  identity: ['released_to_stock', 'return_to_supplier', 'scrapped'],
  document_mismatch: ['document_corrected'],
};
/** Quality decides what leaves quarantine for stock or scrap; logistics the rest. */
export const QUALITY_RESOLUTIONS: readonly DiscrepancyResolution[] = ['scrapped', 'released_to_stock', 'overage_accepted'];

export const RECEIVABLE: readonly ShipmentStatus[] = ['picked_up', 'in_transit', 'delivered_to_destination'];

export const when = (iso: string): string => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** Leg 2 reads differently: the customer receives, and accepts or reports (IN-17; doc 06 §11). */
export const DELIVERY_STATUS: Record<ShipmentStatus, { label: string; tone: Tone }> = {
  draft: { label: 'draft', tone: 'neutral' },
  planned: { label: 'being prepared', tone: 'neutral' },
  ready_for_release: { label: 'to release', tone: 'attention' },
  released: { label: 'released, awaiting pickup', tone: 'progress' },
  picked_up: { label: 'on the way', tone: 'progress' },
  in_transit: { label: 'on the way', tone: 'progress' },
  delivered_to_destination: { label: 'carrier delivered — get the POD', tone: 'attention' },
  receiving_check: { label: 'awaiting customer acceptance', tone: 'progress' },
  accepted: { label: 'accepted by the customer', tone: 'positive' },
  discrepancy_hold: { label: 'held — customer issue', tone: 'blocked' },
  cancelled: { label: 'cancelled', tone: 'neutral' },
  refused: { label: 'refused at delivery — coming back', tone: 'blocked' },
};

/** The status a shipment's own leg would use. */
export const statusOf = (s: { leg: string; status: ShipmentStatus }): { label: string; tone: Tone } => (s.leg === 'jobwork_to_customer' ? DELIVERY_STATUS : SHIPMENT_STATUS)[s.status];

export const EXCEPTION: Record<DeliveryExceptionKind, string> = {
  address_change: 'Address change',
  refused: 'Refused at delivery',
  not_received: 'Not received',
  shortage: 'Shortage',
  damage: 'Damage',
  wrong_item: 'Wrong item',
  quality_defect: 'Defect',
  documents: 'Documents',
};

export const EXCEPTION_RESOLUTION: Record<DeliveryExceptionResolution, string> = {
  found_delivered: 'Found delivered',
  customer_withdrew: 'Withdrawn by the customer',
  handed_to_case: 'Handed to a case',
  redirected: 'Redirected by the carrier',
  declined: 'Declined',
  returned_to_stock: 'Back in JobWork stock',
};

/** What JobWork may close each exception with (the API's `RESOLUTIONS`; a return closes a refusal). */
export const EXCEPTION_RESOLUTIONS: Record<DeliveryExceptionKind, DeliveryExceptionResolution[]> = {
  address_change: ['redirected', 'declined'],
  refused: ['handed_to_case'],
  not_received: ['found_delivered', 'handed_to_case'],
  shortage: ['handed_to_case', 'declined'],
  damage: ['handed_to_case', 'declined'],
  wrong_item: ['handed_to_case', 'declined'],
  quality_defect: ['handed_to_case', 'declined'],
  documents: ['handed_to_case', 'declined'],
};

export const GUARD_OWNER: Record<string, string> = { quality: 'quality', payment: 'finance', commitment: 'sales', holds: 'engineering' };

export const PACKING_LABEL: Record<'neutralCartons' | 'supplierMarksRemoved' | 'jobworkLabelsApplied' | 'packagingNoteFollowed', string> = {
  neutralCartons: 'Packed in neutral or JobWork cartons',
  supplierMarksRemoved: 'Workshop tags, stickers and paperwork removed',
  jobworkLabelsApplied: 'JobWork labels applied',
  packagingNoteFollowed: 'The customer’s packaging instructions followed',
};
