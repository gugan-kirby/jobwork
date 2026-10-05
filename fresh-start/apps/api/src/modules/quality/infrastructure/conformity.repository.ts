import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DatabaseService } from '../../../platform/database/database.service';

type Queryable = Pool | PoolClient;

export interface ConformityCharacteristicRow {
  reference: string;
  name: string;
  kind: 'variable' | 'attribute';
  criticality: 'critical' | 'major' | 'minor';
  unit: string | null;
  nominal: string | null;
  lower: string | null;
  lowerInclusive: boolean | null;
  upper: string | null;
  upperInclusive: boolean | null;
  acceptedValues: string[];
  samples: number;
  min: string | null;
  max: string | null;
  allPass: boolean;
}

/**
 * The released quality record of some lots, read for a customer document (IN-17 F-17.4). Only the
 * columns a customer may read are selected: no inspecting organization, instrument, inspector,
 * method note or raw entry — the summary of what passed, against the drawing's own limits.
 */
@Injectable()
export class ConformityRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  async releases(workPackageId: string, lots: readonly string[], tx?: Queryable): Promise<Array<{ number: string; releasedAt: Date; quantity: string; lots: string[] }>> {
    const res = await this.q(tx).query<{ number: string; releasedAt: Date; quantity: string; lots: string[] }>(
      `SELECT number, released_at AS "releasedAt", quantity::text AS quantity, lots FROM quality.quality_release
        WHERE work_package_id = $1 AND (cardinality(lots) = 0 OR lots && $2::text[]) ORDER BY released_at, number`,
      [workPackageId, lots],
    );
    return res.rows;
  }

  /** Passed inspections of the lots at the stages that release them, latest results only (corrections supersede). */
  async inspections(workPackageId: string, lots: readonly string[], tx?: Queryable): Promise<Array<{ number: string; stage: string; lot: string; sampleSize: number; decidedAt: Date | null }>> {
    const res = await this.q(tx).query<{ number: string; stage: string; lot: string; sampleSize: number; decidedAt: Date | null }>(
      `SELECT number, stage, lot, sample_size AS "sampleSize", decided_at AS "decidedAt" FROM quality.inspection
        WHERE work_package_id = $1 AND lot = ANY($2::text[]) AND status = 'passed' AND stage IN ('fai', 'final', 'jobwork_incoming') ORDER BY decided_at, number`,
      [workPackageId, lots],
    );
    return res.rows;
  }

  async characteristics(workPackageId: string, lots: readonly string[], tx?: Queryable): Promise<ConformityCharacteristicRow[]> {
    const res = await this.q(tx).query<ConformityCharacteristicRow>(
      `SELECT c.drawing_reference AS reference, c.name, c.kind, c.criticality, c.unit, c.nominal::text AS nominal,
              c.lower_limit::text AS lower, c.lower_inclusive AS "lowerInclusive", c.upper_limit::text AS upper, c.upper_inclusive AS "upperInclusive",
              c.accepted_values AS "acceptedValues", count(r.id)::int AS samples, min(r.normalized_value)::text AS min, max(r.normalized_value)::text AS max,
              bool_and(r.outcome = 'pass') AS "allPass"
         FROM quality.inspection i
         JOIN quality.inspection_result r ON r.inspection_id = i.id
         JOIN quality.characteristic c ON c.id = r.characteristic_id
        WHERE i.work_package_id = $1 AND i.lot = ANY($2::text[]) AND i.status = 'passed' AND i.stage IN ('fai', 'final', 'jobwork_incoming')
          AND NOT EXISTS (SELECT 1 FROM quality.inspection_result x WHERE x.supersedes_result_id = r.id)
        GROUP BY c.id ORDER BY min(c.seq), c.name`,
      [workPackageId, lots],
    );
    return res.rows;
  }

  /** Deviations the customer accepted (or quality approved) for these lots, by number. */
  async deviations(workPackageId: string, lots: readonly string[], tx?: Queryable): Promise<Array<{ number: string; lots: string[] }>> {
    const res = await this.q(tx).query<{ number: string; lots: string[] }>(
      `SELECT d.number, d.lots FROM quality.deviation d JOIN quality.ncr n ON n.id = d.ncr_id
        WHERE n.work_package_id = $1 AND d.status = 'approved' AND (cardinality(d.lots) = 0 OR d.lots && $2::text[]) ORDER BY d.number`,
      [workPackageId, lots],
    );
    return res.rows;
  }
}
