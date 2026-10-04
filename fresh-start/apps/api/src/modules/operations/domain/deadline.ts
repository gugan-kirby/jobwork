import type { EscalationStep, QueueItemState } from '@jobwork/contracts';
import { addWorkingMinutes, type WorkingCalendar } from '../../../platform/sla/business-time';

/**
 * When an item in a queue is due and when each escalation step fires (doc 07 §11).
 * Pure: the sweep, the queue screen and the tests all ask the same function.
 */

export interface ScheduledStep extends EscalationStep {
  at: Date;
}

export interface Schedule {
  dueAt: Date;
  steps: ScheduledStep[];
}

export function schedule(
  clockStartedAt: Date,
  policy: { targetMinutes: number; escalationSteps: readonly EscalationStep[] },
  calendar: WorkingCalendar,
): Schedule {
  const steps = [...policy.escalationSteps]
    .sort((a, b) => a.step - b.step)
    .map((s) => ({ ...s, at: addWorkingMinutes(clockStartedAt, s.afterMinutes, calendar) }));
  return { dueAt: addWorkingMinutes(clockStartedAt, policy.targetMinutes, calendar), steps };
}

/**
 * When the clock starts for a new stay. A first stay counts from when the item began
 * waiting — but never from before the policy existed, or the first sweep after a policy
 * goes live would declare months of history overdue at once. A return to the queue
 * counts from the return: the earlier stay already had its clock.
 */
export function clockStart(input: { waitingSince: Date; policyActivatedAt: Date | null; returning: boolean; now: Date }): Date {
  if (input.returning) return input.now;
  const floor = input.policyActivatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const start = Math.max(input.waitingSince.getTime(), floor);
  return new Date(Math.min(start, input.now.getTime()));
}

/**
 * The step to fire now: the highest one already due that has not fired. An item found
 * twice past due fires its last step once, not every step it missed — a worker coming
 * back from an outage must not send a storm of stale "due" notices (doc 13 §11).
 */
export function stepToFire(plan: Schedule, escalationLevel: number, now: Date): ScheduledStep | undefined {
  const due = plan.steps.filter((s) => s.step > escalationLevel && s.at.getTime() <= now.getTime());
  return due[due.length - 1];
}

/** When the sweep should look at this item again, or null when every step has fired. */
export function nextEscalationAt(plan: Schedule, escalationLevel: number): Date | null {
  return plan.steps.find((s) => s.step > escalationLevel)?.at ?? null;
}

const DUE_SOON_MS = 2 * 60 * 60 * 1000;

export function itemState(dueAt: Date | null, now: Date): QueueItemState {
  if (!dueAt) return 'no_target';
  const left = dueAt.getTime() - now.getTime();
  if (left <= 0) return 'overdue';
  if (left <= DUE_SOON_MS) return 'due_soon';
  return 'on_track';
}
