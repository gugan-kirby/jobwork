import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { EscalationStep } from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';
import type { WorkingCalendar } from '../../../platform/sla/business-time';
import type { QueueDefinition } from './queue-registry';

type Queryable = Pick<PoolClient, 'query'>;

export interface QueueMember {
  subjectId: string;
  reference: string;
  title: string;
  href: string;
  waitingSince: Date;
}

export interface CalendarVersion extends WorkingCalendar {
  id: string;
  calendarKey: string;
  version: number;
  status: 'active' | 'retired';
  activatedAt: Date;
  reason: string;
}

export interface PolicyVersion {
  id: string;
  policyKey: string;
  version: number;
  calendarKey: string;
  targetMinutes: number;
  escalationSteps: EscalationStep[];
  status: 'active' | 'retired';
  activatedAt: Date;
  reason: string;
}

export interface WorkQueueRow {
  key: string;
  label: string;
  owningTeam: string;
  slaPolicyKey: string | null;
  escalationRoles: string[];
}

export interface Stay {
  id: string;
  queueKey: string;
  subjectType: string;
  subjectId: string;
  reference: string;
  waitingSince: Date;
  clockStartedAt: Date;
  policyVersionId: string | null;
  calendarVersionId: string | null;
  timeZone: string | null;
  dueAt: Date | null;
  dueVersion: number;
  escalationLevel: number;
  nextEscalationAt: Date | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  aggregateVersion: number;
}

/** Everything a deadline is computed from, loaded once per sweep or view. */
export interface SlaConfig {
  queues: Map<string, WorkQueueRow>;
  activePolicies: Map<string, PolicyVersion>;
  policies: Map<string, PolicyVersion>;
  activeCalendars: Map<string, CalendarVersion>;
  calendars: Map<string, CalendarVersion>;
}

export interface NewStay {
  queueKey: string;
  subjectType: string;
  subjectId: string;
  reference: string;
  waitingSince: Date;
  clockStartedAt: Date;
  policyVersionId: string | null;
  calendarVersionId: string | null;
  timeZone: string | null;
  dueAt: Date | null;
  nextEscalationAt: Date | null;
}

const STAY_COLUMNS = `
  a.id, a.queue_key AS "queueKey", a.subject_type AS "subjectType", a.subject_id AS "subjectId",
  a.reference, a.waiting_since AS "waitingSince", a.clock_started_at AS "clockStartedAt",
  a.policy_version_id AS "policyVersionId", a.calendar_version_id AS "calendarVersionId",
  a.time_zone AS "timeZone", a.due_at AS "dueAt", a.due_version AS "dueVersion",
  a.escalation_level AS "escalationLevel", a.next_escalation_at AS "nextEscalationAt",
  a.assignee_user_id AS "assigneeUserId", u.display_name AS "assigneeName",
  a.aggregate_version AS "aggregateVersion"`;

const CALENDAR_COLUMNS = `
  id, calendar_key AS "calendarKey", version, time_zone AS "timeZone",
  working_days AS "workingDays", to_char(day_start, 'HH24:MI') AS "dayStart",
  to_char(day_end, 'HH24:MI') AS "dayEnd", holidays::text[] AS holidays, status,
  activated_at AS "activatedAt", reason`;

const POLICY_COLUMNS = `
  id, policy_key AS "policyKey", version, calendar_key AS "calendarKey",
  target_minutes AS "targetMinutes", escalation_steps AS "escalationSteps", status,
  activated_at AS "activatedAt", reason`;

@Injectable()
export class QueueRepository {
  constructor(readonly db: DatabaseService) {}

  async members(def: QueueDefinition, q: Queryable = this.db.pool): Promise<QueueMember[]> {
    const res = await q.query<QueueMember>(
      `SELECT subject_id AS "subjectId", reference, title, href, waiting_since AS "waitingSince"
         FROM (${def.membership}) m ORDER BY waiting_since, subject_id`,
    );
    return res.rows;
  }

  async member(def: QueueDefinition, subjectId: string, q: Queryable = this.db.pool): Promise<QueueMember | null> {
    const res = await q.query<QueueMember>(
      `SELECT subject_id AS "subjectId", reference, title, href, waiting_since AS "waitingSince"
         FROM (${def.membership}) m WHERE m.subject_id = $1`,
      [subjectId],
    );
    return res.rows[0] ?? null;
  }

