import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { DiscrepancyKind, DiscrepancyResolution, DispatchOverrideStatus, PackageCondition, PackageInput, PackingCheck, ReceivingDecision, ShipmentLeg, ShipmentStatus, SiteSnapshot } from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';

type Queryable = Pool | PoolClient;

export interface ShipmentRow {
  id: string;
  number: string;
  leg: ShipmentLeg;
  salesOrderId: string;
  workPackageId: string | null;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  shipperOrganizationId: string;
  shipperDisplayName: string;
  consigneeOrganizationId: string;
  originSiteId: string | null;
  destinationSiteId: string | null;
  originSnapshot: SiteSnapshot | null;
  destinationSnapshot: SiteSnapshot | null;
  documents: { challanNumber?: string; invoiceNumber?: string; eWaybillNumber?: string };
  carrierMode: 'carrier' | 'supplier_vehicle' | 'courier' | 'jobwork_vehicle' | null;
  carrierName: string | null;
  trackingReference: string | null;
  status: ShipmentStatus;
  releaseSnapshot: Record<string, unknown> | null;
  releasedAt: Date | null;
  pickedUpAt: Date | null;
  carrierDeliveredAt: Date | null;
  returnsShipmentId: string | null;
  packingCheck: PackingCheck;
  acceptanceDueAt: Date | null;
  createdAt: Date;
  aggregateVersion: number;
}

export interface ItemRow {
  id: string;
  packageId: string;
  packageNo: number;
  lotCode: string;
  serials: string[];
  quantity: string;
  unit: string;
  description: string;
  stockLotId: string | null;
  /** The stock lot's own code (the lot quality released), behind a leg-2 marking. */
  sourceLotCode: string;
}

export interface PackageRow {
  id: string;
  packageNo: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  weightG: number | null;
}

export interface PurchaseOrderContext {
  id: string;
  number: string;
  status: string;
  salesOrderId: string;
  salesOrderStatus: string;
  supplierOrganizationId: string;
  totalMinor: number;
  totalQuantity: string;
  workPackage: { id: string; number: string; status: string } | null;
}

export interface ReceivingRow {
  id: string;
  receivedAt: Date;
  sealIntact: boolean;
  packagesReceived: number;
  packageConditions: Array<{ packageNo: number; condition: PackageCondition; note: string }>;
  decision: ReceivingDecision;
  note: string;
}

export interface ReceivingLineRow {
  itemId: string;
  lotCode: string;
  shippedQuantity: string;
  countedQuantity: string;
  acceptedQuantity: string;
  quarantinedQuantity: string;
  refusedQuantity: string;
  identityOk: boolean;
  damaged: boolean;
  note: string;
}

export interface DiscrepancyRow {
  id: string;
  number: string;
  shipmentId: string;
  kind: DiscrepancyKind;
  lotCode: string;
  quantity: string;
  description: string;
  status: 'open' | 'resolved';
  resolution: DiscrepancyResolution | null;
  resolutionNote: string | null;
  caseReference: string;
  resolvedAt: Date | null;
  createdAt: Date;
}

export type LocationCode = 'JW-RECEIVING' | 'JW-QUARANTINE' | 'JW-STOCK' | 'OUT-DISPATCHED' | 'OUT-SCRAPPED' | 'OUT-RETURNED' | 'OUT-REWORK' | 'OUT-ISSUED';
export type MovementType = 'receive' | 'quarantine' | 'release' | 'pick' | 'dispatch' | 'return' | 'scrap' | 'rework_out' | 'rework_in' | 'adjust' | 'issue';

const DISCREPANCY_COLUMNS = `id, number, shipment_id AS "shipmentId", kind, lot_code AS "lotCode", quantity::text AS quantity, description, status, resolution,
  resolution_note AS "resolutionNote", case_reference AS "caseReference", resolved_at AS "resolvedAt", created_at AS "createdAt"`;

const SHIPMENT_COLUMNS = `s.id, s.number, s.leg, s.sales_order_id AS "salesOrderId", s.work_package_id AS "workPackageId", s.purchase_order_id AS "purchaseOrderId",
  po.number AS "purchaseOrderNumber", s.shipper_organization_id AS "shipperOrganizationId", o.display_name AS "shipperDisplayName",
  s.consignee_organization_id AS "consigneeOrganizationId", s.origin_site_id AS "originSiteId", s.destination_site_id AS "destinationSiteId",
  s.origin_snapshot AS "originSnapshot", s.destination_snapshot AS "destinationSnapshot", s.documents, s.carrier_mode AS "carrierMode",
  s.carrier_name AS "carrierName", s.tracking_reference AS "trackingReference", s.status, s.release_snapshot AS "releaseSnapshot",
  s.released_at AS "releasedAt", s.picked_up_at AS "pickedUpAt", s.carrier_delivered_at AS "carrierDeliveredAt", s.created_at AS "createdAt",
  s.returns_shipment_id AS "returnsShipmentId", s.packing_check AS "packingCheck", s.acceptance_due_at AS "acceptanceDueAt",
  s.aggregate_version AS "aggregateVersion"`;
const SHIPMENT_FROM = `FROM logistics.shipment s
  JOIN iam.organization o ON o.id = s.shipper_organization_id
  LEFT JOIN orders.purchase_order po ON po.id = s.purchase_order_id`;

/** Statuses in which a leg-1 shipment's items count against what quality released. */
export const LIVE_STATUSES: readonly ShipmentStatus[] = ['released', 'picked_up', 'in_transit', 'delivered_to_destination', 'receiving_check', 'accepted', 'discrepancy_hold'];

