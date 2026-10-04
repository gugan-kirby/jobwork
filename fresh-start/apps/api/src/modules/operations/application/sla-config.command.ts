import { Injectable } from '@nestjs/common';
import type { BusinessCalendar, PublishCalendarRequest, SlaConfiguration, SlaPolicy } from '@jobwork/contracts';
import { requireRole, requireTransactionalStrength, type Actor } from '../../iam';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError, VersionConflict } from '../../../platform/http/domain-error';
import { assertTimeZone } from '../../../platform/sla/business-time';
import { QueueRepository, type CalendarVersion, type PolicyVersion } from '../infrastructure/queue.repository';

export class CalendarNotFound extends DomainError {
  constructor() {
    super('CALENDAR_NOT_FOUND', 404, 'No such business calendar');
  }
}

export class InvalidCalendar extends DomainError {
  constructor(detail: string) {
    super('CALENDAR_INVALID', 422, 'The calendar cannot be used', detail);
  }
}

class InternalOnly extends DomainError {
  constructor() {
    super('NOT_AUTHORIZED', 403, 'Internal audience only');
  }
}

const toCalendar = (c: CalendarVersion): BusinessCalendar => ({
  calendarKey: c.calendarKey,
  version: c.version,
  timeZone: c.timeZone,
  workingDays: [...c.workingDays],
  dayStart: c.dayStart,
  dayEnd: c.dayEnd,
  holidays: [...c.holidays].sort(),
  activatedAt: c.activatedAt.toISOString(),
  reason: c.reason,
});

const toPolicy = (p: PolicyVersion): SlaPolicy => ({
  policyKey: p.policyKey,
  version: p.version,
  calendarKey: p.calendarKey,
  targetMinutes: p.targetMinutes,
  escalationSteps: p.escalationSteps,
  activatedAt: p.activatedAt.toISOString(),
  reason: p.reason,
});

/**
 * The SLA configuration surface (UC-35, intentionally thin for MVP): every JobWork person
 * can read which targets and which calendar are in force; a platform administrator
 * publishes a new calendar version — a declared holiday, a changed working week — and the
 * next sweep moves the deadlines it affects. Versions are never edited (`FR-1006`).
 */
@Injectable()
export class SlaConfigService {
  constructor(
    private readonly repo: QueueRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async configuration(actor: Actor): Promise<SlaConfiguration> {
    if (!actor.isInternal) throw new InternalOnly();
    const config = await this.repo.loadConfig();
    return {
      calendars: [...config.activeCalendars.values()].map(toCalendar),
      policies: [...config.activePolicies.values()].sort((a, b) => a.policyKey.localeCompare(b.policyKey)).map(toPolicy),
    };
  }

  async publishCalendar(actor: Actor, calendarKey: string, input: PublishCalendarRequest, opts: { idempotencyKey?: string | undefined }): Promise<BusinessCalendar> {
    if (!actor.isInternal) throw new InternalOnly();
    requireRole(actor, 'platform_admin');
    requireTransactionalStrength(actor);
    if (!(await this.repo.calendarExists(calendarKey))) throw new CalendarNotFound();
    try {
      assertTimeZone(input.timeZone);
    } catch {
      throw new InvalidCalendar(`“${input.timeZone}” is not a time zone name, e.g. Asia/Kolkata.`);
    }
    if (input.dayEnd <= input.dayStart) throw new InvalidCalendar('The working day must end after it starts.');
    const workingDays = [...new Set(input.workingDays)].sort();
    const holidays = [...new Set(input.holidays)].sort();
    const published = await this.executor.execute(
      {
        operation: 'platform.calendar-publish',
        handler: async (tx, _ctx, cmd: PublishCalendarRequest) => {
          const row = await this.repo.publishCalendar(
            tx,
            calendarKey,
            cmd.expectedVersion,
            { timeZone: cmd.timeZone, workingDays, dayStart: cmd.dayStart, dayEnd: cmd.dayEnd, holidays, reason: cmd.reason },
            actor.userId,
          );
          if (!row) throw new VersionConflict();
          return {
            result: toCalendar(row),
            audit: [
              {
                action: 'platform.calendar_published',
                subjectType: 'business_calendar',
                subjectId: row.id,
                subjectVersion: row.version,
                reason: cmd.reason,
                data: { calendarKey, version: row.version, timeZone: row.timeZone, workingDays, holidayCount: holidays.length },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return published;
  }
}
