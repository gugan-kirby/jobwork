import { z } from 'zod';
import { workQueueSchema } from './auth';

// ------------------------------------------------------------------ work queues (F-11.1)

export const workQueueKeySchema = workQueueSchema.shape.key;

/**
 * Where an item stands against its service target. `no_target` is a watch list (an
 * invitation expires on its own); `due_soon` is the last two hours before the target.
 */
export const queueItemStateSchema = z.enum(['no_target', 'on_track', 'due_soon', 'overdue']);

export const queueAssigneeSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
});

export const queueItemSchema = z.object({
  queueKey: workQueueKeySchema,
  queueLabel: z.string(),
  subjectType: z.string(),
  subjectId: z.uuid(),
  /** A record number, or a neutral word where the record has none. */
  reference: z.string(),
  title: z.string(),
  /** The record's own page. */
  href: z.string(),
  waitingSince: z.string(),
  dueAt: z.string().nullable(),
  /** The zone the deadline's working hours are read in (`BR-SYS-07`). */
  timeZone: z.string().nullable(),
  state: queueItemStateSchema,
  escalationLevel: z.number().int().nonnegative(),
  assignee: queueAssigneeSchema.nullable(),
  /** Null until the sweep or a person has opened the item's stay. */
  assignmentVersion: z.number().int().positive().nullable(),
});

export const queueOverviewSchema = z.object({
  key: workQueueKeySchema,
  label: z.string(),
  owningTeam: z.string(),
  count: z.number().int().nonnegative(),
  overdue: z.number().int().nonnegative(),
  targetMinutes: z.number().int().positive().nullable(),
  href: z.string(),
});

export const queuesViewSchema = z.object({
  queues: z.array(queueOverviewSchema),
  items: z.array(queueItemSchema),
  generatedAt: z.string(),
});

export const takeQueueItemRequestSchema = z.object({
  /** The stay's version, or null when the item has no stay yet. */
  expectedVersion: z.number().int().positive().nullable(),
});

export const releaseQueueItemRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const reassignQueueItemRequestSchema = z.object({
  /** Null hands the item back to the queue. */
  assigneeUserId: z.uuid().nullable(),
  reason: z.string().trim().min(3).max(500),
  expectedVersion: z.number().int().positive().nullable(),
});

// ------------------------------------------------------------------ SLA configuration

export const escalationStepSchema = z.object({
  step: z.number().int().positive(),
  afterMinutes: z.number().int().positive(),
  notify: z.enum(['owner', 'escalation']),
});

export const slaPolicySchema = z.object({
  policyKey: z.string(),
  version: z.number().int().positive(),
  calendarKey: z.string(),
  targetMinutes: z.number().int().positive(),
  escalationSteps: z.array(escalationStepSchema),
  activatedAt: z.string(),
  reason: z.string(),
});

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const businessCalendarSchema = z.object({
  calendarKey: z.string(),
  version: z.number().int().positive(),
  timeZone: z.string(),
  workingDays: z.array(z.number().int().min(1).max(7)),
  dayStart: z.string(),
  dayEnd: z.string(),
  holidays: z.array(z.string()),
  activatedAt: z.string(),
  reason: z.string(),
});

export const slaConfigurationSchema = z.object({
  calendars: z.array(businessCalendarSchema),
  policies: z.array(slaPolicySchema),
});

export const publishCalendarRequestSchema = z.object({
  timeZone: z.string().min(1).max(64),
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  dayStart: localTime,
  dayEnd: localTime,
  holidays: z.array(localDate).max(400),
  reason: z.string().trim().min(3).max(500),
  /** The version currently in force; publishing over a newer one is a conflict. */
  expectedVersion: z.number().int().positive(),
});

// ------------------------------------------------------------------ controls panel (F-11.3)

