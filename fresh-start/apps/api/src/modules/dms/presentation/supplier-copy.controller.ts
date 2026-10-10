import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { confirmSupplierCopyRequestSchema, prepareSupplierCopyRequestSchema, type SupplierCopy } from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { SupplierCopyCommand } from '../application/supplier-copy.command';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { InternalOnly } from '../../../platform/http/public.decorator';
import { parseBody } from '../../../platform/http/validation';

const idempotencyKey = (request: FastifyRequest): string | undefined => {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
};

/** `FR-305` (F-FP.5): JobWork's reviewed copy of a customer's file, prepared and confirmed by staff. */
@InternalOnly()
@Controller('documents/versions')
export class SupplierCopyController {
  constructor(private readonly copies: SupplierCopyCommand) {}

  @Get(':versionId/supplier-copy')
  async get(@CurrentActor() actor: Actor, @Param('versionId') versionId: string): Promise<{ copy: SupplierCopy | null }> {
    return { copy: await this.copies.get(actor, parseBody(z.uuid(), versionId)) };
  }

  @Post(':versionId/supplier-copy')
  prepare(@CurrentActor() actor: Actor, @Param('versionId') versionId: string, @Req() request: FastifyRequest): Promise<SupplierCopy> {
    return this.copies.prepare(actor, parseBody(z.uuid(), versionId), parseBody(prepareSupplierCopyRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':versionId/supplier-copy/confirm')
  confirm(@CurrentActor() actor: Actor, @Param('versionId') versionId: string, @Req() request: FastifyRequest): Promise<SupplierCopy> {
    return this.copies.confirm(actor, parseBody(z.uuid(), versionId), parseBody(confirmSupplierCopyRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }
}
