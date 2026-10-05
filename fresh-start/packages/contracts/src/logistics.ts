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
  /** Leg 2 only: refused at the door; a return leg brings it back (IN-17). */
  'refused',
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

export const dispatchOverrideStatusSchema = z.enum(['requested', 'approved', 'rejected', 'returned']);

export const shipmentGuardSchema = z.object({
  key: z.string(),
  label: z.string(),
  pass: z.boolean(),
  reasons: z.array(z.string()),
  /** Leg 2: whether the guard's owner may approve an override (doc 03 §4). */
  overridable: z.boolean().default(false),
  /** Leg 2: the latest override asked for this guard; an approved one covers exactly the reasons it names. */
  override: z
    .object({ overrideId: z.uuid(), status: dispatchOverrideStatusSchema, approvalRequestId: z.uuid(), covers: z.boolean() })
    .nullable()
    .default(null),
});

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

// ----------------------------------------------------------------- leg 2: JobWork to the customer (IN-17; doc 10 §12; BR-LOG-03)

/** Doc 10 §12 "neutral/approved packaging and no unintended supplier identity", as the packer confirms it. */
export const packingCheckSchema = z.object({
  /** Plain cartons or JobWork's own: nothing printed by the workshop. */
  neutralCartons: z.boolean().default(false),
  /** Workshop tags, stickers and paperwork taken out. */
  supplierMarksRemoved: z.boolean().default(false),
  jobworkLabelsApplied: z.boolean().default(false),
  /** The packaging the customer asked for in the enquiry. */
  packagingNoteFollowed: z.boolean().default(false),
});

const packingCheckDefault = { neutralCartons: false, supplierMarksRemoved: false, jobworkLabelsApplied: false, packagingNoteFollowed: false };

/** A leg-2 package: pieces picked from JobWork stock lots, which carry JobWork's own marking. */
export const dispatchPackageInputSchema = z.object({
  packageNo: z.number().int().min(1).max(999),
  lengthMm: z.number().int().positive().max(100_000).nullable().default(null),
  widthMm: z.number().int().positive().max(100_000).nullable().default(null),
  heightMm: z.number().int().positive().max(100_000).nullable().default(null),
  weightG: z.number().int().positive().max(100_000_000).nullable().default(null),
  items: z
    .array(
      z.object({
        stockLotId: z.uuid(),
        quantity,
        serials: z.array(z.string().trim().min(1).max(60)).max(500).default([]),
        /** In the customer's words; the order's own line when left empty. */
        description: z.string().trim().max(200).default(''),
      }),
    )
    .min(1)
    .max(50),
});

export const planCustomerDispatchRequestSchema = z.object({
  salesOrderId: z.uuid(),
  /** One of the customer's active addresses; the order's delivery address, else the customer's first, when omitted. */
  destinationSiteId: z.uuid().optional(),
  packages: z.array(dispatchPackageInputSchema).min(1).max(100),
  documents: shipmentDocumentsSchema.default({ challanNumber: '', invoiceNumber: '', eWaybillNumber: '' }),
  packingCheck: packingCheckSchema.default(packingCheckDefault),
});
export const replanCustomerDispatchRequestSchema = planCustomerDispatchRequestSchema.omit({ salesOrderId: true }).extend(versioned);
/** The customer confirms the destination and receiving contact as they stand. */
export const confirmDeliveryAddressRequestSchema = z.object(versioned);
/** JobWork records a confirmation the customer gave by phone or mail. */
export const recordAddressConfirmationRequestSchema = z.object({ ...versioned, note: z.string().trim().min(3).max(500) });
export const overridableGuardSchema = z.enum(['quality', 'payment', 'commitment', 'holds']);
export const requestDispatchOverrideRequestSchema = z.object({ guardKey: overridableGuardSchema, justification: z.string().trim().min(10).max(1000) });

export const dispatchOverrideSchema = z.object({
  overrideId: z.uuid(),
  guardKey: overridableGuardSchema,
  reasons: z.array(z.string()),
  justification: z.string(),
  status: dispatchOverrideStatusSchema,
  approvalRequestId: z.uuid(),
  requiredRoles: z.array(z.string()),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
});

export const addressConfirmationSchema = z.object({
  party: z.enum(['customer', 'jobwork']),
  confirmedAt: z.string(),
  note: z.string(),
  /** False once the site was edited after the confirmation, or another site was chosen. */
  current: z.boolean(),
});

