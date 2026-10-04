import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  QueueAssignee,
  QueueItem,
  QueueOverview,
  QueuesView,
  ReassignQueueItemRequest,
  ReleaseQueueItemRequest,
  TakeQueueItemRequest,
} from '@jobwork/contracts';
import { requireRole, requireTransactionalStrength, type Actor } from '../../iam';
import { contextFromActor, type AuditSpec, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError, VersionConflict } from '../../../platform/http/domain-error';
import { itemState } from '../domain/deadline';
import { queueDefinition, queuesFor, type QueueDefinition } from '../infrastructure/queue-registry';
import { QueueRepository, type QueueMember, type SlaConfig, type Stay } from '../infrastructure/queue.repository';
import { planStay } from './stays';

export class QueueNotFound extends DomainError {
  constructor() {
    super('QUEUE_NOT_FOUND', 404, 'No such queue');
  }
}

export class QueueItemNotFound extends DomainError {
  constructor() {
    super('QUEUE_ITEM_NOT_FOUND', 404, 'This item is no longer in the queue', 'It may have been dealt with already. Refresh the queue.');
  }
}

export class AlreadyAssigned extends DomainError {
  constructor(name: string) {
    super('QUEUE_ITEM_ASSIGNED', 409, `${name} has this item`, 'To take it over, reassign it with a reason.');
  }
}

export class NotAssignedToYou extends DomainError {
  constructor() {
    super('QUEUE_ITEM_NOT_YOURS', 409, 'This item is not assigned to you', 'Only its owner can hand it back; anyone else reassigns it with a reason.');
  }
}

export class AssigneeNotEligible extends DomainError {
  constructor() {
    super('QUEUE_ASSIGNEE_NOT_ELIGIBLE', 422, 'That person does not work this queue', 'Choose someone who holds one of the queue’s roles.');
  }
}

class InternalOnly extends DomainError {
  constructor() {
    super('NOT_AUTHORIZED', 403, 'Internal audience only');
  }
}

interface AssignmentResult {
  item: QueueItem;
}

/**
 * The queue screen and its three commands (F-11.1). An item's presence comes from the
 * owning module's query, so the screen lists exactly what the command center counts;
 * owner and deadline come from the item's stay. Taking, handing back and reassigning are
 * audited commands under `expectedVersion`; reassigning someone else's item needs a
 * reason, and the new owner must work the queue.
 */
@Injectable()
export class QueueService {
  constructor(
    private readonly repo: QueueRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async view(actor: Actor, now: Date = new Date()): Promise<QueuesView> {
    if (!actor.isInternal) throw new InternalOnly();
    const defs = queuesFor(actor.roles);
    const config = await this.repo.loadConfig();
    const stays = new Map((await this.repo.openStays(defs.map((d) => d.key))).map((s) => [`${s.queueKey}:${s.subjectId}`, s]));
    const items: QueueItem[] = [];
    const queues: QueueOverview[] = [];
    for (const def of defs) {
      const members = await this.repo.members(def);
      const rows = members.map((m) => this.toItem(def, m, stays.get(`${def.key}:${m.subjectId}`) ?? null, config, now));
      items.push(...rows);
      const queue = config.queues.get(def.key);
      const policy = queue?.slaPolicyKey ? config.activePolicies.get(queue.slaPolicyKey) : undefined;
      queues.push({
        key: def.key,
        label: def.label,
        owningTeam: queue?.owningTeam ?? '',
        count: rows.length,
        overdue: rows.filter((r) => r.state === 'overdue').length,
        targetMinutes: policy?.targetMinutes ?? null,
        href: def.href,
      });
    }
    items.sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.waitingSince.localeCompare(b.waitingSince));
    return { queues, items, generatedAt: now.toISOString() };
  }

  async assignees(actor: Actor, queueKey: string): Promise<{ assignees: QueueAssignee[] }> {
    const def = this.authorize(actor, queueKey);
    return { assignees: await this.repo.eligibleAssignees(def.roles) };
  }

