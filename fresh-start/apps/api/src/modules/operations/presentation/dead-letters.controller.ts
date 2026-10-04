import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { resolveDeadLetterRequestSchema, type DeadLetter } from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';
import { DeadLetters } from '../application/dead-letter.command';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/** Outbox events the worker gave up on, and the two ways a person closes them (F-11.4). */
@Controller('operations/dead-letters')
export class DeadLettersController {
  constructor(private readonly deadLetters: DeadLetters) {}

  @Get()
  async list(@CurrentActor() actor: Actor): Promise<{ deadLetters: DeadLetter[] }> {
    return { deadLetters: await this.deadLetters.list(actor) };
  }

  @Post(':eventId/replay')
  replay(@CurrentActor() actor: Actor, @Param('eventId') eventId: string, @Req() request: FastifyRequest): Promise<{ eventId: string; status: 'pending' }> {
    return this.deadLetters.replay(actor, eventId, parseBody(resolveDeadLetterRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':eventId/dismiss')
  dismiss(@CurrentActor() actor: Actor, @Param('eventId') eventId: string, @Req() request: FastifyRequest): Promise<{ eventId: string; status: 'dismissed' }> {
    return this.deadLetters.dismiss(actor, eventId, parseBody(resolveDeadLetterRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }
}
