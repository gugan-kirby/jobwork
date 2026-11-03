import { describe, expect, it } from 'vitest';
import { dueWords, isOpen } from '../lib/invoice-due';

describe('invoice due strip (VF-13)', () => {
  const now = Date.parse('2026-11-03T06:00:00Z');

  it('counts days ahead, today and overdue', () => {
    expect(dueWords({ dueAt: '2026-11-06T06:00:00Z' }, now)).toEqual({ text: 'Due in 3 days (06 Nov 2026)', overdue: false });
    expect(dueWords({ dueAt: '2026-11-03T06:00:00Z' }, now).text).toMatch(/^Due today/);
    expect(dueWords({ dueAt: '2026-11-01T06:00:00Z' }, now)).toEqual({ text: 'Overdue by 2 days (01 Nov 2026)', overdue: true });
  });

  it('treats unpaid and part-paid as open, paid and void as closed', () => {
    expect(['unpaid', 'partially_paid', 'paid', 'void'].map((status) => isOpen({ status } as never))).toEqual([true, true, false, false]);
  });
});
