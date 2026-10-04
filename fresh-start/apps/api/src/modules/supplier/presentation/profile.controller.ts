import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  declareCertificationRequestSchema,
  declareWorksSiteRequestSchema,
  exitNetworkRequestSchema,
  setAvailabilityRequestSchema,
  updateSupplierProfileRequestSchema,
  withdrawDeclarationRequestSchema,
  type Certification,
  type SupplierSelfView,
  type SupplierSummary,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { requireOrganization } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { DeclareCertificationCommand } from '../application/declare-certification.command';
import { ExitNetworkCommand } from '../application/exit-network.command';
import { SetAvailabilityCommand } from '../application/set-availability.command';
import {
  WithdrawDeclarationCommand,
  type DeclarationKind,
} from '../application/withdraw-declaration.command';
import { OnboardingDecisionCommand } from '../application/onboarding-decision.command';
import { SupplierView } from '../application/supplier-view';
import { UpdateSupplierProfileCommand } from '../application/update-profile.command';
import { SupplierNotFound } from '../domain/errors';
import { SupplierRepository } from '../infrastructure/supplier.repository';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';

const submitSchema = z.object({ expectedVersion: z.number().int().positive() });
const declarationKindSchema = z.enum(['capability', 'machine', 'capacity']);

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/**
 * The supplier's own record (F-SO.3, F-SO.5, F-SO.6). Every route here resolves the
 * profile from the actor's organization, never from a path parameter — a supplier
 * cannot name someone else's profile because it is never asked to name one.
 */
@Controller('suppliers/me')
export class SupplierProfileController {
  constructor(
    private readonly update: UpdateSupplierProfileCommand,
    private readonly decision: OnboardingDecisionCommand,
    private readonly certification: DeclareCertificationCommand,
    private readonly availability: SetAvailabilityCommand,
    private readonly withdraw: WithdrawDeclarationCommand,
    private readonly exit: ExitNetworkCommand,
    private readonly view: SupplierView,
    private readonly repo: SupplierRepository,
  ) {}

  @Get()
  async me(@CurrentActor() actor: Actor): Promise<SupplierSelfView> {
    const organizationId = requireOrganization(actor);
    if (actor.organizationType !== 'supplier') {
      throw new NotAuthorized('Only a supplier organization has a supplier profile');
    }
    const profile = await this.repo.findProfileByOrganization(organizationId);
    if (!profile) throw new SupplierNotFound();
    return this.view.selfView(profile);
  }

  /** Dates and returns: what an admitted supplier has to act on (F-SN.2). */
  @Get('summary')
  async summary(@CurrentActor() actor: Actor): Promise<SupplierSummary> {
    const organizationId = requireOrganization(actor);
    if (actor.organizationType !== 'supplier') {
      throw new NotAuthorized('Only a supplier organization has a supplier summary');
    }
    const profile = await this.repo.findProfileByOrganization(organizationId);
    if (!profile) throw new SupplierNotFound();
    return this.view.summary(profile);
  }

  @Post('availability')
  async setAvailability(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<SupplierSelfView> {
    const body = parseBody(setAvailabilityRequestSchema, request.body);
    return this.availability.execute(actor, body, { idempotencyKey: idempotencyKey(request) });
  }

  /** Stop offering a process, a machine or a capacity window. History is untouched. */
  @Post('declarations/:kind/:declarationId/withdraw')
  async withdrawDeclaration(
    @CurrentActor() actor: Actor,
    @Param('kind') kind: string,
    @Param('declarationId') declarationId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ withdrawn: true; kind: DeclarationKind; declarationId: string }> {
    const parsed = declarationKindSchema.safeParse(kind);
    if (!parsed.success) throw new NotAuthorized('Unknown declaration kind');
    const body = parseBody(withdrawDeclarationRequestSchema, request.body ?? {});
    return this.withdraw.execute(actor, parsed.data, declarationId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post('exit')
  async exitNetwork(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<SupplierSelfView> {
    const body = parseBody(exitNetworkRequestSchema, request.body);
    return this.exit.bySupplier(actor, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post('profile')
  async updateProfile(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<SupplierSelfView> {
    const body = parseBody(updateSupplierProfileRequestSchema, request.body);
    return this.update.updateProfile(actor, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post('site')
  async declareSite(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<SupplierSelfView> {
    const body = parseBody(declareWorksSiteRequestSchema, request.body);
    return this.update.declareWorksSite(actor, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post('submit')
  async submit(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<SupplierSelfView> {
    const body = parseBody(submitSchema, request.body);
    return this.decision.submitForApproval(actor, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post('certifications')
  async declareCertification(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<Certification> {
    const body = parseBody(declareCertificationRequestSchema, request.body);
    return this.certification.execute(actor, body, { idempotencyKey: idempotencyKey(request) });
  }
}
