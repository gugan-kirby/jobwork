import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  mfaActivateRequestSchema,
  switchOrganizationRequestSchema,
  updateProfileRequestSchema,
} from '@jobwork/contracts';
import type { Actor } from '../application/actor';
import { AccountService } from '../application/account.service';
import { ConfigService } from '../../../platform/config/config.service';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { setSessionCookies } from '../../../platform/http/cookies';
import { parseBody } from '../../../platform/http/validation';

@Controller('account')
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly config: ConfigService,
  ) {}

  @Post('organization/switch')
  async switchOrganization(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    const body = parseBody(switchOrganizationRequestSchema, request.body);
    const rotated = await this.account.switchOrganization(actor, body.organizationId);
    setSessionCookies(reply, this.config, rotated.token, rotated.csrfToken);
    return { ok: true };
  }

  @Post('profile')
  async updateProfile(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true }> {
    const body = parseBody(updateProfileRequestSchema, request.body);
    await this.account.updateProfile(actor, body);
    return { ok: true };
  }

  @Get('sessions')
  async sessions(@CurrentActor() actor: Actor): Promise<{
    sessions: Array<{
      id: string;
      current: boolean;
      lastSeenAt: Date;
      createdAt: Date;
      ip: string | null;
      userAgent: string | null;
    }>;
  }> {
    const rows = await this.account.listSessions(actor);
    return {
      sessions: rows.map((s) => ({
        id: s.id,
        current: s.id === actor.sessionId,
        lastSeenAt: s.lastSeenAt,
        createdAt: s.createdAt,
        ip: s.ip,
        userAgent: s.userAgent,
      })),
    };
  }

  @Post('sessions/:sessionId/revoke')
  async revokeSession(
    @CurrentActor() actor: Actor,
    @Param('sessionId') sessionId: string,
  ): Promise<{ ok: true }> {
    await this.account.revokeSession(actor, sessionId);
    return { ok: true };
  }

  @Post('mfa/enroll')
  async enrollMfa(@CurrentActor() actor: Actor): Promise<{ secret: string; otpauthUri: string }> {
    return this.account.startMfaEnrollment(actor);
  }

  @Post('mfa/activate')
  async activateMfa(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<{ recoveryCodes: string[] }> {
    const body = parseBody(mfaActivateRequestSchema, request.body);
    return this.account.activateMfa(actor, body.code);
  }
}
