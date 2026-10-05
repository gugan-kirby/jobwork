import type { CarrierMode, DiscrepancyKind, DiscrepancyResolution, ShipmentStatus } from '@jobwork/contracts';
import type { Tone } from '@jobwork/ui';

/** A supplier's words for where its shipment stands (IN-16 F-16.4). */
export const SHIPMENT_STATUS: Record<ShipmentStatus, { label: string; tone: Tone }> = {
  draft: { label: 'draft', tone: 'neutral' },
  planned: { label: 'planned — submit when ready', tone: 'attention' },
  ready_for_release: { label: 'JobWork to release', tone: 'progress' },
  released: { label: 'released — hand to the carrier', tone: 'attention' },
  picked_up: { label: 'on the way', tone: 'progress' },
  in_transit: { label: 'on the way', tone: 'progress' },
  delivered_to_destination: { label: 'delivered — JobWork to receive', tone: 'progress' },
  receiving_check: { label: 'being received', tone: 'progress' },
  accepted: { label: 'received', tone: 'positive' },
  discrepancy_hold: { label: 'discrepancy at receiving', tone: 'blocked' },
  cancelled: { label: 'cancelled', tone: 'neutral' },
};

export const CARRIER_MODE: Record<CarrierMode, string> = {
  carrier: 'Transporter (LR)',
  courier: 'Courier',
  supplier_vehicle: 'Our own vehicle',
  jobwork_vehicle: 'JobWork vehicle',
};

export const DISCREPANCY: Record<DiscrepancyKind, string> = {
  shortage: 'Short',
  overage: 'More than shipped',
  damage: 'Damaged',
  wrong_item: 'Wrong item',
  document_mismatch: 'Documents do not match',
  identity: 'Marking or lot does not match',
};

export const RESOLUTION: Record<DiscrepancyResolution, string> = {
  accept_shortage: 'shortage accepted; the rest stays owed',
  replacement_expected: 'replacement expected',
  scrapped: 'scrapped',
  released_to_stock: 'accepted after inspection',
  return_to_supplier: 'to be returned to you',
  overage_accepted: 'overage accepted',
  document_corrected: 'documents corrected',
};

export const day = (iso: string): string => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
