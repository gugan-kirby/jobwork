/**
 * Working-time arithmetic for SLA deadlines (doc 07 §11, `BR-SYS-07`).
 *
 * A deadline is "N working minutes after the item started waiting", read in the
 * calendar's own time zone: weekends, holidays and nights do not count. Every window is
 * turned into instants before any arithmetic, so a day that gains or loses an hour to
 * daylight saving is measured by the clock on the wall, not by a fixed 24 hours.
 * India keeps no daylight saving; the calendar is a version, and the next one may not
 * be in India.
 */

export interface WorkingCalendar {
  /** IANA zone name, e.g. `Asia/Kolkata`. */
  timeZone: string;
  /** ISO weekdays: 1 = Monday … 7 = Sunday. */
  workingDays: readonly number[];
  /** Local opening and closing time, `HH:MM` or `HH:MM:SS`. */
  dayStart: string;
  dayEnd: string;
  /** Local dates, `YYYY-MM-DD`. */
  holidays: readonly string[];
}

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Ten years of searching for a working minute means the calendar has none. */
const MAX_DAYS = 3660;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(instantMs: number, timeZone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts['year']!,
    month: parts['month']!,
    day: parts['day']!,
    hour: parts['hour']!,
    minute: parts['minute']!,
    second: parts['second']!,
  };
}

/** The zone's offset from UTC at an instant, in milliseconds (east positive). */
function offsetAt(instantMs: number, timeZone: string): number {
  const p = localParts(instantMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** Throws a RangeError for anything `Intl` does not know as a zone. */
export function assertTimeZone(timeZone: string): void {
  formatter(timeZone);
}

/**
 * The instant a local wall-clock time names. A time that happens twice (clocks going
 * back) resolves to the first; a time that never happens (clocks going forward) moves
 * forward by the gap — the same choices as `Temporal`'s `compatible` disambiguation.
 */
export function localToInstant(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm, ss] = time.split(':').map(Number) as [number, number, number | undefined];
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss ?? 0);
  const before = offsetAt(naive - DAY, timeZone);
  const after = offsetAt(naive + DAY, timeZone);
  const valid = [naive - before, naive - after].filter((c) => offsetAt(c, timeZone) === naive - c);
  if (valid.length > 0) return Math.min(...valid);
  return naive - before;
}

function localDate(instantMs: number, timeZone: string): string {
  const p = localParts(instantMs, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

function isWorkingDate(date: string, calendar: WorkingCalendar): boolean {
  return calendar.workingDays.includes(isoWeekday(date)) && !calendar.holidays.includes(date);
}

/**
 * The instant `minutes` working minutes after `start`. Time before opening, after
 * closing, at weekends and on holidays does not count. A deadline that lands exactly on
 * closing time is due at closing time, not the next morning.
 */
export function addWorkingMinutes(start: Date, minutes: number, calendar: WorkingCalendar): Date {
  if (minutes <= 0) return new Date(start.getTime());
  let remaining = minutes * MINUTE;
  let cursor = start.getTime();
  let date = localDate(cursor, calendar.timeZone);
  for (let i = 0; i < MAX_DAYS; i += 1) {
    if (isWorkingDate(date, calendar)) {
      const open = localToInstant(date, calendar.dayStart, calendar.timeZone);
      const close = localToInstant(date, calendar.dayEnd, calendar.timeZone);
      if (cursor < open) cursor = open;
      if (cursor < close) {
        const available = close - cursor;
        if (remaining <= available) return new Date(cursor + remaining);
        remaining -= available;
      }
    }
    date = nextDate(date);
    cursor = localToInstant(date, '00:00', calendar.timeZone);
  }
  throw new RangeError('calendar has no working time');
}
