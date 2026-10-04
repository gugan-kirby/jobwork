import { Controller, Get } from '@nestjs/common';
import type { OperationsSummary, WorkQueue } from '@jobwork/contracts';
import { DomainError } from '../../../platform/http/domain-error';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { queuesFor } from '../infrastructure/queue-registry';
import { QueueRepository } from '../infrastructure/queue.repository';

/** Platform-shaped actor: the summary needs roles, not the whole identity module. */
interface ActorLike {
  isInternal: boolean;
  roles: string[];
}

/**
 * `GET /operations/summary` — what is waiting, how much of it, and how old the oldest
 * item is (F-OPS.2). Role-filtered by construction: a queue the actor cannot act on is
 * absent from the payload rather than present as a zero.
 */
@Controller('operations')
export class OperationsSummaryController {
  constructor(private readonly repo: QueueRepository) {}

  @Get('summary')
  async summary(@CurrentActor() actor: ActorLike): Promise<OperationsSummary> {
    if (!actor.isInternal) {
      throw new DomainError('NOT_AUTHORIZED', 403, 'Internal audience only');
    }
    const queues = await Promise.all(
      queuesFor(actor.roles).map(async (queue): Promise<WorkQueue> => {
        const { count, oldestWaitingSince } = await this.repo.countMembers(queue);
        return {
          key: queue.key,
          label: queue.label,
          detail: queue.detail,
          count,
          oldestWaitingSince: oldestWaitingSince ? oldestWaitingSince.toISOString() : null,
          href: queue.href,
        };
      }),
    );
    return { queues, generatedAt: new Date().toISOString() };
  }
}