// ----------------------------------------------------------------- delivery, POD and acceptance (IN-17 F-17.3; BR-LOG-05; FR-905)

export const podRemarksSchema = z.enum(['clean', 'with_remarks']);
export const podSourceSchema = z.enum(['carrier', 'driver', 'jobwork_staff']);
export const deliveryExceptionKindSchema = z.enum(['address_change', 'refused', 'not_received', 'shortage', 'damage', 'wrong_item', 'quality_defect', 'documents']);
/** What a customer reports about a delivery: at the door, inside the window, or later as a warranty claim. */
export const deliveryIssueKindSchema = z.enum(['not_received', 'shortage', 'damage', 'wrong_item', 'quality_defect', 'documents']);
export const deliveryExceptionResolutionSchema = z.enum(['found_delivered', 'customer_withdrew', 'handed_to_case', 'redirected', 'declined', 'returned_to_stock']);

/** Proof of delivery: who took the goods, when, in what state (doc 10 §11). Not acceptance (BR-LOG-05). */
export const recordPodRequestSchema = z.object({
  ...versioned,
  receivedByName: z.string().trim().min(2).max(120),
  receivedAt: z.iso.datetime(),
  packagesReceived: z.number().int().min(0).max(999),
  remarks: podRemarksSchema,
  remarksNote: z.string().trim().max(1000).default(''),
  /** The signed copy and photos: JobWork's own clean files. */
  documentVersionIds: z.array(z.uuid()).max(20).default([]),
  source: podSourceSchema,
}).refine((pod) => pod.remarks === 'clean' || pod.remarksNote.length >= 3, { path: ['remarksNote'], message: 'Say what the remarks were' });

export const acceptDeliveryRequestSchema = z.object({ ...versioned, note: z.string().trim().max(500).default('') });

export const reportDeliveryIssueRequestSchema = z.object({
  kind: deliveryIssueKindSchema,
  /** JobWork's lot marking, as on the delivery note; empty for the whole delivery. */
  lotMarking: z.string().trim().max(60).default(''),
  quantity: quantity.default('0'),
  description: z.string().trim().min(3).max(2000),
  /** Photos and documents: the customer's own clean files. */
  evidenceDocumentVersionIds: z.array(z.uuid()).max(20).default([]),
});

export const withdrawDeliveryIssueRequestSchema = z.object({ note: z.string().trim().max(500).default('') });

export const requestAddressChangeRequestSchema = z.object({ siteId: z.uuid(), reason: z.string().trim().min(3).max(1000) });

export const recordRefusalRequestSchema = z.object({
  ...versioned,
  refusedBy: z.string().trim().min(2).max(120),
  reason: z.string().trim().min(3).max(1000),
  evidenceDocumentVersionIds: z.array(z.uuid()).max(20).default([]),
});

export const resolveDeliveryExceptionRequestSchema = z.object({
  resolution: deliveryExceptionResolutionSchema,
  note: z.string().trim().min(3).max(1000),
  /** The support case (IN-18) or carrier reference this continues under. */
  caseReference: reference.default(''),
  carrierChargeNote: z.string().trim().max(500).default(''),
});

export const proofOfDeliverySchema = z.object({
  receivedByName: z.string(),
  receivedAt: z.string(),
  deliveredTo: siteSnapshotSchema,
  packagesReceived: z.number().int(),
  remarks: podRemarksSchema,
  remarksNote: z.string(),
  source: podSourceSchema,
  documentCount: z.number().int(),
});

export const deliveryAcceptanceSchema = z.object({
  basis: z.enum(['explicit', 'deemed']),
  acceptedAt: z.string(),
  warrantyStatement: z.string(),
  note: z.string(),
});

export const deliveryExceptionSchema = z.object({
  exceptionId: z.uuid(),
  number: z.string(),
  kind: deliveryExceptionKindSchema,
  raisedByParty: z.enum(['customer', 'jobwork', 'carrier']),
  lotMarking: z.string(),
  quantity: z.string(),
  description: z.string(),
  evidenceCount: z.number().int(),
  warrantyClaim: z.boolean(),
  requestedAddress: siteSnapshotSchema.nullable(),
  status: z.enum(['open', 'resolved']),
  resolution: deliveryExceptionResolutionSchema.nullable(),
  /** JobWork's own note; empty outside JobWork. */
  resolutionNote: z.string(),
  caseReference: z.string(),
  carrierChargeNote: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});

