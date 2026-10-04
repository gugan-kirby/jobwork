import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  admitSupplierRequestSchema,
  exitNetworkRequestSchema,
  supplierDecisionRequestSchema,
  supplierNegativeDecisionRequestSchema,
  type AdmitSupplierResponse,
  type SupplierDetail,
  type SupplierDirectoryRow,
  type SupplierSelfView,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { IamRepository } from '../../iam/infrastructure/iam.repository';
import { AdmitSupplierCommand } from '../application/admit-supplier.command';
import { ExitNetworkCommand } from '../application/exit-network.command';
import { OnboardingDecisionCommand } from '../application/onboarding-decision.command';
import { SupplierView } from '../application/supplier-view';
import { blockingRows } from '../domain/onboarding-checklist';
import { SupplierNotFound } from '../domain/errors';
import { assertMayDecideAdmission } from '../domain/supplier-policy';
import { computeExclusions } from '../domain/verification';
import { SupplierRepository } from '../infrastructure/supplier.repository';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';

const directoryQuerySchema = z.object({
  status: z
    .enum(['onboarding', 'submitted', 'active', 'paused', 'rejected', 'exited'])
    .optional(),
  excludedOnly: z.coerce.boolean().default(false),
});

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/**
 * The internal supplier surface (F-SO.2, F-SO.5, F-SO.8). Everything here is internal
 * audience by construction: it carries supplier names, contacts and addresses, so no
 * route on this controller may ever be reachable by a customer or by another supplier.
 */
@Controller('suppliers')
export class SuppliersController {
  constructor(
    private readonly admitCommand: AdmitSupplierCommand,
    private readonly decision: OnboardingDecisionCommand,
    private readonly exit: ExitNetworkCommand,
    private readonly view: SupplierView,
    private readonly repo: SupplierRepository,
    private readonly iam: IamRepository,
  ) {}

  private assertInternal(actor: Actor): void {
    if (!actor.isInternal) throw new NotAuthorized('Internal audience only');
  }

  @Post()
  async admit(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<AdmitSupplierResponse> {
    const body = parseBody(admitSupplierRequestSchema, request.body);
    return this.admitCommand.execute(actor, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Get()
  async directory(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ suppliers: SupplierDirectoryRow[] }> {
    this.assertInternal(actor);
    const { status, excludedOnly } = parseBody(directoryQuerySchema, query ?? {});
    const now = new Date();
    const profiles = await this.repo.listProfiles({ status });

    const rows = await Promise.all(
      profiles.map(async (profile): Promise<SupplierDirectoryRow> => {
        const [snapshot, view] = await Promise.all([
          this.repo.verificationSnapshot(profile.id),
          this.view.selfView(profile, now),
        ]);
        const exclusions = computeExclusions({
          profileStatus: profile.status,
          organizationStatus: profile.organizationStatus,
          publishedCapabilityCount: profile.capabilityCount,
          items: snapshot,
          now,
        });
        return {
          supplierProfileId: profile.id,
          organizationId: profile.organizationId,
          displayName: profile.displayName,
          legalName: profile.legalName,
          regionClass: profile.regionClass,
          status: profile.status,
          eligible: exclusions.length === 0,
          exclusions,
          capabilityCount: profile.capabilityCount,
          blockingCount: blockingRows(view.checklist).length,
          submittedAt: profile.submittedAt ? profile.submittedAt.toISOString() : null,
          updatedAt: profile.updatedAt.toISOString(),
        };
      }),
    );

    return { suppliers: excludedOnly ? rows.filter((row) => !row.eligible) : rows };
  }

  @Get(':supplierProfileId')
  async detail(
    @CurrentActor() actor: Actor,
    @Param('supplierProfileId') supplierProfileId: string,
  ): Promise<SupplierDetail> {
    this.assertInternal(actor);
    const profile = await this.repo.findProfile(supplierProfileId);
    if (!profile) throw new SupplierNotFound();
    const [view, members, pendingInvitations] = await Promise.all([
      this.view.selfView(profile),
      this.iam.listOrganizationMembers(profile.organizationId),
      this.iam.listPendingInvitations(profile.organizationId),
    ]);
    return {
      ...view,
      members,
      pendingInvitations: pendingInvitations.map((invitation) => ({
        invitationId: invitation.invitationId,
        email: invitation.email,
        expiresAt: invitation.expiresAt.toISOString(),
      })),
    };
  }

  @Post(':supplierProfileId/approve')
  async approve(
    @CurrentActor() actor: Actor,
    @Param('supplierProfileId') supplierProfileId: string,
    @Req() request: FastifyRequest,
  ): Promise<SupplierSelfView> {
    assertMayDecideAdmission(actor);
    const body = parseBody(supplierDecisionRequestSchema, request.body);
    return this.decision.decide(actor, supplierProfileId, 'approve', body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':supplierProfileId/return')
  async returnForChanges(
    @CurrentActor() actor: Actor,
    @Param('supplierProfileId') supplierProfileId: string,
    @Req() request: FastifyRequest,
  ): Promise<SupplierSelfView> {
    return this.negativeDecision(actor, supplierProfileId, 'return', request);
  }

  @Post(':supplierProfileId/reject')
  async reject(
    @CurrentActor() actor: Actor,
    @Param('supplierProfileId') supplierProfileId: string,
    @Req() request: FastifyRequest,
  ): Promise<SupplierSelfView> {
    return this.negativeDecision(actor, supplierProfileId, 'reject', request);
  }

  @Post(':supplierProfileId/suspend')
  async suspend(
    @CurrentActor() actor: Actor,
    @Param('supplierProfileId') supplierProfileId: string,
    @Req() request: FastifyRequest,
  ): Promise<SupplierSelfView> {
    return this.negativeDecision(actor, supplierProfileId, 'suspend', request);
  }

  @Post(':supplierProfileId/reinstate')
  async reinstate(
    @CurrentActor() actor: Actor,
    @Param('supplierProfileId') supplierProfileId: string,
    @Req() request: FastifyRequest,
  ): Promise<SupplierSelfView> {
    assertMayDecideAdmission(actor);
    const body = parseBody(supplierDecisionRequestSchema, request.body);
    return this.decision.decide(actor, supplierProfileId, 'reinstate', body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  /** Offboarding: terminal, confirmed by name, and never a way to skip a suspension. */
  @Post(':supplierProfileId/exit')
  async exitNetwork(
    @CurrentActor() actor: Actor,
    @Param('supplierProfileId') supplierProfileId: string,
    @Req() request: FastifyRequest,
  ): Promise<SupplierSelfView> {
    const body = parseBody(exitNetworkRequestSchema, request.body);
    return this.exit.byJobWork(actor, supplierProfileId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  /** Every outcome that costs the supplier something states why, in writing. */
  private async negativeDecision(
    actor: Actor,
    supplierProfileId: string,
    decision: 'return' | 'reject' | 'suspend',
    request: FastifyRequest,
  ): Promise<SupplierSelfView> {
    assertMayDecideAdmission(actor);
    const body = parseBody(supplierNegativeDecisionRequestSchema, request.body);
    return this.decision.decide(actor, supplierProfileId, decision, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }
}
