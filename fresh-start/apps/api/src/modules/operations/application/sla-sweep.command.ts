import { Injectable } from '@nestjs/common';
import type { SlaSweepResult } from '@jobwork/contracts';
import type { AuditSpec, CommandContext, OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { nextEscalationAt, schedule, stepToFire } from '../domain/deadline';
import { QUEUE_DEFINITIONS, queueDefinition, type QueueDefinition } from '../infrastructure/queue-registry';
import { QueueRepository, type SlaConfig, type Stay } from '../infrastructure/queue.repository';
import { planStay } from './stays';

/** Bounded work per sweep: a backlog drains over a few ticks instead of in one long transaction. */
const BATCH = 200;

/**
 * The SLA sweep (F-11.1; doc 07 §11; UC-38), called by the worker on a timer.
 *
 * 1. Sync: every member of a queue has exactly one open stay; a stay whose subject left
 *    the queue is closed. Membership is the owning module's own query, read fresh.
 * 2. Reschedule: a stay computed against a calendar that has since been replaced gets its
 *    deadline recomputed; a moved deadline is a new `due_version`.
 * 3. Escalate: the next due stays are locked `SKIP LOCKED`, the step is recorded under its
 *    unique key, and audit + outbox are written in the same transaction — so a step fires
 *    once however many sweeps race, and a notification exists only for a committed step.
 */
@Injectable()
export class SlaSweep {
  constructor(
    private readonly repo: QueueRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async sweep(ctx: CommandContext, now: Date = new Date()): Promise<SlaSweepResult> {
    const config = await this.repo.loadConfig();
    let opened = 0;
    let closed = 0;
    for (const def of QUEUE_DEFINITIONS) {
      const result = await this.sync(def, config, now);
      opened += result.opened;
      closed += result.closed;
    }
    const rescheduled = await this.reschedule(ctx, config);
    const escalated = await this.escalate(ctx, config, now);
    return { opened, closed, rescheduled, escalated };
  }

  private sync(def: QueueDefinition, config: SlaConfig, now: Date): Promise<{ opened: number; closed: number }> {
    return this.repo.db.withTransaction(async (tx) => {
      const members = await this.repo.members(def, tx);
      const open = new Set((await this.repo.openStays([def.key], tx)).map((s) => s.subjectId));
      const arriving = members.filter((m) => !open.has(m.subjectId));
      const returning = await this.repo.returningSubjects(tx, def.key, arriving.map((m) => m.subjectId));
      let opened = 0;
      for (const member of arriving) {
        if (await this.repo.insertStay(tx, planStay(def, member, config, now, returning.has(member.subjectId)))) opened += 1;
      }
      const closed = await this.repo.closeStays(tx, def.key, members.map((m) => m.subjectId));
      return { opened, closed };
    });
  }

  /**
   * A new calendar version (a declared holiday, a changed working week) moves deadlines
   * that have not been met. The policy a stay opened under is kept: a policy change
   * applies to new arrivals, a calendar change to everyone's working days.
   */
  private async reschedule(ctx: CommandContext, config: SlaConfig): Promise<number> {
    return this.executor.execute(
      {
        operation: 'platform.sla-reschedule',
        handler: async (tx) => {
          const stays = await this.repo.lockStaysOnRetiredCalendars(tx, BATCH);
          const audit: AuditSpec[] = [];
          for (const stay of stays) {
            const oldCalendar = config.calendars.get(stay.calendarVersionId!);
            const calendar = oldCalendar ? config.activeCalendars.get(oldCalendar.calendarKey) : undefined;
            const policy = config.policies.get(stay.policyVersionId!);
            if (!calendar || !policy) continue;
            const plan = schedule(stay.clockStartedAt, policy, calendar);
            const moved = plan.dueAt.getTime() !== stay.dueAt?.getTime();
            await this.repo.reschedule(tx, stay.id, {
              calendarVersionId: calendar.id,
              timeZone: calendar.timeZone,
              dueAt: plan.dueAt,
              nextEscalationAt: nextEscalationAt(plan, 0),
              newDeadline: moved,
            });
            if (moved) {
              audit.push({
                action: 'queue.deadline_rescheduled',
                subjectType: 'queue_assignment',
                subjectId: stay.id,
                subjectVersion: stay.aggregateVersion + 1,
                data: {
                  queueKey: stay.queueKey,
                  calendarVersion: calendar.version,
                  dueVersion: stay.dueVersion + 1,
                  previousDueAt: stay.dueAt?.toISOString() ?? null,
                  dueAt: plan.dueAt.toISOString(),
                },
              });
            }
          }
          return { result: stays.length, audit };
        },
      },
      ctx,
      undefined,
    );
  }

  private async escalate(ctx: CommandContext, config: SlaConfig, now: Date): Promise<number> {
    return this.executor.execute(
      {
        operation: 'platform.sla-escalate',
        handler: async (tx) => {
          const stays = await this.repo.lockDueStays(tx, now, BATCH);
          const audit: AuditSpec[] = [];
          const outbox: OutboxSpec[] = [];
          for (const stay of stays) {
            const fired = await this.fire(tx, stay, config, now);
            if (fired) {
              audit.push(fired.audit);
              outbox.push(fired.outbox);
            }
          }
          return { result: outbox.length, audit, outbox };
        },
      },
      ctx,
      undefined,
    );
  }

  private async fire(
    tx: Parameters<QueueRepository['recordEscalation']>[0],
    stay: Stay,
    config: SlaConfig,
    now: Date,
  ): Promise<{ audit: AuditSpec; outbox: OutboxSpec } | null> {
    const policy = stay.policyVersionId ? config.policies.get(stay.policyVersionId) : undefined;
    const calendar = stay.calendarVersionId ? config.calendars.get(stay.calendarVersionId) : undefined;
    const def = queueDefinition(stay.queueKey);
    const queue = config.queues.get(stay.queueKey);
    if (!policy || !calendar || !def || !queue) {
      await this.repo.setEscalation(tx, stay.id, stay.escalationLevel, null);
      return null;
    }
    const plan = schedule(stay.clockStartedAt, policy, calendar);
    const step = stepToFire(plan, stay.escalationLevel, now);
    if (!step) {
      await this.repo.setEscalation(tx, stay.id, stay.escalationLevel, nextEscalationAt(plan, stay.escalationLevel));
      return null;
    }
    const recorded = await this.repo.recordEscalation(tx, stay.id, step.step, stay.dueVersion, step.notify);
    await this.repo.setEscalation(tx, stay.id, step.step, nextEscalationAt(plan, step.step));
    if (!recorded) return null;
    return {
      audit: {
        action: 'queue.sla_escalated',
        subjectType: 'queue_assignment',
        subjectId: stay.id,
        subjectVersion: stay.aggregateVersion + 1,
        data: { queueKey: stay.queueKey, step: step.step, notify: step.notify, dueVersion: stay.dueVersion, subjectType: stay.subjectType, subjectId: stay.subjectId },
      },
      outbox: {
        eventType: 'platform.sla_escalated.v1',
        aggregateType: 'queue_assignment',
        aggregateId: stay.id,
        aggregateVersion: stay.aggregateVersion + 1,
        data: {
          queueKey: stay.queueKey,
          queueLabel: def.label,
          reference: stay.reference,
          step: step.step,
          notify: step.notify,
          dueVersion: stay.dueVersion,
          dueAt: plan.dueAt.toISOString(),
          assigneeUserId: stay.assigneeUserId,
          actingRoles: [...def.roles],
          escalationRoles: queue.escalationRoles,
        },
      },
    };
  }
}