/** The logistics module's SQL (IN-16). */
@Injectable()
export class LogisticsRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  async allocateNumber(prefix: 'SH' | 'RD', table: 'shipment' | 'receiving_discrepancy', now: Date, tx: Queryable): Promise<string> {
    const year = now.getUTCFullYear();
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`logistics.${table}.number`]);
    const res = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(NULLIF(split_part(number, '-', 3), '')::int), 0) + 1 AS next FROM logistics.${table} WHERE number LIKE $1`,
      [`${prefix}-${year}-%`],
    );
    return `${prefix}-${year}-${String(res.rows[0]!.next).padStart(4, '0')}`;
  }

  // ----------------------------------------------------------------- context

  async purchaseOrder(id: string, tx?: Queryable): Promise<PurchaseOrderContext | null> {
    const res = await this.q(tx).query<Omit<PurchaseOrderContext, 'workPackage'> & { wpId: string | null; wpNumber: string | null; wpStatus: string | null }>(
      `SELECT po.id, po.number, po.status, po.sales_order_id AS "salesOrderId", so.status AS "salesOrderStatus", po.supplier_organization_id AS "supplierOrganizationId",
              po.total_minor::int AS "totalMinor", (SELECT COALESCE(SUM(quantity), 0)::text FROM orders.purchase_order_line WHERE purchase_order_id = po.id) AS "totalQuantity",
              w.id AS "wpId", w.number AS "wpNumber", w.status AS "wpStatus"
         FROM orders.purchase_order po
         JOIN orders.sales_order so ON so.id = po.sales_order_id
         LEFT JOIN orders.work_package w ON w.purchase_order_id = po.id
        WHERE po.id = $1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) return null;
    const { wpId, wpNumber, wpStatus, ...rest } = r;
    return { ...rest, workPackage: wpId ? { id: wpId, number: wpNumber!, status: wpStatus! } : null };
  }

  async workPackage(id: string, tx?: Queryable): Promise<{ id: string; number: string; salesOrderId: string } | null> {
    const res = await this.q(tx).query<{ id: string; number: string; salesOrderId: string }>(`SELECT id, number, sales_order_id AS "salesOrderId" FROM orders.work_package WHERE id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  async lockWorkPackage(workPackageId: string, tx: Queryable): Promise<void> {
    await tx.query(`SELECT id FROM orders.work_package WHERE id = $1 FOR UPDATE`, [workPackageId]);
  }

  async supplierActive(organizationId: string, tx?: Queryable): Promise<boolean> {
    const res = await this.q(tx).query(`SELECT 1 FROM supplier.supplier_profile WHERE organization_id = $1 AND status = 'active'`, [organizationId]);
    return (res.rowCount ?? 0) > 0;
  }

  async site(id: string, tx?: Queryable): Promise<(SiteSnapshot & { id: string; organizationId: string; kind: string; status: string }) | null> {
    const res = await this.q(tx).query<SiteSnapshot & { id: string; organizationId: string; kind: string; status: string }>(
      `SELECT id, organization_id AS "organizationId", kind, status, label, address_line1 AS "addressLine1", address_line2 AS "addressLine2", city, state,
              postal_code AS "postalCode", country_code AS "countryCode", contact_name AS "contactName", contact_phone AS "contactPhone"
         FROM iam.organization_site WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  /** An organization's first active site, works before pickup before the rest; `worksOnly` for a supplier's destination. */
  async firstSite(organizationId: string, worksOnly: boolean, tx?: Queryable): Promise<string | null> {
    const res = await this.q(tx).query<{ id: string }>(
      `SELECT id FROM iam.organization_site WHERE organization_id = $1 AND status = 'active' AND (NOT $2 OR kind IN ('works', 'pickup'))
        ORDER BY CASE kind WHEN 'works' THEN 0 WHEN 'pickup' THEN 1 ELSE 2 END, created_at LIMIT 1`,
      [organizationId, worksOnly],
    );
    return res.rows[0]?.id ?? null;
  }

  /** A customer's active addresses, delivery addresses first. */
  async customerSites(organizationId: string, tx?: Queryable): Promise<Array<SiteSnapshot & { id: string }>> {
    const res = await this.q(tx).query<SiteSnapshot & { id: string }>(
      `SELECT id, label, address_line1 AS "addressLine1", address_line2 AS "addressLine2", city, state, postal_code AS "postalCode", country_code AS "countryCode",
              contact_name AS "contactName", contact_phone AS "contactPhone"
         FROM iam.organization_site WHERE organization_id = $1 AND status = 'active' ORDER BY created_at`,
      [organizationId],
    );
    return res.rows;
  }

  /** JobWork's receiving hub: the internal organization's first active works site. */
  async hubSite(tx?: Queryable): Promise<{ id: string; organizationId: string } | null> {
    const res = await this.q(tx).query<{ id: string; organizationId: string }>(
      `SELECT s.id, s.organization_id AS "organizationId" FROM iam.organization_site s JOIN iam.organization o ON o.id = s.organization_id
        WHERE o.type = 'internal' AND s.kind = 'works' AND s.status = 'active' ORDER BY s.created_at LIMIT 1`,
    );
    return res.rows[0] ?? null;
  }

  // ----------------------------------------------------------------- shipments

  async insert(
    input: {
      number: string;
      leg: ShipmentLeg;
      salesOrderId: string;
      workPackageId: string | null;
      purchaseOrderId: string | null;
      shipperOrganizationId: string;
      consigneeOrganizationId: string;
      originSiteId: string | null;
      destinationSiteId: string | null;
      documents: Record<string, string>;
      by: string;
      returnsShipmentId?: string | null;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO logistics.shipment (number, leg, sales_order_id, work_package_id, purchase_order_id, shipper_organization_id, consignee_organization_id, origin_site_id, destination_site_id, documents, created_by, returns_shipment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [input.number, input.leg, input.salesOrderId, input.workPackageId, input.purchaseOrderId, input.shipperOrganizationId, input.consigneeOrganizationId, input.originSiteId, input.destinationSiteId, JSON.stringify(input.documents), input.by, input.returnsShipmentId ?? null],
    );
    return res.rows[0]!.id;
  }

  async find(id: string, tx?: Queryable, forUpdate = false): Promise<ShipmentRow | null> {
    const res = await this.q(tx).query<ShipmentRow>(`SELECT ${SHIPMENT_COLUMNS} ${SHIPMENT_FROM} WHERE s.id = $1 ${forUpdate ? 'FOR UPDATE OF s' : ''}`, [id]);
    return res.rows[0] ?? null;
  }

  async findByTracking(reference: string, tx?: Queryable): Promise<ShipmentRow | null> {
    const res = await this.q(tx).query<ShipmentRow>(`SELECT ${SHIPMENT_COLUMNS} ${SHIPMENT_FROM} WHERE s.tracking_reference = $1 OR s.number = $1 ORDER BY s.created_at DESC LIMIT 1`, [reference]);
    return res.rows[0] ?? null;
  }

  /** `partyOrganizationId`: what an outside organization may see — what it ships, and material JobWork issues to it. */
  async list(filter: { partyOrganizationId?: string; workPackageId?: string; salesOrderId?: string; statuses?: readonly ShipmentStatus[]; leg?: ShipmentLeg }, tx?: Queryable): Promise<ShipmentRow[]> {
    const res = await this.q(tx).query<ShipmentRow>(
      `SELECT ${SHIPMENT_COLUMNS} ${SHIPMENT_FROM}
        WHERE ($1::uuid IS NULL OR s.shipper_organization_id = $1 OR (s.leg = 'jobwork_to_supplier' AND s.consignee_organization_id = $1)) AND ($2::uuid IS NULL OR s.work_package_id = $2)
          AND ($3::uuid IS NULL OR s.sales_order_id = $3) AND ($4::text[] IS NULL OR s.status = ANY($4)) AND ($5::text IS NULL OR s.leg = $5)
        ORDER BY s.created_at DESC LIMIT 200`,
      [filter.partyOrganizationId ?? null, filter.workPackageId ?? null, filter.salesOrderId ?? null, filter.statuses ?? null, filter.leg ?? null],
    );
    return res.rows;
  }

  /** A customer's own deliveries (leg 2), never a cancelled or unplanned one. */
  async customerDeliveries(customerOrganizationId: string, salesOrderId: string | null, tx?: Queryable): Promise<ShipmentRow[]> {
    const res = await this.q(tx).query<ShipmentRow>(
      `SELECT ${SHIPMENT_COLUMNS} ${SHIPMENT_FROM}
        WHERE s.leg = 'jobwork_to_customer' AND s.consignee_organization_id = $1 AND ($2::uuid IS NULL OR s.sales_order_id = $2)
          AND s.status NOT IN ('draft', 'cancelled')
        ORDER BY s.created_at DESC LIMIT 200`,
      [customerOrganizationId, salesOrderId],
    );
    return res.rows;
  }

  async update(
    id: string,
    fields: Partial<{
      status: ShipmentStatus;
      originSiteId: string;
      documents: Record<string, string>;
      originSnapshot: SiteSnapshot;
      destinationSnapshot: SiteSnapshot;
      releaseSnapshot: Record<string, unknown>;
      releasedBy: string;
      releasedAt: Date;
      carrierMode: string;
      carrierName: string;
      trackingReference: string;
      pickedUpAt: Date;
      carrierDeliveredAt: Date;
      destinationSiteId: string;
      packingCheck: PackingCheck;
      acceptanceDueAt: Date;
    }>,
    tx: Queryable,
  ): Promise<number> {
    const res = await tx.query<{ aggregate_version: number }>(
      `UPDATE logistics.shipment
          SET status = COALESCE($2, status), origin_site_id = COALESCE($3, origin_site_id), documents = COALESCE($4::jsonb, documents),
              origin_snapshot = COALESCE($5::jsonb, origin_snapshot), destination_snapshot = COALESCE($6::jsonb, destination_snapshot),
              release_snapshot = COALESCE($7::jsonb, release_snapshot), released_by = COALESCE($8, released_by), released_at = COALESCE($9, released_at),
              carrier_mode = COALESCE($10, carrier_mode), carrier_name = COALESCE($11, carrier_name), tracking_reference = COALESCE($12, tracking_reference),
              picked_up_at = COALESCE($13, picked_up_at), carrier_delivered_at = COALESCE($14, carrier_delivered_at),
              destination_site_id = COALESCE($15, destination_site_id), packing_check = COALESCE($16::jsonb, packing_check),
              acceptance_due_at = COALESCE($17, acceptance_due_at),
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1 RETURNING aggregate_version`,
      [
        id,
        fields.status ?? null,
        fields.originSiteId ?? null,
        fields.documents ? JSON.stringify(fields.documents) : null,
        fields.originSnapshot ? JSON.stringify(fields.originSnapshot) : null,
        fields.destinationSnapshot ? JSON.stringify(fields.destinationSnapshot) : null,
        fields.releaseSnapshot ? JSON.stringify(fields.releaseSnapshot) : null,
        fields.releasedBy ?? null,
        fields.releasedAt ?? null,
        fields.carrierMode ?? null,
        fields.carrierName ?? null,
        fields.trackingReference ?? null,
        fields.pickedUpAt ?? null,
        fields.carrierDeliveredAt ?? null,
        fields.destinationSiteId ?? null,
        fields.packingCheck ? JSON.stringify(fields.packingCheck) : null,
        fields.acceptanceDueAt ?? null,
      ],
    );
    return res.rows[0]!.aggregate_version;
  }

  /** `stockLotIds` maps an item (by package and position) to the JobWork lot it is picked from, for legs that start at JobWork. */
  async replaceContents(shipmentId: string, packages: readonly PackageInput[], tx: Queryable, stockLotIds?: ReadonlyArray<ReadonlyArray<string | null>>): Promise<void> {
    await tx.query(`DELETE FROM logistics.shipment_item WHERE shipment_id = $1`, [shipmentId]);
    await tx.query(`DELETE FROM logistics.shipment_package WHERE shipment_id = $1`, [shipmentId]);
    for (const p of packages) {
      const pkg = await tx.query<{ id: string }>(
        `INSERT INTO logistics.shipment_package (shipment_id, package_no, length_mm, width_mm, height_mm, weight_g) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [shipmentId, p.packageNo, p.lengthMm, p.widthMm, p.heightMm, p.weightG],
      );
      for (const [k, i] of p.items.entries()) {
        await tx.query(
          `INSERT INTO logistics.shipment_item (shipment_id, package_id, lot_code, serials, quantity, unit, description, stock_lot_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [shipmentId, pkg.rows[0]!.id, i.lotCode, i.serials, i.quantity, i.unit, i.description, stockLotIds?.[packages.indexOf(p)]?.[k] ?? null],
        );
      }
    }
  }

  async packages(shipmentId: string, tx?: Queryable): Promise<PackageRow[]> {
    const res = await this.q(tx).query<PackageRow>(
      `SELECT id, package_no AS "packageNo", length_mm AS "lengthMm", width_mm AS "widthMm", height_mm AS "heightMm", weight_g AS "weightG"
         FROM logistics.shipment_package WHERE shipment_id = $1 ORDER BY package_no`,
      [shipmentId],
    );
    return res.rows;
  }

  async items(shipmentId: string, tx?: Queryable): Promise<ItemRow[]> {
    const res = await this.q(tx).query<ItemRow>(
      `SELECT i.id, i.package_id AS "packageId", p.package_no AS "packageNo", i.lot_code AS "lotCode", i.serials, i.quantity::text AS quantity, i.unit, i.description,
              i.stock_lot_id AS "stockLotId", COALESCE(t.lot_code, '') AS "sourceLotCode"
         FROM logistics.shipment_item i JOIN logistics.shipment_package p ON p.id = i.package_id
         LEFT JOIN logistics.stock_lot t ON t.id = i.stock_lot_id
        WHERE i.shipment_id = $1 ORDER BY p.package_no, i.lot_code`,
      [shipmentId],
    );
    return res.rows;
  }

  /** Items on the work package's other live leg-1 shipments: what quality release has already sent. */
  async shippedBefore(workPackageId: string, excludeShipmentId: string, tx?: Queryable): Promise<Array<{ lotCode: string; quantity: string }>> {
    const res = await this.q(tx).query<{ lotCode: string; quantity: string }>(
      `SELECT i.lot_code AS "lotCode", i.quantity::text AS quantity
         FROM logistics.shipment_item i JOIN logistics.shipment s ON s.id = i.shipment_id
        WHERE s.work_package_id = $1 AND s.id <> $2 AND s.leg = 'supplier_to_jobwork' AND s.status = ANY($3)`,
      [workPackageId, excludeShipmentId, LIVE_STATUSES],
    );
    return res.rows;
  }

  // ----------------------------------------------------------------- carrier events

  /** Idempotent by the provider's event id: a repeat records nothing and returns null. */
  async insertCarrierEvent(
    input: { shipmentId: string; provider: string; providerEventId: string; rawStatus: string; normalizedStatus: string; occurredAt: Date; raw: Record<string, unknown>; by: string | null },
    tx: Queryable,
  ): Promise<string | null> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO logistics.carrier_event (shipment_id, provider, provider_event_id, raw_status, normalized_status, occurred_at, raw, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
      [input.shipmentId, input.provider, input.providerEventId, input.rawStatus, input.normalizedStatus, input.occurredAt, JSON.stringify(input.raw), input.by],
    );
    return res.rows[0]?.id ?? null;
  }

  // ----------------------------------------------------------------- receiving

  /** A clean, available document version JobWork owns (receiving photos). */
  async ownCleanVersion(documentVersionId: string, organizationId: string, tx?: Queryable): Promise<boolean> {
    const res = await this.q(tx).query(
      `SELECT 1 FROM dms.document_version v JOIN dms.document d ON d.id = v.document_id JOIN dms.file_object f ON f.id = v.file_object_id
        WHERE v.id = $1 AND d.owning_organization_id = $2 AND v.status = 'available' AND f.scan_state = 'clean'`,
      [documentVersionId, organizationId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async insertReceiving(
    input: { shipmentId: string; by: string; siteId: string | null; sealIntact: boolean; packagesReceived: number; packageConditions: ReceivingRow['packageConditions']; photos: string[]; decision: ReceivingDecision; note: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO logistics.receiving_record (shipment_id, received_by, site_id, seal_intact, packages_received, package_conditions, photo_document_version_ids, decision, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [input.shipmentId, input.by, input.siteId, input.sealIntact, input.packagesReceived, JSON.stringify(input.packageConditions), input.photos, input.decision, input.note],
    );
    return res.rows[0]!.id;
  }

  async insertReceivingLine(
    input: { receivingId: string; itemId: string; shipped: string; counted: string; accepted: string; quarantined: string; refused: string; identityOk: boolean; damaged: boolean; note: string },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO logistics.receiving_line (receiving_id, shipment_item_id, shipped_quantity, counted_quantity, accepted_quantity, quarantined_quantity, refused_quantity, identity_ok, damaged, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [input.receivingId, input.itemId, input.shipped, input.counted, input.accepted, input.quarantined, input.refused, input.identityOk, input.damaged, input.note],
    );
  }

  async receiving(shipmentId: string, tx?: Queryable): Promise<{ record: ReceivingRow; lines: ReceivingLineRow[] } | null> {
    const rec = await this.q(tx).query<ReceivingRow>(
      `SELECT id, received_at AS "receivedAt", seal_intact AS "sealIntact", packages_received AS "packagesReceived", package_conditions AS "packageConditions", decision, note
         FROM logistics.receiving_record WHERE shipment_id = $1`,
      [shipmentId],
    );
    const record = rec.rows[0];
    if (!record) return null;
    const lines = await this.q(tx).query<ReceivingLineRow>(
      `SELECT l.shipment_item_id AS "itemId", i.lot_code AS "lotCode", l.shipped_quantity::text AS "shippedQuantity", l.counted_quantity::text AS "countedQuantity",
              l.accepted_quantity::text AS "acceptedQuantity", l.quarantined_quantity::text AS "quarantinedQuantity", l.refused_quantity::text AS "refusedQuantity",
              l.identity_ok AS "identityOk", l.damaged, l.note
         FROM logistics.receiving_line l JOIN logistics.shipment_item i ON i.id = l.shipment_item_id
         JOIN logistics.shipment_package p ON p.id = i.package_id
        WHERE l.receiving_id = $1 ORDER BY p.package_no, i.lot_code`,
      [record.id],
    );
    return { record, lines: lines.rows };
  }

  async insertDiscrepancy(input: { number: string; shipmentId: string; receivingId: string; kind: DiscrepancyKind; lotCode: string; quantity: string; description: string }, tx: Queryable): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO logistics.receiving_discrepancy (number, shipment_id, receiving_id, kind, lot_code, quantity, description) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.number, input.shipmentId, input.receivingId, input.kind, input.lotCode, input.quantity, input.description],
    );
    return res.rows[0]!.id;
  }

  async discrepancies(shipmentId: string, tx?: Queryable): Promise<DiscrepancyRow[]> {
    const res = await this.q(tx).query<DiscrepancyRow>(`SELECT ${DISCREPANCY_COLUMNS} FROM logistics.receiving_discrepancy WHERE shipment_id = $1 ORDER BY number`, [shipmentId]);
    return res.rows;
  }

  async findDiscrepancy(id: string, tx?: Queryable, forUpdate = false): Promise<DiscrepancyRow | null> {
    const res = await this.q(tx).query<DiscrepancyRow>(`SELECT ${DISCREPANCY_COLUMNS} FROM logistics.receiving_discrepancy WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id]);
    return res.rows[0] ?? null;
  }

  async resolveDiscrepancy(id: string, input: { resolution: DiscrepancyResolution; note: string; caseReference: string; by: string }, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE logistics.receiving_discrepancy SET status = 'resolved', resolution = $2, resolution_note = $3, case_reference = $4, resolved_by = $5, resolved_at = now() WHERE id = $1`,
      [id, input.resolution, input.note, input.caseReference, input.by],
    );
  }

  // ----------------------------------------------------------------- custody ledger

  /** The lot carries the order's released production baseline: the revision it was made to. */
  async insertStockLot(
    input: { lotCode: string; serials: string[]; salesOrderId: string; workPackageId: string | null; sourceShipmentId: string; receivedQuantity: string; unit: string; ownership: 'jobwork' | 'customer_material'; by: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO logistics.stock_lot (lot_code, serials, sales_order_id, work_package_id, baseline_id, source_shipment_id, received_quantity, unit, ownership, created_by)
       VALUES ($1, $2, $3, $4, (SELECT id FROM dms.baseline WHERE sales_order_id = $3 AND kind = 'production' AND status = 'released' ORDER BY released_at DESC LIMIT 1), $5, $6, $7, $8, $9) RETURNING id`,
      [input.lotCode, input.serials, input.salesOrderId, input.workPackageId, input.sourceShipmentId, input.receivedQuantity, input.unit, input.ownership, input.by],
    );
    return res.rows[0]!.id;
  }

  async lotFor(shipmentId: string, lotCode: string, tx?: Queryable): Promise<{ id: string } | null> {
    const res = await this.q(tx).query<{ id: string }>(`SELECT id FROM logistics.stock_lot WHERE source_shipment_id = $1 AND lot_code = $2`, [shipmentId, lotCode]);
    return res.rows[0] ?? null;
  }

  async lot(id: string, tx?: Queryable): Promise<{ id: string; lotCode: string; unit: string; ownership: 'jobwork' | 'customer_material'; salesOrderId: string } | null> {
    const res = await this.q(tx).query<{ id: string; lotCode: string; unit: string; ownership: 'jobwork' | 'customer_material'; salesOrderId: string }>(
      `SELECT id, lot_code AS "lotCode", unit, ownership, sales_order_id AS "salesOrderId" FROM logistics.stock_lot WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  /** Customer material on an order, with what is in stock, quarantined and issued (D-15). */
  async materialLots(salesOrderId: string, tx?: Queryable): Promise<Array<{ id: string; lotCode: string; unit: string; shipmentNumber: string; receivedQuantity: string; inStock: string; quarantined: string; issued: string }>> {
    const at = (code: string) =>
      `(SELECT COALESCE(SUM(b.quantity), 0) FROM logistics.stock_balance b JOIN logistics.custody_location c ON c.id = b.location_id WHERE b.lot_id = t.id AND c.code = '${code}')::text`;
    const res = await this.q(tx).query<{ id: string; lotCode: string; unit: string; shipmentNumber: string; receivedQuantity: string; inStock: string; quarantined: string; issued: string }>(
      `SELECT t.id, t.lot_code AS "lotCode", t.unit, s.number AS "shipmentNumber", t.received_quantity::text AS "receivedQuantity",
              ${at('JW-STOCK')} AS "inStock", ${at('JW-QUARANTINE')} AS quarantined, ${at('OUT-ISSUED')} AS issued
         FROM logistics.stock_lot t JOIN logistics.shipment s ON s.id = t.source_shipment_id
        WHERE t.sales_order_id = $1 AND t.ownership = 'customer_material' ORDER BY t.created_at, t.lot_code`,
      [salesOrderId],
    );
    return res.rows;
  }

  /** One ledger movement; the database refuses an over-draw or over-receipt. */
  async move(
    input: { lotId: string; from: LocationCode | null; to: LocationCode; quantity: string; type: MovementType; source: string; evidence: Record<string, unknown>; by: string },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO logistics.stock_movement (lot_id, from_location_id, to_location_id, quantity, type, operation, evidence, created_by)
       VALUES ($1, (SELECT id FROM logistics.custody_location WHERE code = $2), (SELECT id FROM logistics.custody_location WHERE code = $3), $4, $5, $6, $7, $8)`,
      [input.lotId, input.from, input.to, input.quantity, input.type, input.source, JSON.stringify(input.evidence), input.by],
    );
  }

  async balance(lotId: string, location: LocationCode, tx?: Queryable): Promise<string> {
    const res = await this.q(tx).query<{ quantity: string }>(
      `SELECT COALESCE(SUM(b.quantity), 0)::text AS quantity FROM logistics.stock_balance b JOIN logistics.custody_location l ON l.id = b.location_id WHERE b.lot_id = $1 AND l.code = $2`,
      [lotId, location],
    );
    return res.rows[0]!.quantity;
  }

  /** Doc 19 §8 quantities for one work package, from the shipments and the ledger. */
  async workPackageQuantities(workPackageId: string, tx?: Queryable): Promise<{ ordered: string; shipped: string; received: string; accepted: string; quarantined: string; scrapped: string; returned: string }> {
    const res = await this.q(tx).query<{ ordered: string; shipped: string; received: string; accepted: string; quarantined: string; scrapped: string; returned: string }>(
      `SELECT
         (SELECT COALESCE(SUM(pl.quantity), 0) FROM orders.work_package w JOIN orders.purchase_order_line pl ON pl.purchase_order_id = w.purchase_order_id WHERE w.id = $1)::text AS ordered,
         (SELECT COALESCE(SUM(i.quantity), 0) FROM logistics.shipment_item i JOIN logistics.shipment s ON s.id = i.shipment_id
           WHERE s.work_package_id = $1 AND s.leg = 'supplier_to_jobwork' AND s.status = ANY($2))::text AS shipped,
         (SELECT COALESCE(SUM(l.counted_quantity), 0) FROM logistics.receiving_line l JOIN logistics.receiving_record r ON r.id = l.receiving_id
            JOIN logistics.shipment s ON s.id = r.shipment_id WHERE s.work_package_id = $1 AND s.leg = 'supplier_to_jobwork')::text AS received,
         (SELECT COALESCE(SUM(m.quantity), 0) FROM logistics.stock_movement m JOIN logistics.stock_lot t ON t.id = m.lot_id
            JOIN logistics.custody_location c ON c.id = m.to_location_id WHERE t.work_package_id = $1 AND t.ownership = 'jobwork' AND c.code = 'JW-STOCK'
              AND m.from_location_id IS DISTINCT FROM (SELECT id FROM logistics.custody_location WHERE code = 'JW-STOCK'))::text AS accepted,
         ${['JW-QUARANTINE', 'OUT-SCRAPPED', 'OUT-RETURNED']
           .map(
             (code, i) => `(SELECT COALESCE(SUM(b.quantity), 0) FROM logistics.stock_balance b JOIN logistics.stock_lot t ON t.id = b.lot_id
            JOIN logistics.custody_location c ON c.id = b.location_id WHERE t.work_package_id = $1 AND t.ownership = 'jobwork' AND c.code = '${code}')::text AS ${['quarantined', 'scrapped', 'returned'][i]}`,
           )
           .join(',\n         ')}`,
      [workPackageId, LIVE_STATUSES],
    );
    return res.rows[0]!;
  }

  async lotsForWorkPackage(workPackageId: string, tx?: Queryable): Promise<Array<{ id: string; lotCode: string; shipmentNumber: string; receivedQuantity: string; ownership: 'jobwork' | 'customer_material'; balances: Array<{ code: string; label: string; onHand: boolean; quantity: string }> }>> {
    const res = await this.q(tx).query<{ id: string; lotCode: string; shipmentNumber: string; receivedQuantity: string; ownership: 'jobwork' | 'customer_material'; balances: Array<{ code: string; label: string; onHand: boolean; quantity: string }> }>(
      `SELECT t.id, t.lot_code AS "lotCode", s.number AS "shipmentNumber", t.received_quantity::text AS "receivedQuantity", t.ownership,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('code', c.code, 'label', c.label, 'onHand', c.on_hand, 'quantity', b.quantity::text) ORDER BY c.code)
                          FROM logistics.stock_balance b JOIN logistics.custody_location c ON c.id = b.location_id WHERE b.lot_id = t.id AND b.quantity <> 0), '[]') AS balances
         FROM logistics.stock_lot t JOIN logistics.shipment s ON s.id = t.source_shipment_id
        WHERE t.work_package_id = $1 ORDER BY t.created_at, t.lot_code`,
      [workPackageId],
    );
    return res.rows;
  }

  /** The work packages of an order with what is ordered and accepted of each (doc 06 §7 `received_jobwork`). */
  async orderAcceptance(salesOrderId: string, tx?: Queryable): Promise<Array<{ workPackageId: string; ordered: string; accepted: string }>> {
    const res = await this.q(tx).query<{ workPackageId: string }>(`SELECT w.id AS "workPackageId" FROM orders.work_package w JOIN orders.purchase_order po ON po.id = w.purchase_order_id WHERE po.sales_order_id = $1 AND po.status <> 'cancelled'`, [salesOrderId]);
    const out: Array<{ workPackageId: string; ordered: string; accepted: string }> = [];
    for (const r of res.rows) {
      const q = await this.workPackageQuantities(r.workPackageId, tx);
      out.push({ workPackageId: r.workPackageId, ordered: q.ordered, accepted: q.accepted });
    }
    return out;
  }

  async carrierEvents(shipmentId: string, tx?: Queryable): Promise<Array<{ normalizedStatus: string; rawStatus: string; occurredAt: Date; provider: string }>> {
    const res = await this.q(tx).query<{ normalizedStatus: string; rawStatus: string; occurredAt: Date; provider: string }>(
      `SELECT normalized_status AS "normalizedStatus", raw_status AS "rawStatus", occurred_at AS "occurredAt", provider FROM logistics.carrier_event WHERE shipment_id = $1 ORDER BY occurred_at`,
      [shipmentId],
    );
    return res.rows;
  }

  // ----------------------------------------------------------------- leg 2 (IN-17)

  /** A stock lot with what leg 2 needs: whose it is, where it came from, and the work package it was made on. */
  async lotDetail(id: string, tx?: Queryable): Promise<{ id: string; lotCode: string; unit: string; serials: string[]; ownership: 'jobwork' | 'customer_material'; salesOrderId: string; workPackageId: string | null; workPackageNumber: string; sourceShipmentId: string; sourceShipmentNumber: string } | null> {
    const res = await this.q(tx).query<{ id: string; lotCode: string; unit: string; serials: string[]; ownership: 'jobwork' | 'customer_material'; salesOrderId: string; workPackageId: string | null; workPackageNumber: string; sourceShipmentId: string; sourceShipmentNumber: string }>(
      `SELECT t.id, t.lot_code AS "lotCode", t.unit, t.serials, t.ownership, t.sales_order_id AS "salesOrderId", t.work_package_id AS "workPackageId",
              COALESCE(w.number, '') AS "workPackageNumber", t.source_shipment_id AS "sourceShipmentId", s.number AS "sourceShipmentNumber"
         FROM logistics.stock_lot t JOIN logistics.shipment s ON s.id = t.source_shipment_id LEFT JOIN orders.work_package w ON w.id = t.work_package_id
        WHERE t.id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async openDiscrepancyCount(shipmentId: string, tx?: Queryable): Promise<number> {
    const res = await this.q(tx).query<{ n: number }>(`SELECT count(*)::int AS n FROM logistics.receiving_discrepancy WHERE shipment_id = $1 AND status = 'open'`, [shipmentId]);
    return res.rows[0]!.n;
  }

  /** What the order's made parts hold at `OUT-DISPATCHED`, net of anything brought back. */
  async dispatchedFromOrder(salesOrderId: string, tx?: Queryable): Promise<string> {
    const res = await this.q(tx).query<{ quantity: string }>(
      `SELECT COALESCE(SUM(b.quantity), 0)::text AS quantity FROM logistics.stock_balance b JOIN logistics.stock_lot t ON t.id = b.lot_id
         JOIN logistics.custody_location c ON c.id = b.location_id WHERE t.sales_order_id = $1 AND t.ownership = 'jobwork' AND c.code = 'OUT-DISPATCHED'`,
      [salesOrderId],
    );
    return res.rows[0]!.quantity;
  }

  /** What one released lot of a work package holds at `OUT-DISPATCHED`, across every receipt of it. */
  async dispatchedOfLot(workPackageId: string, lotCode: string, tx?: Queryable): Promise<string> {
    const res = await this.q(tx).query<{ quantity: string }>(
      `SELECT COALESCE(SUM(b.quantity), 0)::text AS quantity FROM logistics.stock_balance b JOIN logistics.stock_lot t ON t.id = b.lot_id
         JOIN logistics.custody_location c ON c.id = b.location_id WHERE t.work_package_id = $1 AND t.lot_code = $2 AND t.ownership = 'jobwork' AND c.code = 'OUT-DISPATCHED'`,
      [workPackageId, lotCode],
    );
    return res.rows[0]!.quantity;
  }

  /** The order's made-part lots that hold stock, with what other prepared leg-2 shipments have picked. */
  async dispatchableLots(salesOrderId: string, tx?: Queryable): Promise<Array<{ id: string; lotCode: string; unit: string; serials: string[]; workPackageId: string | null; workPackageNumber: string; sourceShipmentId: string; sourceShipmentNumber: string; inStock: string; onPrepared: string }>> {
    const res = await this.q(tx).query<{ id: string; lotCode: string; unit: string; serials: string[]; workPackageId: string | null; workPackageNumber: string; sourceShipmentId: string; sourceShipmentNumber: string; inStock: string; onPrepared: string }>(
      `SELECT t.id, t.lot_code AS "lotCode", t.unit, t.serials, t.work_package_id AS "workPackageId", COALESCE(w.number, '') AS "workPackageNumber",
              t.source_shipment_id AS "sourceShipmentId", src.number AS "sourceShipmentNumber",
              (SELECT COALESCE(SUM(b.quantity), 0) FROM logistics.stock_balance b JOIN logistics.custody_location c ON c.id = b.location_id WHERE b.lot_id = t.id AND c.code = 'JW-STOCK')::text AS "inStock",
              (SELECT COALESCE(SUM(i.quantity), 0) FROM logistics.shipment_item i JOIN logistics.shipment x ON x.id = i.shipment_id
                WHERE i.stock_lot_id = t.id AND x.leg = 'jobwork_to_customer' AND x.status IN ('draft', 'planned', 'ready_for_release'))::text AS "onPrepared"
         FROM logistics.stock_lot t JOIN logistics.shipment src ON src.id = t.source_shipment_id LEFT JOIN orders.work_package w ON w.id = t.work_package_id
        WHERE t.sales_order_id = $1 AND t.ownership = 'jobwork'
        ORDER BY t.created_at, t.lot_code`,
      [salesOrderId],
    );
    return res.rows;
  }

  /** The customer's delivery terms, as the enquiry recorded them (doc 14 wizard step 6). */
  async deliveryTerms(salesOrderId: string, tx?: Queryable): Promise<{ partialDelivery: 'allowed' | 'not_allowed'; packagingNote: string }> {
    const res = await this.q(tx).query<{ partialDelivery: 'allowed' | 'not_allowed'; packagingNote: string }>(
      `SELECT e.partial_delivery AS "partialDelivery", e.packaging_note AS "packagingNote" FROM orders.sales_order so JOIN sourcing.enquiry e ON e.id = so.enquiry_id WHERE so.id = $1`,
      [salesOrderId],
    );
    return res.rows[0] ?? { partialDelivery: 'not_allowed', packagingNote: '' };
  }

  /** Change requests on the order still being decided or implemented (doc 06 §9). */
  async openChanges(salesOrderId: string, tx?: Queryable): Promise<Array<{ number: string; status: string }>> {
    const res = await this.q(tx).query<{ number: string; status: string }>(
      `SELECT number, status FROM change.change_request WHERE sales_order_id = $1 AND status NOT IN ('rejected', 'withdrawn', 'verified', 'closed') ORDER BY number`,
      [salesOrderId],
    );
    return res.rows;
  }

  async insertAddressConfirmation(input: { shipmentId: string; siteId: string; snapshotHash: string; party: 'customer' | 'jobwork'; by: string; note: string }, tx: Queryable): Promise<void> {
    await tx.query(
      `INSERT INTO logistics.address_confirmation (shipment_id, site_id, snapshot_hash, party, confirmed_by, note) VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.shipmentId, input.siteId, input.snapshotHash, input.party, input.by, input.note],
    );
  }

  async latestAddressConfirmation(shipmentId: string, tx?: Queryable): Promise<{ siteId: string; snapshotHash: string; party: 'customer' | 'jobwork'; note: string; confirmedAt: Date } | null> {
    const res = await this.q(tx).query<{ siteId: string; snapshotHash: string; party: 'customer' | 'jobwork'; note: string; confirmedAt: Date }>(
      `SELECT site_id AS "siteId", snapshot_hash AS "snapshotHash", party, note, confirmed_at AS "confirmedAt" FROM logistics.address_confirmation WHERE shipment_id = $1 ORDER BY confirmed_at DESC, id DESC LIMIT 1`,
      [shipmentId],
    );
    return res.rows[0] ?? null;
  }

  async insertOverride(input: { shipmentId: string; guardKey: string; reasons: string[]; reasonsHash: string; justification: string; approvalRequestId: string; by: string }, tx: Queryable): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO logistics.dispatch_override (shipment_id, guard_key, reasons, reasons_hash, justification, approval_request_id, requested_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.shipmentId, input.guardKey, JSON.stringify(input.reasons), input.reasonsHash, input.justification, input.approvalRequestId, input.by],
    );
    return res.rows[0]!.id;
  }

  async overrides(shipmentId: string, tx?: Queryable): Promise<Array<{ id: string; guardKey: string; reasons: string[]; reasonsHash: string; justification: string; status: DispatchOverrideStatus; approvalRequestId: string; requiredRoles: string[]; requestedAt: Date; decidedAt: Date | null }>> {
    const res = await this.q(tx).query<{ id: string; guardKey: string; reasons: string[]; reasonsHash: string; justification: string; status: DispatchOverrideStatus; approvalRequestId: string; requiredRoles: string[]; requestedAt: Date; decidedAt: Date | null }>(
      `SELECT o.id, o.guard_key AS "guardKey", o.reasons, o.reasons_hash AS "reasonsHash", o.justification, o.status, o.approval_request_id AS "approvalRequestId",
              r.required_roles AS "requiredRoles", o.requested_at AS "requestedAt", o.decided_at AS "decidedAt"
         FROM logistics.dispatch_override o JOIN commercial.approval_request r ON r.id = o.approval_request_id
        WHERE o.shipment_id = $1 ORDER BY o.requested_at, o.id`,
      [shipmentId],
    );
    return res.rows;
  }

  async findOverrideByApproval(approvalRequestId: string, tx: Queryable): Promise<{ id: string; shipmentId: string; guardKey: string; status: DispatchOverrideStatus } | null> {
    const res = await tx.query<{ id: string; shipmentId: string; guardKey: string; status: DispatchOverrideStatus }>(
      `SELECT id, shipment_id AS "shipmentId", guard_key AS "guardKey", status FROM logistics.dispatch_override WHERE approval_request_id = $1 FOR UPDATE`,
      [approvalRequestId],
    );
    return res.rows[0] ?? null;
  }

  async decideOverride(id: string, status: Exclude<DispatchOverrideStatus, 'requested'>, by: string, tx: Queryable): Promise<void> {
    await tx.query(`UPDATE logistics.dispatch_override SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [id, status, by]);
  }

  /** The acceptance policy in force (FR-905): the window and the warranty statement shown with acceptance. */
  async acceptancePolicy(tx?: Queryable): Promise<{ id: string; version: number; windowDays: number; deemedAcceptance: boolean; warrantyStatement: string }> {
    const res = await this.q(tx).query<{ id: string; version: number; windowDays: number; deemedAcceptance: boolean; warrantyStatement: string }>(
      `SELECT id, version, window_days AS "windowDays", deemed_acceptance AS "deemedAcceptance", warranty_statement AS "warrantyStatement"
         FROM logistics.acceptance_policy_version WHERE effective_from <= now() ORDER BY version DESC LIMIT 1`,
    );
    return res.rows[0]!;
  }
}
