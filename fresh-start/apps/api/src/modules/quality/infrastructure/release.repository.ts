import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DatabaseService } from '../../../platform/database/database.service';

type Queryable = Pool | PoolClient;

export interface ReleaseRow {
  id: string;
  number: string;
  workPackageId: string;
  quantity: string;
  lots: string[];
  serials: string[];
  deviationIds: string[];
  checklist: Record<string, unknown>;
  snapshotSha256: string;
  releasedBy: string;
  releasedAt: Date;
}

/** What the release checklist reads (IN-15 F-15.4): production, inspection and NCR facts for one work package. */
@Injectable()
export class ReleaseRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  /** The baseline of the supplier's latest acknowledged transmittal. */
  async acknowledgedBaselineId(purchaseOrderId: string, tx?: Queryable): Promise<string | null> {
    const res = await this.q(tx).query<{ baseline_id: string }>(
      `SELECT baseline_id FROM dms.transmittal WHERE purchase_order_id = $1 AND status = 'acknowledged' ORDER BY acknowledged_at DESC LIMIT 1`,
      [purchaseOrderId],
    );
    return res.rows[0]?.baseline_id ?? null;
  }

  async milestones(workPackageId: string, tx?: Queryable): Promise<Array<{ title: string; status: string }>> {
    const res = await this.q(tx).query<{ title: string; status: string }>(`SELECT title, status FROM orders.milestone WHERE work_package_id = $1 ORDER BY seq`, [workPackageId]);
    return res.rows;
  }

  async orderedQuantity(purchaseOrderId: string, tx?: Queryable): Promise<string> {
    const res = await this.q(tx).query<{ total: string }>(`SELECT COALESCE(SUM(quantity), 0)::text AS total FROM orders.purchase_order_line WHERE purchase_order_id = $1`, [purchaseOrderId]);
    return res.rows[0]!.total;
  }

  /**
   * Released pieces that never reached JobWork's stock (IN-16): shipped on a received leg-1
   * shipment, less what entered stock and what quarantine still holds — short, refused, scrapped
   * or returned. The supplier still owes them, so they may be released again for a replacement.
   */
  async notDelivered(workPackageId: string, tx?: Queryable): Promise<string> {
    const res = await this.q(tx).query<{ lost: string }>(
      `SELECT GREATEST(
         (SELECT COALESCE(SUM(i.quantity), 0) FROM logistics.shipment_item i JOIN logistics.shipment s ON s.id = i.shipment_id
           WHERE s.work_package_id = $1 AND s.leg = 'supplier_to_jobwork' AND s.status IN ('receiving_check', 'accepted', 'discrepancy_hold'))
         - (SELECT COALESCE(SUM(m.quantity), 0) FROM logistics.stock_movement m JOIN logistics.stock_lot t ON t.id = m.lot_id
              JOIN logistics.custody_location c ON c.id = m.to_location_id
             WHERE t.work_package_id = $1 AND t.ownership = 'jobwork' AND c.code = 'JW-STOCK' AND m.from_location_id IS DISTINCT FROM c.id)
         - (SELECT COALESCE(SUM(b.quantity), 0) FROM logistics.stock_balance b JOIN logistics.stock_lot t ON t.id = b.lot_id
              JOIN logistics.custody_location c ON c.id = b.location_id
             WHERE t.work_package_id = $1 AND t.ownership = 'jobwork' AND c.code = 'JW-QUARANTINE'),
         0)::text AS lost`,
      [workPackageId],
    );
    return res.rows[0]!.lost;
  }

  /** Standing failed results of an inspection, with whether an approved deviation covers each. */
  async failing(inspectionId: string, tx?: Queryable): Promise<Array<{ characteristic: string; sampleNo: number; deviationExpiresAt: Date | null }>> {
    const res = await this.q(tx).query<{ characteristic: string; sampleNo: number; deviationExpiresAt: Date | null }>(
      `SELECT c.name AS characteristic, s.sample_no AS "sampleNo",
              (SELECT max(dv.expires_at) FROM quality.ncr_defect nd
                 JOIN quality.deviation dv ON dv.ncr_id = nd.ncr_id AND nd.characteristic_id = ANY(dv.characteristic_ids) AND dv.status = 'approved'
                WHERE nd.result_id = r.id) AS "deviationExpiresAt"
         FROM quality.inspection_result r
         JOIN quality.inspection_sample s ON s.id = r.sample_id
         JOIN quality.characteristic c ON c.id = r.characteristic_id
        WHERE r.inspection_id = $1 AND r.outcome = 'fail'
          AND NOT EXISTS (SELECT 1 FROM quality.inspection_result later WHERE later.supersedes_result_id = r.id)`,
      [inspectionId],
    );
    return res.rows;
  }

  async calibrationFlags(inspectionId: string, tx?: Queryable): Promise<Array<{ characteristic: string; sampleNo: number; accepted: boolean }>> {
    const res = await this.q(tx).query<{ characteristic: string; sampleNo: number; accepted: boolean }>(
      `SELECT c.name AS characteristic, s.sample_no AS "sampleNo", COALESCE(d.decision = 'accept', false) AS accepted
         FROM quality.inspection_result r
         JOIN quality.inspection_sample s ON s.id = r.sample_id
         JOIN quality.characteristic c ON c.id = r.characteristic_id
         LEFT JOIN quality.result_disposition d ON d.result_id = r.id
        WHERE r.inspection_id = $1 AND r.calibration_status IN ('expired', 'uncalibrated')
          AND NOT EXISTS (SELECT 1 FROM quality.inspection_result later WHERE later.supersedes_result_id = r.id)`,
      [inspectionId],
    );
    return res.rows;
  }

  async attachments(inspectionId: string, tx?: Queryable): Promise<Array<{ filename: string; clean: boolean }>> {
    const res = await this.q(tx).query<{ filename: string; clean: boolean }>(
      `SELECT v.original_filename AS filename, (v.status = 'available' AND f.scan_state = 'clean') AS clean
         FROM quality.inspection_attachment a
         JOIN dms.document_version v ON v.id = a.document_version_id
         JOIN dms.file_object f ON f.id = v.file_object_id
        WHERE a.inspection_id = $1`,
      [inspectionId],
    );
    return res.rows;
  }

  /** Each NCR on the work package, with the path its latest disposition took. */
  async ncrs(workPackageId: string, tx?: Queryable): Promise<Array<{ number: string; status: string; lots: string[]; outcome: string | null; openedAt: Date }>> {
    const res = await this.q(tx).query<{ number: string; status: string; lots: string[]; outcome: string | null; openedAt: Date }>(
      `SELECT n.number, n.status, n.lots, n.opened_at AS "openedAt",
              (SELECT d.outcome FROM quality.ncr_disposition d WHERE d.ncr_id = n.id ORDER BY d.attempt_no DESC LIMIT 1) AS outcome
         FROM quality.ncr n WHERE n.work_package_id = $1 ORDER BY n.opened_at`,
      [workPackageId],
    );
    return res.rows;
  }

  async activeDeviations(workPackageId: string, tx?: Queryable): Promise<Array<{ id: string; number: string; ncrNumber: string; lots: string[]; quantity: string; expiresAt: Date }>> {
    const res = await this.q(tx).query<{ id: string; number: string; ncrNumber: string; lots: string[]; quantity: string; expiresAt: Date }>(
      `SELECT d.id, d.number, n.number AS "ncrNumber", d.lots, d.quantity::text AS quantity, d.expires_at AS "expiresAt"
         FROM quality.deviation d JOIN quality.ncr n ON n.id = d.ncr_id
        WHERE n.work_package_id = $1 AND d.status = 'approved' AND d.expires_at > now()
        ORDER BY d.requested_at`,
      [workPackageId],
    );
    return res.rows;
  }

  async releases(workPackageId: string, tx?: Queryable): Promise<ReleaseRow[]> {
    const res = await this.q(tx).query<ReleaseRow>(
      `SELECT id, number, work_package_id AS "workPackageId", quantity::text AS quantity, lots, serials, deviation_ids AS "deviationIds", checklist,
              snapshot_sha256 AS "snapshotSha256", released_by AS "releasedBy", released_at AS "releasedAt"
         FROM quality.quality_release WHERE work_package_id = $1 ORDER BY released_at`,
      [workPackageId],
    );
    return res.rows;
  }

  async insert(
    input: { number: string; workPackageId: string; quantity: string; lots: string[]; serials: string[]; deviationIds: string[]; checklist: Record<string, unknown>; snapshotSha256: string; by: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO quality.quality_release (number, work_package_id, quantity, lots, serials, deviation_ids, checklist, snapshot_sha256, released_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [input.number, input.workPackageId, input.quantity, input.lots, input.serials, input.deviationIds, JSON.stringify(input.checklist), input.snapshotSha256, input.by],
    );
    return res.rows[0]!.id;
  }

  /** Serialises releases of one work package so two cannot both claim the last parts. */
  async lockWorkPackage(workPackageId: string, tx: Queryable): Promise<void> {
    await tx.query(`SELECT id FROM orders.work_package WHERE id = $1 FOR UPDATE`, [workPackageId]);
  }
}
