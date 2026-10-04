import { describe, expect, it } from 'vitest';
import { addWorkingMinutes, assertTimeZone, localToInstant, type WorkingCalendar } from '../src/platform/sla/business-time';

/**
 * Deadline arithmetic (F-11.1; doc 13 §9 "timezone/DST, deadline at expiration
 * instant"). Every expected instant below is worked by hand from the calendar, written
 * as UTC so the zone conversion is part of what is checked.
 */

const CHENNAI: WorkingCalendar = {
  timeZone: 'Asia/Kolkata',
  workingDays: [1, 2, 3, 4, 5, 6],
  dayStart: '09:30',
  dayEnd: '18:30',
  holidays: ['2026-10-02'],
};

const at = (iso: string): Date => new Date(iso);
const add = (start: string, minutes: number, calendar: WorkingCalendar = CHENNAI): string =>
  addWorkingMinutes(at(start), minutes, calendar).toISOString();

describe('working-time deadlines (F-11.1)', () => {
  it('skips a holiday and keeps Saturday as a working day in Chennai', () => {
    // Thu 1 Oct 17:30 IST: one hour left today; Fri 2 Oct is Gandhi Jayanti;
    // the remaining eight hours run Sat 3 Oct 09:30 → 17:30 IST.
    expect(add('2026-10-01T12:00:00Z', 540)).toBe('2026-10-03T12:00:00.000Z');
  });

  it('carries over Sunday to Monday morning', () => {
    // Sat 3 Oct 18:00 IST: thirty minutes left; Sunday is closed; Mon 09:30 + 30 = 10:00 IST.
    expect(add('2026-10-03T12:30:00Z', 60)).toBe('2026-10-05T04:30:00.000Z');
  });

  it('starts the clock at opening time when work arrives outside hours', () => {
    // Mon 5 Oct 07:00 IST → counts from 09:30.
    expect(add('2026-10-05T01:30:00Z', 30)).toBe('2026-10-05T04:30:00.000Z');
    // Mon 5 Oct 20:00 IST → counts from Tue 09:30.
    expect(add('2026-10-05T14:30:00Z', 30)).toBe('2026-10-06T04:30:00.000Z');
  });

  it('is due at closing time when the target ends exactly there', () => {
    // Mon 09:30 IST + one full working day = Mon 18:30 IST, not Tue 09:30.
    expect(add('2026-10-05T04:00:00Z', 540)).toBe('2026-10-05T13:00:00.000Z');
  });

  it('measures the short spring-forward day by the clock on the wall (Europe/London)', () => {
    const nights: WorkingCalendar = { timeZone: 'Europe/London', workingDays: [1, 2, 3, 4, 5, 6, 7], dayStart: '00:00', dayEnd: '06:00', holidays: [] };
    // Sun 29 Mar 2026: 00:00 GMT → 06:00 BST is five real hours. Six hours of work
    // leaves one for Mon 30 Mar, which opens at 00:00 BST = 29 Mar 23:00Z.
    expect(add('2026-03-29T00:00:00Z', 360, nights)).toBe('2026-03-30T00:00:00.000Z');
  });

  it('measures the long fall-back day by the clock on the wall (Europe/London)', () => {
    const nights: WorkingCalendar = { timeZone: 'Europe/London', workingDays: [1, 2, 3, 4, 5, 6, 7], dayStart: '00:00', dayEnd: '06:00', holidays: [] };
    // Sun 25 Oct 2026: 00:00 BST (24 Oct 23:00Z) → 06:00 GMT is seven real hours.
    expect(add('2026-10-24T23:00:00Z', 390, nights)).toBe('2026-10-25T05:30:00.000Z');
  });

  it('opens Monday on daylight time after a weekend that changed the clocks (America/New_York)', () => {
    const office: WorkingCalendar = { timeZone: 'America/New_York', workingDays: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '17:00', holidays: [] };
    // Fri 6 Mar 16:00 EST (21:00Z): one hour today; Mon 9 Mar opens 09:00 EDT = 13:00Z.
    expect(add('2026-03-06T21:00:00Z', 120, office)).toBe('2026-03-09T14:00:00.000Z');
    // Fri 30 Oct 16:00 EDT (20:00Z): one hour today; Mon 2 Nov opens 09:00 EST = 14:00Z.
    expect(add('2026-10-30T20:00:00Z', 120, office)).toBe('2026-11-02T15:00:00.000Z');
  });

  it('resolves a wall-clock time that happens twice, or never, the way Temporal does', () => {
    expect(new Date(localToInstant('2026-10-05', '09:30', 'Asia/Kolkata')).toISOString()).toBe('2026-10-05T04:00:00.000Z');
    // 01:30 on 25 Oct happens in BST and again in GMT: the first one.
    expect(new Date(localToInstant('2026-10-25', '01:30', 'Europe/London')).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    // 01:30 on 29 Mar never happens in London: moved forward by the gap, to 02:30 BST.
    expect(new Date(localToInstant('2026-03-29', '01:30', 'Europe/London')).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // 02:30 on 8 Mar never happens in New York: 03:30 EDT.
    expect(new Date(localToInstant('2026-03-08', '02:30', 'America/New_York')).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('refuses a zone name nobody keeps', () => {
    expect(() => assertTimeZone('Asia/Mumbai')).toThrow(RangeError);
    expect(() => assertTimeZone('Asia/Kolkata')).not.toThrow();
  });
});
