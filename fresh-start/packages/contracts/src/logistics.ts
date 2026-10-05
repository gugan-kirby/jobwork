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
    .array(
      z.object({
        lotCode: z.string().trim().max(60).default(''),
        serials: z.array(z.string().trim().min(1).max(60)).max(500).default([]),
        quantity,
        /** Pieces for made parts; kg, m or sheets for customer-supplied material. */
        unit: z.string().trim().min(1).max(20).default('piece'),
        description: z.string().trim().max(200).default(''),
      }),
    )
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

// ----------------------------------------------------------------- receiving (doc 10 §13; BR-LOG-04)

export const packageConditionSchema = z.enum(['ok', 'damaged', 'missing']);
export const itemIdentitySchema = z.enum(['ok', 'mismatch', 'wrong_item']);
export const discrepancyKindSchema = z.enum(['shortage', 'overage', 'damage', 'wrong_item', 'document_mismatch', 'identity']);
export const discrepancyResolutionSchema = z.enum(['accept_shortage', 'replacement_expected', 'scrapped', 'released_to_stock', 'return_to_supplier', 'overage_accepted', 'document_corrected']);
export const receivingDecisionSchema = z.enum(['accept', 'partial', 'quarantine', 'reject']);

/** Every counted piece goes somewhere: accepted to stock, quarantined, or refused at the dock. */
export const receivingLineInputSchema = z.object({
  itemId: z.uuid(),
  countedQuantity: quantity,
  acceptedQuantity: quantity,
  quarantinedQuantity: quantity.default('0'),
  refusedQuantity: quantity.default('0'),
  identity: itemIdentitySchema.default('ok'),
  damaged: z.boolean().default(false),
  note: z.string().trim().max(500).default(''),
});

export const receiveShipmentRequestSchema = z.object({
  ...versioned,
  sealIntact: z.boolean(),
  /** The challan or invoice in the box matches the shipment's. */
  documentsMatch: z.boolean().default(true),
  packages: z.array(z.object({ packageNo: z.number().int().min(1).max(999), condition: packageConditionSchema, note: z.string().trim().max(500).default('') })).min(1).max(100),
  lines: z.array(receivingLineInputSchema).min(1).max(500),
  photoDocumentVersionIds: z.array(z.uuid()).max(20).default([]),
  note: z.string().trim().max(1000).default(''),
});

export const resolveDiscrepancyRequestSchema = z.object({
  resolution: discrepancyResolutionSchema,
  note: z.string().trim().min(3).max(1000),
  /** A carrier claim or supplier case reference. */
  caseReference: reference.default(''),
});

