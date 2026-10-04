import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { acceptInvitationRequestSchema, inviteMemberRequestSchema } from '@jobwork/contracts';
import { z } from 'zod';
import type { Actor } from '../application/actor';
import { requireRole } from '../application/actor';
import { InvitationService } from '../application/invitation.service';
import { NotAuthorized } from '../domain/errors';
import { IamRepository } from '../infrastructure/iam.repository';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { Public } from '../../../platform/http/public.decorator';
import { parseBody } from '../../../platform/http/validation';
import { RateLimit } from '../../../platform/http/rate-limit/rate-limit.decorator';

const previewQuerySchema = z.object({ token: z.string().min(16).max(256) });

@Controller()
export class InvitationController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly repo: IamRepository,
  ) {}

  /**
   * An organization's own team: who is in it and who has been asked in. Scoped to the
   * caller's organization by construction — there is no path parameter to point
   * somewhere else, which is the only way "my team" can be safe to expose.
   */
  @Get('organizations/me/members')
  async members(@CurrentActor() actor: Actor): Promise<{
    members: Array<{
      userId: string;
      email: string;
      displayName: string;
      roles: string[];
      status: string;
    }>;
    pendingInvitations: Array<{ invitationId: string; email: string; expiresAt: string }>;
  }> {
    const organizationId = actor.organizationId;
    if (!organizationId) throw new NotAuthorized('No organization selected');
    requireRole(actor, 'org_admin', 'platform_admin');
    const [members, pending] = await Promise.all([
      this.repo.listOrganizationMembers(organizationId),
      this.repo.listPendingInvitations(organizationId),
    ]);
    return {
      members,
      pendingInvitations: pending.map((invitation) => ({
        invitationId: invitation.invitationId,
        email: invitation.email,
        expiresAt: invitation.expiresAt.toISOString(),
      })),
    };
  }

  @Post('organizations/:organizationId/invitations')
  async invite(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ invitationId: string; acceptUrl?: string }> {
    const body = parseBody(inviteMemberRequestSchema, request.body);
    const headerKey = request.headers['idempotency-key'];
    return this.invitations.inviteMember(actor, organizationId, {
      ...body,
      idempotencyKey: typeof headerKey === 'string' ? headerKey : undefined,
    });
  }

  @Post('organizations/:organizationId/invitations/:invitationId/revoke')
  async revoke(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Param('invitationId') invitationId: string,
  ): Promise<{ ok: true }> {
    await this.invitations.revokeInvitation(actor, invitationId, organizationId);
    return { ok: true };
  }

  @Public()
  @RateLimit('login')
  @Get('invitations/preview')
  async preview(@Query() query: unknown): Promise<{
    organizationName: string;
    email: string;
    roleKeys: string[];
    accountExists: boolean;
  }> {
    const { token } = parseBody(previewQuerySchema, query);
    return this.invitations.previewInvitation(token);
  }

  @Public()
  @RateLimit('login')
  @Post('invitations/accept')
  async accept(
    @Req() request: FastifyRequest & { actor?: Actor },
  ): Promise<{ organizationId: string; organizationName: string }> {
    const body = parseBody(acceptInvitationRequestSchema, request.body);
    return this.invitations.acceptInvitation({
      token: body.token,
      ...(body.password !== undefined ? { password: body.password } : {}),
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(request.actor ? { authenticatedUserId: request.actor.userId } : {}),
    });
  }
}
