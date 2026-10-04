import { Controller, Get } from '@nestjs/common';
import type { OperationsControls } from '@jobwork/contracts';
import { conflictsOf, IamRepository, SOD_RULES, type Actor } from '../../iam';
import { DomainError } from '../../../platform/http/domain-error';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { RateLimitInterceptor } from '../../../platform/http/rate-limit/rate-limit.interceptor';
import { ResilientRateLimitStore } from '../../../platform/http/rate-limit/store';
import { ControlsRepository } from '../infrastructure/controls.repository';
import { queuesFor } from '../infrastructure/queue-registry';
import { QueueRepository } from '../infrastructure/queue.repository';

const PLATFORM_READERS = ['platform_admin', 'security_admin'];

/**
 * `GET /operations/controls` — the business-control panel (doc 12 §7; F-11.3): how the
 * reader's queues stand against their targets, and, for platform and security
 * administrators, the platform's own backlogs and who holds a role combination the
 * separation-of-duties rules forbid (doc 19 §9). Counts and ages only: nothing here
 * opens a record the reader could not open anyway.
 */
@Controller('operations')
export class OperationsControlsController {
  constructor(
    private readonly snapshots: ControlsRepository,
    private readonly queues: QueueRepository,
    private readonly iam: IamRepository,
    private readonly rateLimit: RateLimitInterceptor,
  ) {}

  @Get('controls')
  async controls(@CurrentActor() actor: Actor): Promise<OperationsControls> {
    if (!actor.isInternal) throw new DomainError('NOT_AUTHORIZED', 403, 'Internal audience only');
    const snapshot = await this.snapshots.snapshot({ fresh: true });
    const config = await this.queues.loadConfig();
    const queues = queuesFor(actor.roles).map((def) => {
      const control = snapshot.queues.find((q) => q.key === def.key);
      const policyKey = config.queues.get(def.key)?.slaPolicyKey;
      return {
        key: def.key,
        label: def.label,
        href: def.href,
        count: control?.count ?? 0,
        overdue: control?.overdue ?? 0,
        oldestWaitingSince: control?.oldestWaitingSince?.toISOString() ?? null,
        targetMinutes: policyKey ? config.activePolicies.get(policyKey)?.targetMinutes ?? null : null,
      };
    });
    const platformReader = actor.roles.some((r) => PLATFORM_READERS.includes(r));
    if (!platformReader) return { generatedAt: snapshot.at.toISOString(), queues, platform: null, separationOfDuties: null };

    const store = this.rateLimit.store;
    const people = await this.iam.internalRoleHolders();
    return {
      generatedAt: snapshot.at.toISOString(),
      queues,
      platform: { ...snapshot.platform, rateLimitStoreDegraded: store instanceof ResilientRateLimitStore && store.degraded },
      separationOfDuties: {
        rules: SOD_RULES.map((r) => ({ key: r.key, roles: [...r.roles], reason: r.reason, source: r.source })),
        conflicts: people
          .map((p) => ({ ...p, rules: conflictsOf(p.roles).map((r) => r.key) }))
          .filter((p) => p.rules.length > 0),
      },
    };
  }
}
