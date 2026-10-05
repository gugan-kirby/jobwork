import type { CarrierMode, DiscrepancyKind, DiscrepancyResolution, ShipmentStatus } from '@jobwork/contracts';
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
