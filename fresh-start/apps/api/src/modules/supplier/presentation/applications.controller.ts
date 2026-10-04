import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  declineApplicationRequestSchema,
  supplierApplicationRequestSchema,
  type SupplierApplication,
} from '@jobwork/contracts';
import { z } from 'zod';
import type { Actor } from '../../iam';
import { NetworkApplicationCommand } from '../application/network-application.command';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { Public } from '../../../platform/http/public.decorator';
import { parseBody } from '../../../platform/http/validation';

const listQuerySchema = z.object({
  status: z.enum(['received', 'admitted', 'declined']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/** The anonymous door (F-MX.4): a workshop asks to join. */
@Controller('public')
export class PublicApplicationsController {
  constructor(private readonly command: NetworkApplicationCommand) {}

  @Public()
  @Post('supplier-applications')
  async apply(@Req() request: FastifyRequest): Promise<{ applicationId: string }> {
    const body = parseBody(supplierApplicationRequestSchema, request.body);
    return this.command.apply(body);
  }
}

/** The reviewer's queue. Admission itself is `POST /suppliers` with `applicationId`. */
@Controller('supplier-applications')
export class ApplicationsController {
  constructor(private readonly command: NetworkApplicationCommand) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ applications: SupplierApplication[] }> {
    const { status, limit } = parseBody(listQuerySchema, query);
    return { applications: await this.command.list(actor, status, limit) };
  }

  @Get(':applicationId')
  async get(
    @CurrentActor() actor: Actor,
    @Param('applicationId') applicationId: string,
  ): Promise<SupplierApplication> {
    return this.command.get(actor, applicationId);
  }

  @Post(':applicationId/decline')
  async decline(
    @CurrentActor() actor: Actor,
    @Param('applicationId') applicationId: string,
    @Req() request: FastifyRequest,
  ): Promise<SupplierApplication> {
    const body = parseBody(declineApplicationRequestSchema, request.body);
    return this.command.decline(actor, applicationId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }
}
