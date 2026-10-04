import type { BusinessCalendar } from '@jobwork/contracts';

/**
 * Wording for service targets (F-11.1). A target is stored in working minutes; people
 * think in working days and hours, so it is said that way — on the calendar's own day
 * length, because "one working day" is nine hours in Chennai and not twenty-four.
 */

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export function formatTarget(minutes: number, calendar: BusinessCalendar | null): string {
  const day = calendar ? minutesOf(calendar.dayEnd) - minutesOf(calendar.dayStart) : 0;
  if (day > 0 && minutes % day === 0) {
    const days = minutes / day;
    return `${days} working ${days === 1 ? 'day' : 'days'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} working ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `${minutes} working minutes`;
}

/** "Mon–Sat 09:30–18:30" — consecutive days collapse into a range. */
export function formatWorkingWeek(calendar: BusinessCalendar): string {
  const days = [...calendar.workingDays].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = days[0]!;
  let prev = start;
  for (const d of [...days.slice(1), Number.NaN]) {
    if (d === prev + 1) {
      prev = d;
      continue;
    }
    runs.push(start === prev ? DAY_NAMES[start - 1]! : `${DAY_NAMES[start - 1]}–${DAY_NAMES[prev - 1]}`);
    start = d;
    prev = d;
  }
  return `${runs.join(', ')} ${calendar.dayStart}–${calendar.dayEnd}`;
}

/** Whether a deadline falls on today's date in its own zone. */
export function isDueToday(dueAt: string | null, timeZone: string | null, now: Date = new Date()): boolean {
  if (!dueAt) return false;
  const day = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'Asia/Kolkata' }).format(d);
  return day(new Date(dueAt)) === day(now);
}
