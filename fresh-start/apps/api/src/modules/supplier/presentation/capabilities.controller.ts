import { Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  declareCapacityRequestSchema,
  publishCapabilityRequestSchema,
  registerMachineRequestSchema,
  type CapabilityRef,
  type CapacityWindow,
  type Machine,
  type SupplierCapability,
} from '@jobwork/contracts';
import { z } from 'zod';
import type { Actor } from '../../iam';
import { requireOrganization } from '../../iam';
import {
  PublishCapabilityCommand,
  toCapability,
  toCapacity,
  toMachine,
} from '../application/publish-capability.command';
import { SupplierRepository } from '../infrastructure/supplier.repository';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';

const historyQuerySchema = z.object({
  history: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/** The supplier's own view of its declarations — full detail, its own data only. */
@Controller('suppliers/me')
export class CapabilitiesController {
  constructor(
    private readonly publish: PublishCapabilityCommand,
    private readonly repo: SupplierRepository,
  ) {}

  @Get('profile')
  async profile(@CurrentActor() actor: Actor): Promise<{
    supplierProfileId: string | null;
    status: string | null;
    regionClass: string | null;
  }> {
    const organizationId = requireOrganization(actor);
    const profile = await this.repo.findProfileByOrganization(organizationId);
    return {
      supplierProfileId: profile?.id ?? null,
      status: profile?.status ?? null,
      regionClass: profile?.regionClass ?? null,
    };
  }

  @Get('capabilities')
  async capabilities(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ capabilities: SupplierCapability[] }> {
    const organizationId = requireOrganization(actor);
    const { history } = parseBody(historyQuerySchema, query);
    const profile = await this.repo.findProfileByOrganization(organizationId);
    if (!profile) return { capabilities: [] };
    const rows = await this.repo.listSupplierCapabilities(profile.id, history);
    return { capabilities: rows.map((row) => toCapability(row)) };
  }

  @Post('capabilities')
  async publishCapability(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<SupplierCapability> {
    const body = parseBody(publishCapabilityRequestSchema, request.body);
    return this.publish.publishCapability(actor, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Get('machines')
  async machines(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ machines: Machine[] }> {
    const organizationId = requireOrganization(actor);
    const { history } = parseBody(historyQuerySchema, query);
    const profile = await this.repo.findProfileByOrganization(organizationId);
    if (!profile) return { machines: [] };
    const rows = await this.repo.listMachines(profile.id, history);
    return { machines: rows.map(toMachine) };
  }

  @Post('machines')
  async registerMachine(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<Machine> {
    const body = parseBody(registerMachineRequestSchema, request.body);
    return this.publish.registerMachine(actor, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Get('capacity')
  async capacity(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ windows: CapacityWindow[] }> {
    const organizationId = requireOrganization(actor);
    const { history } = parseBody(historyQuerySchema, query);
    const profile = await this.repo.findProfileByOrganization(organizationId);
    if (!profile) return { windows: [] };
    const rows = await this.repo.listCapacityWindows(profile.id, history);
    return { windows: rows.map(toCapacity) };
  }

  @Post('capacity')
  async declareCapacity(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<CapacityWindow> {
    const body = parseBody(declareCapacityRequestSchema, request.body);
    return this.publish.declareCapacity(actor, body, { idempotencyKey: idempotencyKey(request) });
  }

  /** The taxonomy a supplier may declare against (doc 05 §18 reference data). */
  @Get('taxonomy')
  async taxonomy(@CurrentActor() actor: Actor): Promise<{ capabilities: CapabilityRef[] }> {
    requireOrganization(actor);
    const rows = await this.repo.listTaxonomy();
    return {
      capabilities: rows.map((row) => ({
        capabilityId: row.id,
        code: row.code,
        kind: row.kind,
        label: row.label,
        parentId: row.parentId ?? null,
        isFamily: row.isFamily ?? false,
      })),
    };
  }
}