export const receivingDiscrepancySchema = z.object({
  discrepancyId: z.uuid(),
  number: z.string(),
  kind: discrepancyKindSchema,
  lotCode: z.string(),
  quantity: z.string(),
  description: z.string(),
  status: z.enum(['open', 'resolved']),
  resolution: discrepancyResolutionSchema.nullable(),
  resolutionNote: z.string(),
  caseReference: z.string(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const receivingSchema = z.object({
  receivedAt: z.string(),
  sealIntact: z.boolean(),
  decision: receivingDecisionSchema,
  packagesReceived: z.number().int(),
  packages: z.array(z.object({ packageNo: z.number().int(), condition: packageConditionSchema, note: z.string() })),
  lines: z.array(
    z.object({
      itemId: z.uuid(),
      lotCode: z.string(),
      shippedQuantity: z.string(),
      countedQuantity: z.string(),
      /** JobWork's own disposition of what arrived; null outside JobWork. */
      split: z.object({ accepted: z.string(), quarantined: z.string(), refused: z.string() }).nullable(),
      identity: itemIdentitySchema,
      damaged: z.boolean(),
      note: z.string(),
    }),
  ),
  note: z.string(),
});

/** What happened to one work package's quantity, end to end (doc 19 §8: remaining commitment visible). JobWork only. */
export const workPackageLogisticsSchema = z.object({
  workPackageId: z.uuid(),
  workPackageNumber: z.string(),
  ordered: z.string(),
  released: z.string(),
  shipped: z.string(),
  received: z.string(),
  accepted: z.string(),
  quarantined: z.string(),
  scrapped: z.string(),
  returned: z.string(),
  /** Ordered less accepted: what the supplier still owes. */
  outstanding: z.string(),
  lots: z.array(
    z.object({
      lotId: z.uuid(),
      lotCode: z.string(),
      sourceShipmentNumber: z.string(),
      receivedQuantity: z.string(),
      ownership: z.enum(['jobwork', 'customer_material']),
      balances: z.array(z.object({ locationCode: z.string(), label: z.string(), onHand: z.boolean(), quantity: z.string() })),
    }),
  ),
});

/** What a supplier may still ship of each quality-released lot on a purchase order (IN-16 F-16.4). */
export const shippableLotSchema = z.object({
  lotCode: z.string(),
  released: z.string(),
  /** On the work package's released, moving or received leg-1 shipments. */
  shipped: z.string(),
  available: z.string(),
  /** Open NCRs that hold the lot. */
  heldBy: z.array(z.string()),
});

// ----------------------------------------------------------------- customer-supplied material (D-15; FR-307)

/** Material the customer sends JobWork for the job, recorded as it arrives or is announced; received as any inbound shipment. */
export const registerCustomerMaterialRequestSchema = z.object({
  salesOrderId: z.uuid(),
  /** One of the customer's own addresses; when omitted, the order's delivery address, else the customer's first active one. */
  originSiteId: z.uuid().optional(),
  /** The customer's delivery challan. */
  documents: shipmentDocumentsSchema.default({ challanNumber: '', invoiceNumber: '', eWaybillNumber: '' }),
  carrierMode: carrierModeSchema,
  carrierName: z.string().trim().max(120).default(''),
  trackingReference: reference.default(''),
  packages: z.array(packageInputSchema).min(1).max(100),
});

/** JobWork issues customer material from its stock to the supplier making the part, on JobWork's own challan. */
export const issueMaterialRequestSchema = z.object({
  purchaseOrderId: z.uuid(),
  /** One of the supplier's works or pickup addresses; its first active works address when omitted. */
  destinationSiteId: z.uuid().optional(),
  documents: shipmentDocumentsSchema,
  lots: z.array(z.object({ lotId: z.uuid(), quantity })).min(1).max(50),
});

/** The supplier confirms the issued material arrived. */
export const acknowledgeMaterialRequestSchema = z.object({ ...versioned, note: z.string().trim().max(500).default('') });

export const materialLotSchema = z.object({
  lotId: z.uuid(),
  lotCode: z.string(),
  unit: z.string(),
  sourceShipmentNumber: z.string(),
  receivedQuantity: z.string(),
  inStock: z.string(),
  quarantined: z.string(),
  issued: z.string(),
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
  /** Null outside JobWork: the order is JobWork's, not the supplier's. */
  salesOrderId: z.uuid().nullable(),
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
  receiving: receivingSchema.nullable(),
  discrepancies: z.array(receivingDiscrepancySchema),
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
export type PackageCondition = z.infer<typeof packageConditionSchema>;
export type ItemIdentity = z.infer<typeof itemIdentitySchema>;
export type DiscrepancyKind = z.infer<typeof discrepancyKindSchema>;
export type DiscrepancyResolution = z.infer<typeof discrepancyResolutionSchema>;
export type ReceivingDecision = z.infer<typeof receivingDecisionSchema>;
export type ReceiveShipmentRequest = z.infer<typeof receiveShipmentRequestSchema>;
export type ResolveDiscrepancyRequest = z.infer<typeof resolveDiscrepancyRequestSchema>;
export type ReceivingDiscrepancy = z.infer<typeof receivingDiscrepancySchema>;
export type Receiving = z.infer<typeof receivingSchema>;
export type WorkPackageLogistics = z.infer<typeof workPackageLogisticsSchema>;
export type ShippableLot = z.infer<typeof shippableLotSchema>;
export type RegisterCustomerMaterialRequest = z.infer<typeof registerCustomerMaterialRequestSchema>;
export type IssueMaterialRequest = z.infer<typeof issueMaterialRequestSchema>;
export type AcknowledgeMaterialRequest = z.infer<typeof acknowledgeMaterialRequestSchema>;
export type MaterialLot = z.infer<typeof materialLotSchema>;
