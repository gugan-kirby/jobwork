import { z } from 'zod';

/**
 * Logistics leg 1 and JobWork receiving (IN-16; doc 06 §11; doc 10 §§10–13; FR-901–FR-903).
 * Quantities travel as decimal strings; a shipment's addresses are snapshots frozen at release.
 */

export const shipmentLegSchema = z.enum(['supplier_to_jobwork', 'jobwork_to_customer', 'customer_to_jobwork', 'jobwork_to_supplier']);
export const shipmentStatusSchema = z.enum([
  'draft',
  'planned',
  'ready_for_release',
  'released',
  'picked_up',
  'in_transit',
  'delivered_to_destination',
  'receiving_check',
  'accepted',
  'discrepancy_hold',
  'cancelled',
]);
export const carrierModeSchema = z.enum(['carrier', 'supplier_vehicle', 'courier', 'jobwork_vehicle']);
export const carrierStatusSchema = z.enum(['picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'exception']);

const quantity = z.string().trim().regex(/^\d{1,12}(\.\d{1,4})?$/, 'A quantity, e.g. 5 or 2.5');
const versioned = { expectedVersion: z.number().int().positive() };
const reference = z.string().trim().max(60);

export const shipmentDocumentsSchema = z.object({
  challanNumber: reference.default(''),
  invoiceNumber: reference.default(''),
  eWaybillNumber: reference.default(''),
});

export const packageInputSchema = z.object({
  packageNo: z.number().int().min(1).max(999),
  lengthMm: z.number().int().positive().max(100_000).nullable().default(null),
  widthMm: z.number().int().positive().max(100_000).nullable().default(null),
  heightMm: z.number().int().positive().max(100_000).nullable().default(null),
  weightG: z.number().int().positive().max(100_000_000).nullable().default(null),
  items: z
    .array(z.object({ lotCode: z.string().trim().max(60).default(''), serials: z.array(z.string().trim().min(1).max(60)).max(500).default([]), quantity, description: z.string().trim().max(200).default('') }))
    .min(1)
    .max(50),
});

export const planShipmentRequestSchema = z.object({
  purchaseOrderId: z.uuid(),
  originSiteId: z.uuid(),
  packages: z.array(packageInputSchema).min(1).max(100),
  documents: shipmentDocumentsSchema.default({ challanNumber: '', invoiceNumber: '', eWaybillNumber: '' }),
});
export const replanShipmentRequestSchema = planShipmentRequestSchema.omit({ purchaseOrderId: true }).extend(versioned);
export const shipmentVersionRequestSchema = z.object(versioned);
export const cancelShipmentRequestSchema = z.object({ ...versioned, reason: z.string().trim().min(3).max(500) });
export const recordPickupRequestSchema = z.object({
  ...versioned,
  carrierMode: carrierModeSchema,
  carrierName: z.string().trim().max(120).default(''),
  trackingReference: reference.default(''),
});
export const recordCarrierEventRequestSchema = z.object({
  providerEventId: z.string().trim().min(1).max(120),
  rawStatus: z.string().trim().min(1).max(60),
  normalizedStatus: carrierStatusSchema,
  occurredAt: z.iso.datetime(),
});

export const shipmentGuardSchema = z.object({ key: z.string(), label: z.string(), pass: z.boolean(), reasons: z.array(z.string()) });

export const siteSnapshotSchema = z.object({
  label: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string(),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  countryCode: z.string(),
  contactName: z.string(),
  contactPhone: z.string(),
});

export const shipmentSchema = z.object({
  shipmentId: z.uuid(),
  number: z.string(),
  leg: shipmentLegSchema,
  status: shipmentStatusSchema,
  purchaseOrderId: z.uuid().nullable(),
  purchaseOrderNumber: z.string(),
  workPackageId: z.uuid().nullable(),
  salesOrderId: z.uuid(),
  /** Empty for anyone outside JobWork who is not the shipper. */
  supplierDisplayName: z.string(),
  origin: siteSnapshotSchema.nullable(),
  destination: siteSnapshotSchema.nullable(),
  documents: z.object({ challanNumber: z.string(), invoiceNumber: z.string(), eWaybillNumber: z.string() }),
  carrier: z.object({ mode: carrierModeSchema.nullable(), name: z.string(), trackingReference: z.string() }),
  packages: z.array(
    z.object({
      packageNo: z.number().int(),
      lengthMm: z.number().nullable(),
      widthMm: z.number().nullable(),
      heightMm: z.number().nullable(),
      weightG: z.number().nullable(),
      items: z.array(z.object({ itemId: z.uuid(), lotCode: z.string(), serials: z.array(z.string()), quantity: z.string(), unit: z.string(), description: z.string() })),
    }),
  ),
  totalQuantity: z.string(),
  /** Computed while the shipment is prepared; frozen into the release record once released. */
  guards: z.array(shipmentGuardSchema),
  carrierEvents: z.array(z.object({ normalizedStatus: carrierStatusSchema, rawStatus: z.string(), occurredAt: z.string(), provider: z.string() })),
  releasedAt: z.string().nullable(),
  pickedUpAt: z.string().nullable(),
  carrierDeliveredAt: z.string().nullable(),
  createdAt: z.string(),
  aggregateVersion: z.number().int().positive(),
});

export type ShipmentLeg = z.infer<typeof shipmentLegSchema>;
export type ShipmentStatus = z.infer<typeof shipmentStatusSchema>;
export type CarrierMode = z.infer<typeof carrierModeSchema>;
export type CarrierStatus = z.infer<typeof carrierStatusSchema>;
export type PackageInput = z.infer<typeof packageInputSchema>;
export type PlanShipmentRequest = z.infer<typeof planShipmentRequestSchema>;
export type ReplanShipmentRequest = z.infer<typeof replanShipmentRequestSchema>;
export type ShipmentVersionRequest = z.infer<typeof shipmentVersionRequestSchema>;
export type CancelShipmentRequest = z.infer<typeof cancelShipmentRequestSchema>;
export type RecordPickupRequest = z.infer<typeof recordPickupRequestSchema>;
export type RecordCarrierEventRequest = z.infer<typeof recordCarrierEventRequestSchema>;
export type ShipmentGuard = z.infer<typeof shipmentGuardSchema>;
export type SiteSnapshot = z.infer<typeof siteSnapshotSchema>;
export type Shipment = z.infer<typeof shipmentSchema>;
