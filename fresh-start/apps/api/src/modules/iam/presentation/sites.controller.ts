import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { saveOrganizationSiteRequestSchema, type OrganizationSite } from '@jobwork/contracts';
import type { Actor } from '../application/actor';
import { SiteService } from '../application/site.service';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';

const listQuerySchema = z.object({ includeArchived: z.coerce.boolean().default(false) });

/**
 * The organization's own addresses (F-CX.3). `me` is not a convenience here: there is no
 * route that names another organization's addresses, so cross-tenant access is not a
 * check that could be forgotten — it is a route that does not exist.
 */
@Controller('organizations/me/sites')
export class SitesController {
  constructor(private readonly sites: SiteService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ sites: OrganizationSite[] }> {
    const { includeArchived } = parseBody(listQuerySchema, query ?? {});
    return { sites: await this.sites.list(actor, includeArchived) };
  }

  @Post()
  async save(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<OrganizationSite> {
    const body = parseBody(saveOrganizationSiteRequestSchema, request.body);
    return this.sites.save(actor, body);
  }

  @Post(':siteId/archive')
  async archive(
    @CurrentActor() actor: Actor,
    @Param('siteId') siteId: string,
  ): Promise<{ ok: true }> {
    await this.sites.archive(actor, siteId);
    return { ok: true };
  }
}
