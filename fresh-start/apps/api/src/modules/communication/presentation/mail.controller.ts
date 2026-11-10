import { Controller, Get, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { recordMailRequestSchema, type Mailbox } from '@jobwork/contracts';
import { SCAN_WORKER_PRINCIPAL } from '@jobwork/service-auth';
import type { Actor } from '../../iam';
import { MailboxService } from '../application/mailbox';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { InternalOnly } from '../../../platform/http/public.decorator';
import { ServiceOnly } from '../../../platform/http/service-principal.guard';
import { parseBody } from '../../../platform/http/validation';

/** The worker hands over a rendered mail instead of sending it (F-CW.5). */
@ServiceOnly(SCAN_WORKER_PRINCIPAL.name)
@Controller('internal/mail')
export class InternalMailController {
  constructor(private readonly mailbox: MailboxService) {}

  @Post()
  record(@Req() request: FastifyRequest): Promise<{ outcome: 'recorded' | 'already_recorded' }> {
    return this.mailbox.record(parseBody(recordMailRequestSchema, request.body));
  }
}

/** JobWork's own read of that mail, newest first (operations Mail page). */
@InternalOnly()
@Controller('mailbox')
export class MailboxController {
  constructor(private readonly mailbox: MailboxService) {}

  @Get()
  list(@CurrentActor() actor: Actor): Promise<Mailbox> {
    return this.mailbox.list(actor);
  }
}
