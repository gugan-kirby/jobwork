import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  loginRequestSchema,
  mfaVerifyRequestSchema,
  registerCustomerRequestSchema,
  verifyEmailRequestSchema,
  type MeResponse,
} from '@jobwork/contracts';
import { type Actor } from '../application/actor';
import { AccountService } from '../application/account.service';
import { AuthService } from '../application/auth.service';
import { RegistrationService } from '../application/registration.service';
import { ConfigService } from '../../../platform/config/config.service';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { clearSessionCookies, setSessionCookies } from '../../../platform/http/cookies';
import { AllowMfaPending, Public } from '../../../platform/http/public.decorator';
import { parseBody } from '../../../platform/http/validation';
import { RateLimit } from '../../../platform/http/rate-limit/rate-limit.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly account: AccountService,
    private readonly registration: RegistrationService,
    private readonly config: ConfigService,
  ) {}

  /** Customer self-registration (F-MX.4). Nothing is signed in: the email comes first. */
  @Public()
  @RateLimit('login')
  @Post('register')
  async register(
    @Req() request: FastifyRequest,
  ): Promise<{ userId: string; organizationId: string; verifyUrl?: string }> {
    const body = parseBody(registerCustomerRequestSchema, request.body);
    return this.registration.registerCustomer(body);
  }

  @Public()
  @RateLimit('login')
  @Post('verify-email')
  async verifyEmail(@Req() request: FastifyRequest): Promise<{ ok: true }> {
    const body = parseBody(verifyEmailRequestSchema, request.body);
    await this.registration.verifyEmail(body.token);
    return { ok: true };
  }

  @Public()
  @RateLimit('login')
  @Post('login')
  async login(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ mfaRequired: boolean; organizationSelected: boolean }> {
    const body = parseBody(loginRequestSchema, request.body);
    const issued = await this.auth.login(body.email, body.password, {
      ip: request.ip ?? null,
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    });
    setSessionCookies(reply, this.config, issued.token, issued.csrfToken);
    return { mfaRequired: issued.mfaRequired, organizationSelected: issued.organizationId !== null };
  }

  @AllowMfaPending()
  @RateLimit('login')
  @Post('mfa')
  async verifyMfa(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    const body = parseBody(mfaVerifyRequestSchema, request.body);
    const issued = await this.auth.verifyMfaChallenge(actor, body);
    setSessionCookies(reply, this.config, issued.token, issued.csrfToken);
    return { ok: true };
  }

  @AllowMfaPending()
  @Post('logout')
  async logout(
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    await this.auth.logout(actor);
    clearSessionCookies(reply, this.config);
    return { ok: true };
  }

  @Post('logout-all')
  async logoutAll(
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ revoked: number }> {
    const revoked = await this.auth.logoutAll(actor);
    clearSessionCookies(reply, this.config);
    return { revoked };
  }

  @Get('me')
  async me(@CurrentActor() actor: Actor): Promise<MeResponse> {
    const { memberships, phone } = await this.account.me(actor);
    return {
      userId: actor.userId,
      email: actor.email,
      displayName: actor.displayName,
      phone,
      mfaEnrolled: actor.mfaEnrolled,
      authStrength: actor.authStrength,
      organizationId: actor.organizationId,
      organizationType: actor.organizationType,
      roles: actor.roles,
      memberships: memberships.map((m) => ({
        membershipId: m.membershipId,
        organizationId: m.organizationId,
        organizationName: m.organizationName,
        organizationType: m.organizationType as 'customer' | 'supplier' | 'internal',
        status: m.status,
        roles: m.roles,
      })),
    };
  }
}