  async countMembers(def: QueueDefinition): Promise<{ count: number; oldestWaitingSince: Date | null }> {
    const res = await this.db.pool.query<{ n: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, min(waiting_since) AS oldest FROM (${def.membership}) m`,
    );
    const row = res.rows[0];
    return { count: Number(row?.n ?? 0), oldestWaitingSince: row?.oldest ?? null };
  }

  async openStays(queueKeys: readonly string[], q: Queryable = this.db.pool): Promise<Stay[]> {
    const res = await q.query<Stay>(
      `SELECT ${STAY_COLUMNS}
         FROM platform.queue_assignment a
         LEFT JOIN iam.user_account u ON u.id = a.assignee_user_id
        WHERE a.status = 'open' AND a.queue_key = ANY($1::text[])`,
      [queueKeys],
    );
    return res.rows;
  }

  async lockOpenStay(tx: PoolClient, queueKey: string, subjectId: string): Promise<Stay | null> {
    const res = await tx.query<Stay>(
      `SELECT ${STAY_COLUMNS}
         FROM platform.queue_assignment a
         LEFT JOIN iam.user_account u ON u.id = a.assignee_user_id
        WHERE a.status = 'open' AND a.queue_key = $1 AND a.subject_id = $2
        FOR UPDATE OF a`,
      [queueKey, subjectId],
    );
    return res.rows[0] ?? null;
  }

  /** Subjects among `subjectIds` that have stayed in this queue before. */
  async returningSubjects(q: Queryable, queueKey: string, subjectIds: string[]): Promise<Set<string>> {
    if (subjectIds.length === 0) return new Set();
    const res = await q.query<{ subject_id: string }>(
      `SELECT DISTINCT subject_id FROM platform.queue_assignment
        WHERE queue_key = $1 AND status = 'closed' AND subject_id = ANY($2::uuid[])`,
      [queueKey, subjectIds],
    );
    return new Set(res.rows.map((r) => r.subject_id));
  }

  /** Opens a stay unless one is already open; returns whether this call opened it. */
  async insertStay(q: Queryable, stay: NewStay): Promise<boolean> {
    const res = await q.query(
      `INSERT INTO platform.queue_assignment
         (queue_key, subject_type, subject_id, reference, waiting_since, clock_started_at,
          policy_version_id, calendar_version_id, time_zone, due_at, next_escalation_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (queue_key, subject_id) WHERE status = 'open' DO NOTHING`,
      [
        stay.queueKey,
        stay.subjectType,
        stay.subjectId,
        stay.reference,
        stay.waitingSince,
        stay.clockStartedAt,
        stay.policyVersionId,
        stay.calendarVersionId,
        stay.timeZone,
        stay.dueAt,
        stay.nextEscalationAt,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async closeStays(q: Queryable, queueKey: string, keepSubjectIds: string[]): Promise<number> {
    const res = await q.query(
      `UPDATE platform.queue_assignment
          SET status = 'closed', closed_at = now(), next_escalation_at = NULL,
              aggregate_version = aggregate_version + 1
        WHERE queue_key = $1 AND status = 'open' AND NOT (subject_id = ANY($2::uuid[]))`,
      [queueKey, keepSubjectIds],
    );
    return res.rowCount ?? 0;
  }

  async loadConfig(q: Queryable = this.db.pool): Promise<SlaConfig> {
    // Sequential: `q` may be a transaction's single connection, which runs one query at a time.
    const queues = await q.query<WorkQueueRow>(
      `SELECT key, label, owning_team AS "owningTeam", sla_policy_key AS "slaPolicyKey",
              escalation_roles AS "escalationRoles"
         FROM platform.work_queue`,
    );
    const policies = await q.query<PolicyVersion>(`SELECT ${POLICY_COLUMNS} FROM platform.sla_policy_version`);
    const calendars = await q.query<CalendarVersion>(`SELECT ${CALENDAR_COLUMNS} FROM platform.business_calendar_version`);
    const config: SlaConfig = {
      queues: new Map(queues.rows.map((r) => [r.key, r])),
      policies: new Map(policies.rows.map((r) => [r.id, r])),
      activePolicies: new Map(policies.rows.filter((r) => r.status === 'active').map((r) => [r.policyKey, r])),
      calendars: new Map(calendars.rows.map((r) => [r.id, r])),
      activeCalendars: new Map(calendars.rows.filter((r) => r.status === 'active').map((r) => [r.calendarKey, r])),
    };
    return config;
  }

  /** Open stays whose calendar version has been replaced, locked for rescheduling. */
  async lockStaysOnRetiredCalendars(tx: PoolClient, limit: number): Promise<Stay[]> {
    const res = await tx.query<Stay>(
      `SELECT ${STAY_COLUMNS}
         FROM platform.queue_assignment a
         JOIN platform.business_calendar_version c ON c.id = a.calendar_version_id
         LEFT JOIN iam.user_account u ON u.id = a.assignee_user_id
        WHERE a.status = 'open' AND c.status = 'retired'
        ORDER BY a.id
        LIMIT $1
        FOR UPDATE OF a SKIP LOCKED`,
      [limit],
    );
    return res.rows;
  }

  /** The next stays with a step due, locked so a concurrent sweep skips them. */
  async lockDueStays(tx: PoolClient, now: Date, limit: number): Promise<Stay[]> {
    const res = await tx.query<Stay>(
      `SELECT ${STAY_COLUMNS}
         FROM platform.queue_assignment a
         LEFT JOIN iam.user_account u ON u.id = a.assignee_user_id
        WHERE a.status = 'open' AND a.next_escalation_at <= $1
        ORDER BY a.next_escalation_at
        LIMIT $2
        FOR UPDATE OF a SKIP LOCKED`,
      [now, limit],
    );
    return res.rows;
  }

  async recordEscalation(tx: PoolClient, stayId: string, step: number, dueVersion: number, notify: string): Promise<boolean> {
    const res = await tx.query(
      `INSERT INTO platform.sla_escalation (queue_assignment_id, step, due_version, notify)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (queue_assignment_id, step, due_version) DO NOTHING`,
      [stayId, step, dueVersion, notify],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setEscalation(tx: PoolClient, stayId: string, level: number, nextAt: Date | null): Promise<void> {
    await tx.query(
      `UPDATE platform.queue_assignment
          SET escalation_level = $2, next_escalation_at = $3, aggregate_version = aggregate_version + 1
        WHERE id = $1`,
      [stayId, level, nextAt],
    );
  }

  async reschedule(
    tx: PoolClient,
    stayId: string,
    change: { calendarVersionId: string; timeZone: string; dueAt: Date; nextEscalationAt: Date | null; newDeadline: boolean },
  ): Promise<void> {
    await tx.query(
      `UPDATE platform.queue_assignment
          SET calendar_version_id = $2, time_zone = $3, due_at = $4,
              next_escalation_at = CASE WHEN $6 THEN $5 ELSE next_escalation_at END,
              due_version = due_version + CASE WHEN $6 THEN 1 ELSE 0 END,
              escalation_level = CASE WHEN $6 THEN 0 ELSE escalation_level END,
              aggregate_version = aggregate_version + 1
        WHERE id = $1`,
      [stayId, change.calendarVersionId, change.timeZone, change.dueAt, change.nextEscalationAt, change.newDeadline],
    );
  }

  async setAssignee(tx: PoolClient, stayId: string, userId: string | null): Promise<number> {
    const res = await tx.query<{ aggregate_version: number }>(
      `UPDATE platform.queue_assignment
          SET assignee_user_id = $2, assigned_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END,
              aggregate_version = aggregate_version + 1
        WHERE id = $1
        RETURNING aggregate_version`,
      [stayId, userId],
    );
    return res.rows[0]!.aggregate_version;
  }

  /** Active JobWork people who hold one of the roles. */
  async eligibleAssignees(roles: readonly string[], userId?: string): Promise<Array<{ userId: string; displayName: string }>> {
    const res = await this.db.pool.query<{ userId: string; displayName: string }>(
      `SELECT DISTINCT u.id AS "userId", coalesce(nullif(u.display_name, ''), u.email) AS "displayName"
         FROM iam.user_account u
         JOIN iam.membership m ON m.user_id = u.id AND m.status = 'active'
         JOIN iam.organization o ON o.id = m.organization_id AND o.type = 'internal' AND o.status = 'active'
         JOIN iam.membership_role mr ON mr.membership_id = m.id
         JOIN iam.role r ON r.id = mr.role_id
        WHERE u.status = 'active' AND r.key = ANY($1::text[])
          AND ($2::uuid IS NULL OR u.id = $2)
        ORDER BY 2`,
      [roles, userId ?? null],
    );
    return res.rows;
  }

  async publishCalendar(
    tx: PoolClient,
    calendarKey: string,
    expectedVersion: number,
    input: { timeZone: string; workingDays: number[]; dayStart: string; dayEnd: string; holidays: string[]; reason: string },
    activatedBy: string,
  ): Promise<CalendarVersion | null> {
    const retired = await tx.query<{ version: number }>(
      `UPDATE platform.business_calendar_version SET status = 'retired', retired_at = now()
        WHERE calendar_key = $1 AND status = 'active' AND version = $2
        RETURNING version`,
      [calendarKey, expectedVersion],
    );
    if ((retired.rowCount ?? 0) === 0) return null;
    const res = await tx.query<CalendarVersion>(
      `INSERT INTO platform.business_calendar_version
         (calendar_key, version, time_zone, working_days, day_start, day_end, holidays, reason, activated_by)
       VALUES ($1, $2, $3, $4::smallint[], $5, $6, $7::date[], $8, $9)
       RETURNING ${CALENDAR_COLUMNS}`,
      [calendarKey, expectedVersion + 1, input.timeZone, input.workingDays, input.dayStart, input.dayEnd, input.holidays, input.reason, activatedBy],
    );
    return res.rows[0]!;
  }

  async calendarExists(calendarKey: string): Promise<boolean> {
    const res = await this.db.pool.query(`SELECT 1 FROM platform.business_calendar_version WHERE calendar_key = $1 LIMIT 1`, [calendarKey]);
    return (res.rowCount ?? 0) > 0;
  }

  async overdueCounts(queueKeys: readonly string[], now: Date): Promise<Map<string, number>> {
    const res = await this.db.pool.query<{ queue_key: string; n: number }>(
      `SELECT queue_key, count(*)::int AS n FROM platform.queue_assignment
        WHERE status = 'open' AND queue_key = ANY($1::text[]) AND due_at <= $2
        GROUP BY queue_key`,
      [queueKeys, now],
    );
    return new Map(res.rows.map((r) => [r.queue_key, Number(r.n)]));
  }
}