/** A document of an order, for the customer's own record (IN-17 F-17.4): each is rendered on request with its content hash. */
export const customerOrderDocumentSchema = z.object({
  kind: z.enum(['quotation', 'invoice', 'delivery_note', 'proof_of_delivery', 'conformity_certificate']),
  title: z.string(),
  reference: z.string(),
  date: z.string().nullable(),
  /** The API path that renders it: `{ html, contentHash }`. */
  path: z.string(),
});

/** Leg 2's dispatch facts on JobWork's shipment view. */
export const shipmentDeliverySchema = z.object({
  orderNumber: z.string(),
  customerDisplayName: z.string(),
  packagingNote: z.string(),
  partialDelivery: z.enum(['allowed', 'not_allowed']),
  packingCheck: packingCheckSchema,
  addressConfirmation: addressConfirmationSchema.nullable(),
  overrides: z.array(dispatchOverrideSchema),
  pod: proofOfDeliverySchema.nullable(),
  acceptance: deliveryAcceptanceSchema.nullable(),
  /** The end of the customer's window, set by the POD (FR-905). */
  acceptanceDueAt: z.string().nullable(),
  exceptions: z.array(deliveryExceptionSchema),
  /** The leg bringing a refused delivery back. */
  returnShipmentId: z.uuid().nullable(),
});

/** A stock lot of an order that leg 2 may pick from, with what is free of other prepared dispatches (JobWork only). */
export const dispatchableLotSchema = z.object({
  stockLotId: z.uuid(),
  /** JobWork's marking, as the customer will see it. */
  marking: z.string(),
  /** The lot as quality released it. */
  lotCode: z.string(),
  workPackageNumber: z.string(),
  sourceShipmentNumber: z.string(),
  unit: z.string(),
  serials: z.array(z.string()),
  inStock: z.string(),
  onPreparedDispatches: z.string(),
  available: z.string(),
  /** The receipt it came on still has an open discrepancy. */
  receiptOpen: z.boolean(),
  released: z.boolean(),
  heldBy: z.array(z.string()),
});

/** What the leg-2 planner needs for one order (JobWork only). */
export const dispatchContextSchema = z.object({
  salesOrderId: z.uuid(),
  orderNumber: z.string(),
  customerDisplayName: z.string(),
  deliverySiteId: z.uuid().nullable(),
  sites: z.array(siteSnapshotSchema.extend({ siteId: z.uuid() })),
  /** The order's issued invoices: the tax invoice travels with the goods. */
  invoices: z.array(z.object({ number: z.string(), kind: z.string(), status: z.string() })),
  partialDelivery: z.enum(['allowed', 'not_allowed']),
  packagingNote: z.string(),
  ordered: z.string(),
  /** Already delivered or on the way, net of anything brought back. */
  dispatched: z.string(),
  lots: z.array(dispatchableLotSchema),
});

export const customerDeliveryStatusSchema = z.enum(['preparing', 'ready_to_leave', 'on_the_way', 'carrier_reports_delivered', 'awaiting_your_confirmation', 'issue_reported', 'accepted', 'refused']);

/**
 * A delivery as the customer sees it (doc 06 §13), built by construction from allowlisted fields:
 * JobWork's lot markings, the customer's own address, JobWork's carrier and documents. Nothing of
 * the supplier, its purchase order, its lot codes or the workshop's address.
 */