export const controlQueueSchema = z.object({
  key: workQueueKeySchema,
  label: z.string(),
  href: z.string(),
  count: z.number().int().nonnegative(),
  overdue: z.number().int().nonnegative(),
  oldestWaitingSince: z.string().nullable(),
  targetMinutes: z.number().int().positive().nullable(),
});

export const platformControlsSchema = z.object({
  outbox: z.object({
    pending: z.number().int().nonnegative(),
    processing: z.number().int().nonnegative(),
    /** Poison messages: an event the worker gave up on, waiting for a person (runbook). */
    dead: z.number().int().nonnegative(),
    oldestPendingSeconds: z.number().nonnegative(),
  }),
  scan: z.object({ backlog: z.number().int().nonnegative(), oldestSeconds: z.number().nonnegative() }),
  deliveries: z.object({ failedLastHour: z.number().int().nonnegative(), stuckSending: z.number().int().nonnegative() }),
  rateLimitStoreDegraded: z.boolean(),
});

export const sodRuleSchema = z.object({
  key: z.string(),
  roles: z.array(z.string()),
  reason: z.string(),
  source: z.string(),
});

export const roleConflictSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  roles: z.array(z.string()),
  rules: z.array(z.string()),
});

export const operationsControlsSchema = z.object({
  generatedAt: z.string(),
  /** The reader's own queues, as on the command center. */
  queues: z.array(controlQueueSchema),
  /** Platform administrators and security administrators only. */
  platform: platformControlsSchema.nullable(),
  separationOfDuties: z.object({ rules: z.array(sodRuleSchema), conflicts: z.array(roleConflictSchema) }).nullable(),
});

// ------------------------------------------------------------------ dead letters (F-11.4)

/** An outbox event the worker gave up on. Never its payload: type, age and error only. */
export const deadLetterSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string(),
  aggregateType: z.string(),
  occurredAt: z.string(),
  attempts: z.number().int().nonnegative(),
  /** The worker's last error, with e-mail addresses and long numbers masked. */
  lastError: z.string().nullable(),
  correlationId: z.string(),
});

export const resolveDeadLetterRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

// ------------------------------------------------------------------ internal sweep

export const slaSweepResultSchema = z.object({
  opened: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  rescheduled: z.number().int().nonnegative(),
  escalated: z.number().int().nonnegative(),
});

export type WorkQueueKey = z.infer<typeof workQueueKeySchema>;
export type QueueItemState = z.infer<typeof queueItemStateSchema>;
export type QueueAssignee = z.infer<typeof queueAssigneeSchema>;
export type QueueItem = z.infer<typeof queueItemSchema>;
export type QueueOverview = z.infer<typeof queueOverviewSchema>;
export type QueuesView = z.infer<typeof queuesViewSchema>;
export type TakeQueueItemRequest = z.infer<typeof takeQueueItemRequestSchema>;
export type ReleaseQueueItemRequest = z.infer<typeof releaseQueueItemRequestSchema>;
export type ReassignQueueItemRequest = z.infer<typeof reassignQueueItemRequestSchema>;
export type EscalationStep = z.infer<typeof escalationStepSchema>;
export type SlaPolicy = z.infer<typeof slaPolicySchema>;
export type BusinessCalendar = z.infer<typeof businessCalendarSchema>;
export type SlaConfiguration = z.infer<typeof slaConfigurationSchema>;
export type PublishCalendarRequest = z.infer<typeof publishCalendarRequestSchema>;
export type SlaSweepResult = z.infer<typeof slaSweepResultSchema>;
export type ControlQueue = z.infer<typeof controlQueueSchema>;
export type PlatformControls = z.infer<typeof platformControlsSchema>;
export type SodRuleView = z.infer<typeof sodRuleSchema>;
export type RoleConflictView = z.infer<typeof roleConflictSchema>;
export type OperationsControls = z.infer<typeof operationsControlsSchema>;
export type DeadLetter = z.infer<typeof deadLetterSchema>;
export type ResolveDeadLetterRequest = z.infer<typeof resolveDeadLetterRequestSchema>;
