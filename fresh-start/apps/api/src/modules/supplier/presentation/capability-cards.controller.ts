import { Controller, Get, Query } from '@nestjs/common';
import type { CapabilityCard, Eligibility } from '@jobwork/contracts';
import { z } from 'zod';
import type { Actor } from '../../iam';
import { requireOrganization } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { EligibilityProjection } from '../infrastructure/eligibility.projection';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';

const cardQuerySchema = z.object({
  capabilityCodes: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((c) => c.trim()).filter(Boolean) : undefined)),
  regionClass: z.string().trim().min(2).max(64).optional(),
  certificationTypes: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((c) => c.trim()).filter(Boolean) : undefined)),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * `FR-203`. The only supplier-shaped surface a customer may reach, and it answers with
 * anonymized capability cards: capability, coarse region, envelope, whether the
 * supplier is verified — and nothing that names, locates or contacts anyone (doc 03
 * §7: "customer cannot infer supplier identity"). Ineligible suppliers are absent
 * rather than shown as unavailable, because absence leaks less.
 *
 * Internal roles get the same projection with its exclusion reasons attached, which is
 * what makes a "no eligible supplier" answer explainable (doc 19 §4).
 */
@Controller('capability-cards')
export class CapabilityCardsController {
  constructor(private readonly projection: EligibilityProjection) {}

  @Get()
  async cards(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ cards: CapabilityCard[] }> {
    requireOrganization(actor);
    const filters = parseBody(cardQuerySchema, query);
    const records = await this.projection.query({
      ...(filters.capabilityCodes ? { capabilityCodes: filters.capabilityCodes } : {}),
      ...(filters.regionClass ? { regionClass: filters.regionClass } : {}),
      ...(filters.certificationTypes
        ? { requiredCertificationTypes: filters.certificationTypes }
        : {}),
      limit: filters.limit,
    });
    return { cards: records.filter((record) => record.eligible).map((record) => record.card) };
  }

  /** Internal view: the same rows, plus why anyone missed the filter. */
  @Get('eligibility')
  async eligibility(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ suppliers: Eligibility[] }> {
    requireOrganization(actor);
    if (!actor.isInternal) throw new NotAuthorized();
    const filters = parseBody(cardQuerySchema, query);
    const records = await this.projection.query({
      ...(filters.capabilityCodes ? { capabilityCodes: filters.capabilityCodes } : {}),
      ...(filters.regionClass ? { regionClass: filters.regionClass } : {}),
      ...(filters.certificationTypes
        ? { requiredCertificationTypes: filters.certificationTypes }
        : {}),
      limit: filters.limit,
    });
    return {
      suppliers: records.map((record) => ({
        supplierProfileId: record.supplierProfileId,
        organizationId: record.organizationId,
        eligible: record.eligible,
        exclusions: record.exclusions,
        capabilityCodes: record.capabilityCodes,
        evaluatedAt: record.evaluatedAt,
      })),
    };
  }
}
