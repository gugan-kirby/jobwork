import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  publishCalendarRequestSchema,
  reassignQueueItemRequestSchema,
  releaseQueueItemRequestSchema,
  takeQueueItemRequestSchema,
  type BusinessCalendar,
  type QueueAssignee,
  type QueueItem,
  type QueuesView,
  type SlaConfiguration,
  type SlaSweepResult,
} from '@jobwork/contracts';
import { SCAN_WORKER_PRINCIPAL } from '@jobwork/service-auth';
import type { Actor } from '../../iam';
import { contextFromService } from '../../../platform/commands/command';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { DomainError } from '../../../platform/http/domain-error';
import { ServiceOnly, type ServiceActorRequest } from '../../../platform/http/service-principal.guard';
import { parseBody } from '../../../platform/http/validation';
import { QueueService } from '../application/queue.command';
import { SlaConfigService } from '../application/sla-config.command';
import { SlaSweep } from '../application/sla-sweep.command';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/** The work queues (F-11.1): every item the actor's roles work, with owner and deadline. */
@Controller('queues')
export class QueuesController {
  constructor(private readonly queues: QueueService) {}

  @Get()
  view(@CurrentActor() actor: Actor): Promise<QueuesView> {
    return this.queues.view(actor);
  }

  @Get(':queueKey/assignees')
  assignees(@CurrentActor() actor: Actor, @Param('queueKey') queueKey: string): Promise<{ assignees: QueueAssignee[] }> {
    return this.queues.assignees(actor, queueKey);
  }

  @Post(':queueKey/items/:subjectId/take')
  take(@CurrentActor() actor: Actor, @Param('queueKey') queueKey: string, @Param('subjectId') subjectId: string, @Req() request: FastifyRequest): Promise<QueueItem> {
    return this.queues.take(actor, queueKey, subjectId, parseBody(takeQueueItemRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':queueKey/items/:subjectId/release')
  release(@CurrentActor() actor: Actor, @Param('queueKey') queueKey: string, @Param('subjectId') subjectId: string, @Req() request: FastifyRequest): Promise<QueueItem> {
    return this.queues.release(actor, queueKey, subjectId, parseBody(releaseQueueItemRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':queueKey/items/:subjectId/reassign')
  reassign(@CurrentActor() actor: Actor, @Param('queueKey') queueKey: string, @Param('subjectId') subjectId: string, @Req() request: FastifyRequest): Promise<QueueItem> {
    return this.queues.reassign(actor, queueKey, subjectId, parseBody(reassignQueueItemRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }
}

/** Service targets and the business calendar in force (UC-35). */
@Controller('sla')
export class SlaController {
  constructor(private readonly config: SlaConfigService) {}

  @Get()
  configuration(@CurrentActor() actor: Actor): Promise<SlaConfiguration> {
    return this.config.configuration(actor);
  }

  @Post('calendars/:calendarKey/versions')
  publishCalendar(@CurrentActor() actor: Actor, @Param('calendarKey') calendarKey: string, @Req() request: FastifyRequest): Promise<BusinessCalendar> {
    return this.config.publishCalendar(actor, calendarKey, parseBody(publishCalendarRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }
}

/** The worker's tick: open and close stays, move deadlines, fire due steps (UC-38). */
@ServiceOnly(SCAN_WORKER_PRINCIPAL.name)
@Controller('internal/sla')
export class InternalSlaController {
  constructor(private readonly sweeper: SlaSweep) {}

  @Post('sweep')
  sweep(@Req() request: ServiceActorRequest): Promise<SlaSweepResult> {
    if (!request.servicePrincipal) {
      throw new DomainError('SERVICE_AUTH_FAILED', 401, 'Service credential required');
    }
    return this.sweeper.sweep(contextFromService(request.servicePrincipal, null));
  }
}
