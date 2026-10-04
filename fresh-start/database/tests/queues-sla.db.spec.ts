import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { registerPgTypeParsers } from '../src/pg-types';

registerPgTypeParsers();

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_sladb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * The queue schema's teeth (F-11.1): a deadline can always be explained by the versions
 * it was computed from, those versions never change, a subject has one open stay per
 * queue, and a step fires once per deadline whatever races for it.
 */
describe('queues and SLA schema constraints (F-11.1)', () => {
  let pg: Client;
  let userId: string;
  let policyId: string;
  let calendarId: string;

  const one = async <T>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;

  async function stay(subjectId: string, queueKey = 'enquiries_awaiting_triage'): Promise<string> {
    return (await one<{ id: string }>(
      `INSERT INTO platform.queue_assignment
         (queue_key, subject_type, subject_id, reference, waiting_since, clock_started_at,
          policy_version_id, calendar_version_id, time_zone, due_at, next_escalation_at)
       VALUES ($1, 'enquiry', $2, 'ENQ-2026-0001', now(), now(), $3, $4, 'Asia/Kolkata', now() + interval '1 day', now() + interval '1 day')
       RETURNING id`,
      [queueKey, subjectId, policyId, calendarId],
    )).id;
  }

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
    userId = (await one<{ id: string }>(`INSERT INTO iam.user_account (email, status) VALUES ('ops@jobwork.test', 'active') RETURNING id`)).id;
    policyId = (await one<{ id: string }>(`SELECT id FROM platform.sla_policy_version WHERE policy_key = 'enquiries_awaiting_triage'`)).id;
    calendarId = (await one<{ id: string }>(`SELECT id FROM platform.business_calendar_version WHERE calendar_key = 'chennai'`)).id;
  });

  afterAll(async () => {
    await pg?.end();
  });

  it('seeds one active Chennai calendar and a policy for every queue with a target', async () => {
    const calendar = await one<{ time_zone: string; working_days: number[] }>(
      `SELECT time_zone, working_days FROM platform.business_calendar_version WHERE calendar_key = 'chennai' AND status = 'active'`,
    );
    expect(calendar).toEqual({ time_zone: 'Asia/Kolkata', working_days: [1, 2, 3, 4, 5, 6] });
    const orphans = await pg.query(
      `SELECT q.key FROM platform.work_queue q
        WHERE q.sla_policy_key IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM platform.sla_policy_version p WHERE p.policy_key = q.sla_policy_key AND p.status = 'active')`,
    );
    expect(orphans.rows).toEqual([]);
  });

  it('never rewrites a calendar or policy version, only retires it', async () => {
    await expect(pg.query(`UPDATE platform.business_calendar_version SET holidays = '{}' WHERE id = $1`, [calendarId])).rejects.toThrow(/immutable/);
    await expect(pg.query(`UPDATE platform.sla_policy_version SET target_minutes = 1 WHERE id = $1`, [policyId])).rejects.toThrow(/immutable/);
    await expect(pg.query(`DELETE FROM platform.sla_policy_version WHERE id = $1`, [policyId])).rejects.toThrow(/never deleted/);
    // Retiring is the one permitted change, and it cannot smuggle an edit along with it.
    await expect(pg.query(
      `UPDATE platform.sla_policy_version SET status = 'retired', retired_at = now(), target_minutes = 1 WHERE id = $1`,
      [policyId],
    )).rejects.toThrow(/immutable/);
  });

  it('keeps one active version per key and refuses an unknown time zone', async () => {
    await expect(pg.query(
      `INSERT INTO platform.business_calendar_version (calendar_key, version, time_zone, working_days, day_start, day_end, reason)
       VALUES ('chennai', 2, 'Asia/Kolkata', ARRAY[1,2,3,4,5]::smallint[], '09:30', '18:30', 'second active')`,
    )).rejects.toThrow(/uq_calendar_active/);
    await expect(pg.query(
      `INSERT INTO platform.business_calendar_version (calendar_key, version, time_zone, working_days, day_start, day_end, reason)
       VALUES ('mumbai', 1, 'Asia/Mumbai', ARRAY[1,2,3,4,5]::smallint[], '09:30', '18:30', 'not a zone')`,
    )).rejects.toThrow(/time zone/);
    await expect(pg.query(
      `INSERT INTO platform.business_calendar_version (calendar_key, version, time_zone, working_days, day_start, day_end, reason)
       VALUES ('pune', 1, 'Asia/Kolkata', ARRAY[1,8]::smallint[], '09:30', '18:30', 'day eight')`,
    )).rejects.toThrow(/working_days/);
  });

  it('holds one open stay per subject and queue, and lets a closed stay become history', async () => {
    const subject = (await one<{ id: string }>(`SELECT gen_random_uuid() AS id`)).id;
    const first = await stay(subject);
    await expect(stay(subject)).rejects.toThrow(/uq_assignment_open/);
    // The same subject may wait in a different queue at the same time.
    expect(await stay(subject, 'clarifications_awaiting_customer')).toBeTruthy();

    await expect(pg.query(`UPDATE platform.queue_assignment SET clock_started_at = now() - interval '1 day' WHERE id = $1`, [first])).rejects.toThrow(/keeps its subject/);
    await expect(pg.query(`UPDATE platform.queue_assignment SET assignee_user_id = $2 WHERE id = $1`, [first, userId])).rejects.toThrow(/chk_assignment_assigned/);
    await pg.query(`UPDATE platform.queue_assignment SET assignee_user_id = $2, assigned_at = now() WHERE id = $1`, [first, userId]);

    await pg.query(`UPDATE platform.queue_assignment SET status = 'closed', closed_at = now() WHERE id = $1`, [first]);
    await expect(pg.query(`UPDATE platform.queue_assignment SET status = 'open', closed_at = NULL WHERE id = $1`, [first])).rejects.toThrow(/history/);
    await expect(pg.query(`DELETE FROM platform.queue_assignment WHERE id = $1`, [first])).rejects.toThrow(/never deleted/);
    // A return to the queue is a new stay.
    expect(await stay(subject)).not.toBe(first);
  });

  it('requires a deadline to name its policy, calendar and zone together', async () => {
    await expect(pg.query(
      `INSERT INTO platform.queue_assignment (queue_key, subject_type, subject_id, reference, waiting_since, clock_started_at, policy_version_id, due_at)
       VALUES ('enquiries_awaiting_triage', 'enquiry', gen_random_uuid(), 'ENQ', now(), now(), $1, now())`,
      [policyId],
    )).rejects.toThrow(/chk_assignment_deadline/);
    // A watch list carries no deadline at all.
    expect(await one(
      `INSERT INTO platform.queue_assignment (queue_key, subject_type, subject_id, reference, waiting_since, clock_started_at)
       VALUES ('invitations_pending', 'invitation', gen_random_uuid(), 'Invitation', now(), now()) RETURNING id`,
    )).toBeTruthy();
  });

  it('fires a step once per deadline and never edits a fired step', async () => {
    const id = await stay((await one<{ id: string }>(`SELECT gen_random_uuid() AS id`)).id);
    const fire = (step: number, dueVersion: number) => pg.query(
      `INSERT INTO platform.sla_escalation (queue_assignment_id, step, due_version, notify) VALUES ($1, $2, $3, 'owner')
       ON CONFLICT (queue_assignment_id, step, due_version) DO NOTHING`,
      [id, step, dueVersion],
    );
    expect((await fire(1, 1)).rowCount).toBe(1);
    expect((await fire(1, 1)).rowCount).toBe(0);
    // A moved deadline is a new due_version, so the same step may fire again for it.
    expect((await fire(1, 2)).rowCount).toBe(1);
    await expect(pg.query(`UPDATE platform.sla_escalation SET step = 3 WHERE queue_assignment_id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(pg.query(`UPDATE platform.queue_assignment SET due_version = 0 WHERE id = $1`, [id])).rejects.toThrow();
  });
});