  async take(actor: Actor, queueKey: string, subjectId: string, input: TakeQueueItemRequest, opts: { idempotencyKey?: string | undefined }): Promise<QueueItem> {
    const def = this.authorize(actor, queueKey);
    requireTransactionalStrength(actor);
    const result = await this.executor.execute<TakeQueueItemRequest, AssignmentResult>(
      {
        operation: 'platform.queue-take',
        handler: async (tx, _ctx, cmd) => {
          const { stay, member, config } = await this.openOrGet(tx, def, subjectId);
          this.checkVersion(stay, cmd.expectedVersion, true);
          if (stay.assigneeUserId === actor.userId) {
            return { result: { item: this.toItem(def, member, stay, config, new Date()) }, audit: [] };
          }
          if (stay.assigneeUserId) throw new AlreadyAssigned(stay.assigneeName ?? 'A colleague');
          const version = await this.repo.setAssignee(tx, stay.id, actor.userId);
          const updated = { ...stay, assigneeUserId: actor.userId, assigneeName: actor.displayName, aggregateVersion: version };
          return {
            result: { item: this.toItem(def, member, updated, config, new Date()) },
            audit: [this.auditSpec('queue.item_taken', updated, { from: null, to: actor.userId })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return result.item;
  }

  async release(actor: Actor, queueKey: string, subjectId: string, input: ReleaseQueueItemRequest, opts: { idempotencyKey?: string | undefined }): Promise<QueueItem> {
    const def = this.authorize(actor, queueKey);
    requireTransactionalStrength(actor);
    const result = await this.executor.execute<ReleaseQueueItemRequest, AssignmentResult>(
      {
        operation: 'platform.queue-release',
        handler: async (tx, _ctx, cmd) => {
          const { stay, member, config } = await this.openOrGet(tx, def, subjectId);
          if (stay.assigneeUserId !== actor.userId) throw new NotAssignedToYou();
          this.checkVersion(stay, cmd.expectedVersion, false);
          const version = await this.repo.setAssignee(tx, stay.id, null);
          const updated = { ...stay, assigneeUserId: null, assigneeName: null, aggregateVersion: version };
          return {
            result: { item: this.toItem(def, member, updated, config, new Date()) },
            audit: [this.auditSpec('queue.item_released', updated, { from: actor.userId, to: null })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return result.item;
  }

  async reassign(actor: Actor, queueKey: string, subjectId: string, input: ReassignQueueItemRequest, opts: { idempotencyKey?: string | undefined }): Promise<QueueItem> {
    const def = this.authorize(actor, queueKey);
    requireTransactionalStrength(actor);
    if (input.assigneeUserId) {
      const eligible = await this.repo.eligibleAssignees(def.roles, input.assigneeUserId);
      if (eligible.length === 0) throw new AssigneeNotEligible();
    }
    const result = await this.executor.execute<ReassignQueueItemRequest, AssignmentResult>(
      {
        operation: 'platform.queue-reassign',
        handler: async (tx, _ctx, cmd) => {
          const { stay, member, config } = await this.openOrGet(tx, def, subjectId);
          this.checkVersion(stay, cmd.expectedVersion, true);
          if (stay.assigneeUserId === cmd.assigneeUserId) {
            return { result: { item: this.toItem(def, member, stay, config, new Date()) }, audit: [] };
          }
          const version = await this.repo.setAssignee(tx, stay.id, cmd.assigneeUserId);
          const assigneeName = cmd.assigneeUserId
            ? (await this.repo.eligibleAssignees(def.roles, cmd.assigneeUserId))[0]?.displayName ?? null
            : null;
          const updated = { ...stay, assigneeUserId: cmd.assigneeUserId, assigneeName, aggregateVersion: version };
          const outbox: OutboxSpec[] = [];
          if (cmd.assigneeUserId && cmd.assigneeUserId !== actor.userId) {
            outbox.push({
              eventType: 'platform.queue_item_reassigned.v1',
              aggregateType: 'queue_assignment',
              aggregateId: stay.id,
              aggregateVersion: version,
              data: {
                queueKey: def.key,
                queueLabel: def.label,
                reference: stay.reference,
                assigneeUserId: cmd.assigneeUserId,
                actingRoles: [...def.roles],
              },
            });
          }
          return {
            result: { item: this.toItem(def, member, updated, config, new Date()) },
            audit: [{ ...this.auditSpec('queue.item_reassigned', updated, { from: stay.assigneeUserId, to: cmd.assigneeUserId }), reason: cmd.reason }],
            outbox,
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return result.item;
  }

  private authorize(actor: Actor, queueKey: string): QueueDefinition {
    if (!actor.isInternal) throw new InternalOnly();
    const def = queueDefinition(queueKey);
    if (!def) throw new QueueNotFound();
    requireRole(actor, ...def.roles);
    return def;
  }

  /**
   * The item's open stay, locked; opened here if the sweep has not reached it yet. An
   * item that is no longer a member of the queue cannot be taken, whatever the screen
   * showed a moment ago.
   */
  private async openOrGet(tx: PoolClient, def: QueueDefinition, subjectId: string): Promise<{ stay: Stay; member: QueueMember; config: SlaConfig }> {
    const member = await this.repo.member(def, subjectId, tx);
    if (!member) throw new QueueItemNotFound();
    const config = await this.repo.loadConfig(tx);
    let stay = await this.repo.lockOpenStay(tx, def.key, subjectId);
    if (!stay) {
      const returning = await this.repo.returningSubjects(tx, def.key, [subjectId]);
      await this.repo.insertStay(tx, planStay(def, member, config, new Date(), returning.has(subjectId)));
      stay = await this.repo.lockOpenStay(tx, def.key, subjectId);
    }
    if (!stay) throw new QueueItemNotFound();
    return { stay, member, config };
  }

  /**
   * `expectedVersion: null` says "I saw no stay"; it is honoured while the stay is still
   * untouched (version 1, nobody assigned) — the sweep opening it in between is not a
   * change the person needed to see.
   */
  private checkVersion(stay: Stay, expected: number | null, allowUnseen: boolean): void {
    if (expected === null) {
      if (allowUnseen && stay.aggregateVersion === 1 && !stay.assigneeUserId) return;
      throw new VersionConflict();
    }
    if (stay.aggregateVersion !== expected) throw new VersionConflict();
  }

  private auditSpec(action: string, stay: Stay, data: { from: string | null; to: string | null }): AuditSpec {
    return {
      action,
      subjectType: 'queue_assignment',
      subjectId: stay.id,
      subjectVersion: stay.aggregateVersion,
      data: { queueKey: stay.queueKey, subjectType: stay.subjectType, subjectId: stay.subjectId, ...data },
    };
  }

  private toItem(def: QueueDefinition, member: QueueMember, stay: Stay | null, config: SlaConfig, now: Date): QueueItem {
    // Before the sweep reaches a new arrival, show the deadline it will be given.
    const preview = stay ? null : planStay(def, member, config, now, false);
    const dueAt = stay ? stay.dueAt : preview!.dueAt;
    return {
      queueKey: def.key,
      queueLabel: def.label,
      subjectType: def.subjectType,
      subjectId: member.subjectId,
      reference: member.reference,
      title: member.title,
      href: member.href,
      waitingSince: member.waitingSince.toISOString(),
      dueAt: dueAt ? dueAt.toISOString() : null,
      timeZone: stay ? stay.timeZone : preview!.timeZone,
      state: itemState(dueAt, now),
      escalationLevel: stay?.escalationLevel ?? 0,
      assignee: stay?.assigneeUserId ? { userId: stay.assigneeUserId, displayName: stay.assigneeName ?? 'A colleague' } : null,
      assignmentVersion: stay?.aggregateVersion ?? null,
    };
  }
}
