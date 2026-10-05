import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { PackageInput, ShipmentLeg, ShipmentStatus, SiteSnapshot } from '@jobwork/contracts';
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

const SHIPMENT_COLUMNS = `s.id, s.number, s.leg, s.sales_order_id AS "salesOrderId", s.work_package_id AS "workPackageId", s.purchase_order_id AS "purchaseOrderId",
  po.number AS "purchaseOrderNumber", s.shipper_organization_id AS "shipperOrganizationId", o.display_name AS "shipperDisplayName",
  s.consignee_organization_id AS "consigneeOrganizationId", s.origin_site_id AS "originSiteId", s.destination_site_id AS "destinationSiteId",
  s.origin_snapshot AS "originSnapshot", s.destination_snapshot AS "destinationSnapshot", s.documents, s.carrier_mode AS "carrierMode",
  s.carrier_name AS "carrierName", s.tracking_reference AS "trackingReference", s.status, s.release_snapshot AS "releaseSnapshot",
  s.released_at AS "releasedAt", s.picked_up_at AS "pickedUpAt", s.carrier_delivered_at AS "carrierDeliveredAt", s.created_at AS "createdAt",
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
    input: { number: string; leg: ShipmentLeg; salesOrderId: string; workPackageId: string | null; purchaseOrderId: string | null; shipperOrganizationId: string; consigneeOrganizationId: string; originSiteId: string | null; destinationSiteId: string | null; documents: Record<string, string>; by: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO logistics.shipment (number, leg, sales_order_id, work_package_id, purchase_order_id, shipper_organization_id, consignee_organization_id, origin_site_id, destination_site_id, documents, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [input.number, input.leg, input.salesOrderId, input.workPackageId, input.purchaseOrderId, input.shipperOrganizationId, input.consigneeOrganizationId, input.originSiteId, input.destinationSiteId, JSON.stringify(input.documents), input.by],
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

  async list(filter: { shipperOrganizationId?: string; workPackageId?: string; salesOrderId?: string; statuses?: readonly ShipmentStatus[] }, tx?: Queryable): Promise<ShipmentRow[]> {
    const res = await this.q(tx).query<ShipmentRow>(
      `SELECT ${SHIPMENT_COLUMNS} ${SHIPMENT_FROM}
        WHERE ($1::uuid IS NULL OR s.shipper_organization_id = $1) AND ($2::uuid IS NULL OR s.work_package_id = $2)
          AND ($3::uuid IS NULL OR s.sales_order_id = $3) AND ($4::text[] IS NULL OR s.status = ANY($4))
        ORDER BY s.created_at DESC LIMIT 200`,
      [filter.shipperOrganizationId ?? null, filter.workPackageId ?? null, filter.salesOrderId ?? null, filter.statuses ?? null],
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
      ],
    );
    return res.rows[0]!.aggregate_version;
  }

  async replaceContents(shipmentId: string, packages: readonly PackageInput[], tx: Queryable): Promise<void> {
    await tx.query(`DELETE FROM logistics.shipment_item WHERE shipment_id = $1`, [shipmentId]);
    await tx.query(`DELETE FROM logistics.shipment_package WHERE shipment_id = $1`, [shipmentId]);
    for (const p of packages) {
      const pkg = await tx.query<{ id: string }>(
        `INSERT INTO logistics.shipment_package (shipment_id, package_no, length_mm, width_mm, height_mm, weight_g) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [shipmentId, p.packageNo, p.lengthMm, p.widthMm, p.heightMm, p.weightG],
      );
      for (const i of p.items) {
        await tx.query(
          `INSERT INTO logistics.shipment_item (shipment_id, package_id, lot_code, serials, quantity, description) VALUES ($1, $2, $3, $4, $5, $6)`,
          [shipmentId, pkg.rows[0]!.id, i.lotCode, i.serials, i.quantity, i.description],
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
      `SELECT i.id, i.package_id AS "packageId", p.package_no AS "packageNo", i.lot_code AS "lotCode", i.serials, i.quantity::text AS quantity, i.unit, i.description
         FROM logistics.shipment_item i JOIN logistics.shipment_package p ON p.id = i.package_id
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

  async carrierEvents(shipmentId: string, tx?: Queryable): Promise<Array<{ normalizedStatus: string; rawStatus: string; occurredAt: Date; provider: string }>> {
    const res = await this.q(tx).query<{ normalizedStatus: string; rawStatus: string; occurredAt: Date; provider: string }>(
      `SELECT normalized_status AS "normalizedStatus", raw_status AS "rawStatus", occurred_at AS "occurredAt", provider FROM logistics.carrier_event WHERE shipment_id = $1 ORDER BY occurred_at`,
      [shipmentId],
    );
    return res.rows;
  }
}