export const customerDeliverySchema = z.object({
  shipmentId: z.uuid(),
  number: z.string(),
  orderId: z.uuid(),
  orderNumber: z.string(),
  status: customerDeliveryStatusSchema,
  statusLabel: z.string(),
  destination: siteSnapshotSchema.nullable(),
  addressConfirmation: z.object({ needed: z.boolean(), confirmedAt: z.string().nullable(), byJobWork: z.boolean() }),
  carrier: z.object({ name: z.string(), trackingReference: z.string() }),
  dispatchedAt: z.string().nullable(),
  packages: z.array(
    z.object({
      packageNo: z.number().int(),
      weightG: z.number().nullable(),
      items: z.array(z.object({ lotMarking: z.string(), serials: z.array(z.string()), quantity: z.string(), unit: z.string(), description: z.string() })),
    }),
  ),
  totalQuantity: z.string(),
  documents: z.object({ invoiceNumber: z.string(), eWaybillNumber: z.string() }),
  tracking: z.array(z.object({ status: carrierStatusSchema, occurredAt: z.string() })),
  pod: proofOfDeliverySchema.omit({ source: true, documentCount: true }).nullable(),
  acceptance: deliveryAcceptanceSchema.nullable(),
  acceptanceDueAt: z.string().nullable(),
  /** The customer's own reports, address changes and a refusal, with JobWork's resolution but not its notes. */
  exceptions: z.array(deliveryExceptionSchema.omit({ carrierChargeNote: true })),
  /** What acceptance means for the warranty, in force now (FR-905). */
  warrantyStatement: z.string(),
  /** What the delivery's state allows; the portal also checks the reader's roles. */
  actions: z.object({ confirmAddress: z.boolean(), accept: z.boolean(), reportIssue: z.boolean(), reportNotReceived: z.boolean(), reportDefect: z.boolean(), requestAddressChange: z.boolean() }),
  createdAt: z.string(),
  aggregateVersion: z.number().int().positive(),
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
      items: z.array(
        z.object({
          itemId: z.uuid(),
          /** On leg 2, JobWork's marking. */
          lotCode: z.string(),
          serials: z.array(z.string()),
          quantity: z.string(),
          unit: z.string(),
          description: z.string(),
          /** The JobWork stock lot a leg-2 or issue item is picked from. */
          stockLotId: z.uuid().nullable(),
          /** Leg 2, JobWork only: the lot as quality released it, behind JobWork's marking. */
          sourceLotCode: z.string(),
        }),
      ),
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
  /** A return leg names the outbound shipment it brings back. */
  returnsShipmentId: z.uuid().nullable(),
  /** Leg 2 only. */
  delivery: shipmentDeliverySchema.nullable(),
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
export type PackingCheck = z.infer<typeof packingCheckSchema>;
export type DispatchPackageInput = z.infer<typeof dispatchPackageInputSchema>;
export type PlanCustomerDispatchRequest = z.infer<typeof planCustomerDispatchRequestSchema>;
export type ReplanCustomerDispatchRequest = z.infer<typeof replanCustomerDispatchRequestSchema>;
export type ConfirmDeliveryAddressRequest = z.infer<typeof confirmDeliveryAddressRequestSchema>;
export type RecordAddressConfirmationRequest = z.infer<typeof recordAddressConfirmationRequestSchema>;
export type OverridableGuard = z.infer<typeof overridableGuardSchema>;
export type RequestDispatchOverrideRequest = z.infer<typeof requestDispatchOverrideRequestSchema>;
export type DispatchOverride = z.infer<typeof dispatchOverrideSchema>;
export type DispatchOverrideStatus = z.infer<typeof dispatchOverrideStatusSchema>;
export type AddressConfirmation = z.infer<typeof addressConfirmationSchema>;
export type ShipmentDelivery = z.infer<typeof shipmentDeliverySchema>;
export type DispatchableLot = z.infer<typeof dispatchableLotSchema>;
export type DispatchContext = z.infer<typeof dispatchContextSchema>;
export type CustomerDeliveryStatus = z.infer<typeof customerDeliveryStatusSchema>;
export type CustomerDelivery = z.infer<typeof customerDeliverySchema>;
export type PodRemarks = z.infer<typeof podRemarksSchema>;
export type DeliveryExceptionKind = z.infer<typeof deliveryExceptionKindSchema>;
export type DeliveryIssueKind = z.infer<typeof deliveryIssueKindSchema>;
export type DeliveryExceptionResolution = z.infer<typeof deliveryExceptionResolutionSchema>;
export type RecordPodRequest = z.infer<typeof recordPodRequestSchema>;
export type AcceptDeliveryRequest = z.infer<typeof acceptDeliveryRequestSchema>;
export type ReportDeliveryIssueRequest = z.infer<typeof reportDeliveryIssueRequestSchema>;
export type WithdrawDeliveryIssueRequest = z.infer<typeof withdrawDeliveryIssueRequestSchema>;
export type RequestAddressChangeRequest = z.infer<typeof requestAddressChangeRequestSchema>;
export type RecordRefusalRequest = z.infer<typeof recordRefusalRequestSchema>;
export type ResolveDeliveryExceptionRequest = z.infer<typeof resolveDeliveryExceptionRequestSchema>;
export type ProofOfDelivery = z.infer<typeof proofOfDeliverySchema>;
export type DeliveryAcceptance = z.infer<typeof deliveryAcceptanceSchema>;
export type DeliveryException = z.infer<typeof deliveryExceptionSchema>;
export type CustomerOrderDocument = z.infer<typeof customerOrderDocumentSchema>;
