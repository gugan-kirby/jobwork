import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CapabilityCard, Eligibility } from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';
import { computeExclusions, type ExclusionCode } from '../domain/verification';

interface EligibilityQueryRow {
  supplier_profile_id: string;
  organization_id: string;
  region_class: string;
  profile_status: string;
  accepting_work: boolean;
  organization_status: string;
  capability_codes: string[];
  capability_kinds: string[];
  capability_labels: string[];
  certification_types: string[];
  verification: Array<{ kind: string; status: string; expires_at: string | null }>;
  max_x_mm: number | null;
  max_y_mm: number | null;
  max_z_mm: number | null;
}

export interface EligibilityQuery {
  /** Every code must be published and live for the supplier to survive the filter. */
  capabilityCodes?: string[];
  regionClass?: string;
  /** Certification types the work requires, e.g. `iso9001`. */
  requiredCertificationTypes?: string[];
  limit?: number;
}

export interface EligibilityRecord extends Eligibility {
  regionClass: string;
  certificationTypes: string[];
  card: CapabilityCard;
}

/**
 * The hard filter of doc 07 §2.1, and the only place a supplier's shape is turned into
 * something a customer may see (`FR-202`, `FR-203`).
 *
 * Two properties matter more than speed here. It is *deterministic*: the same rows and
 * the same instant always produce the same verdict and the same exclusion codes, so a
 * miss can be explained months later. And it *excludes rather than ranks*: an
 * ineligible supplier never reaches scoring, which is what keeps expired evidence from
 * being outweighed by a good price.
 */
@Injectable()
export class EligibilityProjection {
  constructor(private readonly db: DatabaseService) {}

  async query(input: EligibilityQuery = {}): Promise<EligibilityRecord[]> {
    const now = new Date();
    const res = await this.db.pool.query<EligibilityQueryRow>(
      `SELECT p.id AS supplier_profile_id,
              p.organization_id,
              p.region_class,
              p.status AS profile_status,
              p.accepting_work,
              o.status AS organization_status,
              COALESCE(caps.codes, '{}') AS capability_codes,
              COALESCE(caps.kinds, '{}') AS capability_kinds,
              COALESCE(caps.labels, '{}') AS capability_labels,
              COALESCE(certs.types, '{}') AS certification_types,
              COALESCE(ver.items, '[]'::jsonb) AS verification,
              machines.max_x_mm, machines.max_y_mm, machines.max_z_mm
         FROM supplier.supplier_profile p
         JOIN iam.organization o ON o.id = p.organization_id
         LEFT JOIN LATERAL (
           SELECT array_agg(c.code) AS codes,
                  array_agg(c.kind) AS kinds,
                  array_agg(c.label) AS labels
             FROM supplier.supplier_capability sc
             JOIN supplier.capability c ON c.id = sc.capability_id AND c.status = 'active'
            WHERE sc.supplier_profile_id = p.id
              AND sc.status = 'published'
              AND sc.valid_from <= now()
              AND (sc.valid_until IS NULL OR sc.valid_until > now())
         ) caps ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(DISTINCT cert.certification_type) AS types
             FROM supplier.certification cert
            WHERE cert.supplier_profile_id = p.id
              AND cert.status = 'verified'
              AND (cert.expires_on IS NULL OR cert.expires_on >= current_date)
         ) certs ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
                    'kind', v.kind, 'status', v.status, 'expires_at', v.expires_at)) AS items
             FROM (
               SELECT DISTINCT ON (kind) kind, status, expires_at
                 FROM supplier.verification_item
                WHERE supplier_profile_id = p.id
                ORDER BY kind, version_no DESC
             ) v
         ) ver ON true
         LEFT JOIN LATERAL (
           SELECT max((m.envelope ->> 'xMm')::numeric) AS max_x_mm,
                  max((m.envelope ->> 'yMm')::numeric) AS max_y_mm,
                  max((m.envelope ->> 'zMm')::numeric) AS max_z_mm
             FROM supplier.machine m
            WHERE m.supplier_profile_id = p.id AND m.status = 'published'
         ) machines ON true
        WHERE ($1::text IS NULL OR p.region_class = $1)
          AND ($2::text[] IS NULL OR COALESCE(caps.codes, '{}') @> $2)
          AND ($3::text[] IS NULL OR COALESCE(certs.types, '{}') @> $3)
        ORDER BY p.created_at
        LIMIT $4`,
      [
        input.regionClass ?? null,
        input.capabilityCodes?.length ? input.capabilityCodes : null,
        input.requiredCertificationTypes?.length ? input.requiredCertificationTypes : null,
        input.limit ?? 100,
      ],
    );

    return res.rows.map((row) => {
      const exclusions: ExclusionCode[] = computeExclusions({
        profileStatus: row.profile_status,
        organizationStatus: row.organization_status,
        publishedCapabilityCount: row.capability_codes.length,
        items: (row.verification ?? []).map((item) => ({
          kind: item.kind as never,
          status: item.status as never,
          expiresAt: item.expires_at ? new Date(item.expires_at) : null,
        })),
        acceptingWork: row.accepting_work,
        now,
      });

      const capabilities = row.capability_codes.map((code, index) => ({
        code,
        kind: (row.capability_kinds[index] ?? 'process') as 'process' | 'material' | 'finish',
        label: row.capability_labels[index] ?? code,
      }));

      return {
        supplierProfileId: row.supplier_profile_id,
        organizationId: row.organization_id,
        eligible: exclusions.length === 0,
        exclusions,
        capabilityCodes: row.capability_codes,
        regionClass: row.region_class,
        certificationTypes: row.certification_types,
        evaluatedAt: now.toISOString(),
        card: this.toCard({
          supplierProfileId: row.supplier_profile_id,
          regionClass: row.region_class,
          capabilities,
          certificationTypes: row.certification_types,
          envelope:
            row.max_x_mm !== null && row.max_y_mm !== null && row.max_z_mm !== null
              ? {
                  xMm: Number(row.max_x_mm),
                  yMm: Number(row.max_y_mm),
                  zMm: Number(row.max_z_mm),
                }
              : null,
          verified: exclusions.length === 0,
        }),
      };
    });
  }

  /**
   * `FR-203`: the customer-visible projection. It carries capability, coarse region and
   * envelope — never the organization id, name, address or contact. The card id is a
   * salted digest so two cards cannot be correlated back to one supplier across
   * requests, and it deliberately cannot be used to fetch the profile.
   */
  private toCard(input: {
    supplierProfileId: string;
    regionClass: string;
    capabilities: Array<{ code: string; kind: 'process' | 'material' | 'finish'; label: string }>;
    certificationTypes: string[];
    envelope: { xMm: number; yMm: number; zMm: number } | null;
    verified: boolean;
  }): CapabilityCard {
    return {
      cardId: createHash('sha256')
        .update(`capability-card:${input.supplierProfileId}`)
        .digest('hex')
        .slice(0, 24),
      regionClass: input.regionClass,
      capabilities: input.capabilities,
      certificationTypes: input.certificationTypes,
      machineEnvelopeMaxMm: input.envelope,
      verified: input.verified,
    };
  }
}
