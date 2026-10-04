import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  createOrganizationRequestSchema,
  organizationStatusSchema,
  organizationTypeSchema,
  reinstateRequestSchema,
  suspensionRequestSchema,
  type OrganizationDetail,
  type OrganizationSummary,
} from '@jobwork/contracts';
import { z } from 'zod';
import type { Actor } from '../application/actor';
import { AccountService } from '../application/account.service';
import { InvitationService } from '../application/invitation.service';
import { OrganizationService } from '../application/organization.service';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';

const directoryQuerySchema = z.object({
  type: organizationTypeSchema.optional(),
  status: organizationStatusSchema.optional(),
});

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/**
 * Internal administration (F-OPS.1). Every command here has a mirror: what can be
 * suspended can be reinstated, what can be invited can be resent. A one-way
 * administrative action is one an operator learns not to use.
 */
@Controller('admin')
export class AdminController {
  constructor(
    private readonly account: AccountService,
    private readonly organizations: OrganizationService,
    private readonly invitations: InvitationService,
  ) {}

  @Post('organizations')
  async createOrganization(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<{ organizationId: string; invitationId?: string; acceptUrl?: string }> {
    this.organizations.assertAdministrator(actor);
    const body = parseBody(createOrganizationRequestSchema, request.body);
    const { organizationId } = await this.organizations.createOrganization(actor, {
      type: body.type,
      legalName: body.legalName,
      displayName: body.displayName,
    });

    // An organization nobody can sign into is a dangling row; the first invitation is
    // part of creating one, exactly as it is when a supplier is admitted (F-SO.2).
    if (!body.firstUserEmail) return { organizationId };
    const invitation = await this.invitations.inviteMember(actor, organizationId, {
      email: body.firstUserEmail,
      roleKeys: body.firstUserRoleKeys ?? ['org_admin'],
      idempotencyKey: idempotencyKey(request),
    });
    return {
      organizationId,
      invitationId: invitation.invitationId,
      ...(invitation.acceptUrl ? { acceptUrl: invitation.acceptUrl } : {}),
    };
  }

  @Get('organizations')
  async listOrganizations(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ organizations: OrganizationSummary[] }> {
    const filter = parseBody(directoryQuerySchema, query ?? {});
    return { organizations: await this.organizations.listOrganizations(actor, filter) };
  }

  @Get('organizations/:organizationId')
  async organizationDetail(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
  ): Promise<OrganizationDetail> {
    return this.organizations.getOrganization(actor, organizationId);
  }

  @Post('organizations/:organizationId/suspend')
  async suspendOrganization(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true }> {
    this.organizations.assertAdministrator(actor);
    const body = parseBody(suspensionRequestSchema, request.body);
    await this.organizations.setOrganizationStatus(actor, organizationId, 'suspended', body.reason);
    return { ok: true };
  }

  @Post('organizations/:organizationId/reinstate')
  async reinstateOrganization(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true }> {
    this.organizations.assertAdministrator(actor);
    const body = parseBody(reinstateRequestSchema, request.body ?? {});
    await this.organizations.setOrganizationStatus(actor, organizationId, 'active', body.reason);
    return { ok: true };
  }

  @Post('organizations/:organizationId/invitations/:invitationId/resend')
  async resendInvitation(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Param('invitationId') invitationId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ invitationId: string; acceptUrl?: string }> {
    return this.invitations.resendInvitation(
      actor,
      organizationId,
      invitationId,
      idempotencyKey(request),
    );
  }

  @Post('memberships/:membershipId/suspend')
  async suspendMembership(
    @CurrentActor() actor: Actor,
    @Param('membershipId') membershipId: string,
  ): Promise<{ ok: true }> {
    await this.account.suspendMembership(actor, membershipId);
    return { ok: true };
  }

  @Post('memberships/:membershipId/reinstate')
  async reinstateMembership(
    @CurrentActor() actor: Actor,
    @Param('membershipId') membershipId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true }> {
    const body = parseBody(reinstateRequestSchema, request.body ?? {});
    await this.account.reinstateMembership(actor, membershipId, body.reason);
    return { ok: true };
  }

  @Post('users/:userId/suspend')
  async suspendUser(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
  ): Promise<{ ok: true }> {
    await this.account.suspendUser(actor, userId);
    return { ok: true };
  }

  @Post('users/:userId/reinstate')
  async reinstateUser(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true }> {
    const body = parseBody(reinstateRequestSchema, request.body ?? {});
    await this.account.reinstateUser(actor, userId, body.reason);
    return { ok: true };
  }
}
