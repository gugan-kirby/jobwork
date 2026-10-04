import { clockStart, nextEscalationAt, schedule } from '../domain/deadline';
import type { QueueDefinition } from '../infrastructure/queue-registry';
import type { NewStay, QueueMember, SlaConfig } from '../infrastructure/queue.repository';

/**
 * A new stay for a member of a queue: its clock, deadline and first escalation instant,
 * computed against the policy and calendar versions in force now — which the stay then
 * records, so the deadline can always be explained later.
 */
export function planStay(def: QueueDefinition, member: QueueMember, config: SlaConfig, now: Date, returning: boolean): NewStay {
  const base = {
    queueKey: def.key,
    subjectType: def.subjectType,
    subjectId: member.subjectId,
    reference: member.reference,
    waitingSince: member.waitingSince,
  };
  const policyKey = config.queues.get(def.key)?.slaPolicyKey ?? null;
  const policy = policyKey ? config.activePolicies.get(policyKey) : undefined;
  const calendar = policy ? config.activeCalendars.get(policy.calendarKey) : undefined;
  if (!policy || !calendar) {
    // A watch list: the item is tracked and can be owned, but nothing is ever "due".
    const started = clockStart({ waitingSince: member.waitingSince, policyActivatedAt: null, returning, now });
    return { ...base, clockStartedAt: started, policyVersionId: null, calendarVersionId: null, timeZone: null, dueAt: null, nextEscalationAt: null };
  }
  const started = clockStart({ waitingSince: member.waitingSince, policyActivatedAt: policy.activatedAt, returning, now });
  const plan = schedule(started, policy, calendar);
  return {
    ...base,
    clockStartedAt: started,
    policyVersionId: policy.id,
    calendarVersionId: calendar.id,
    timeZone: calendar.timeZone,
    dueAt: plan.dueAt,
    nextEscalationAt: nextEscalationAt(plan, 0),
  };
}
