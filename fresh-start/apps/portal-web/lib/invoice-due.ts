import type { CustomerInvoice } from '@jobwork/contracts';

/** VF-13: the due strip's words for an open invoice, and the date format the cards use. */

const DAY = 24 * 60 * 60 * 1000;

export const fmt = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

export function isOpen(i: Pick<CustomerInvoice, 'status'>): boolean {
  return i.status === 'unpaid' || i.status === 'partially_paid';
}

export function dueWords(i: Pick<CustomerInvoice, 'dueAt'>, now: number): { text: string; overdue: boolean } {
  const days = Math.ceil((Date.parse(i.dueAt) - now) / DAY);
  if (days < 0) return { text: `Overdue by ${-days} day${days === -1 ? '' : 's'} (${fmt(i.dueAt)})`, overdue: true };
  if (days === 0) return { text: `Due today (${fmt(i.dueAt)})`, overdue: false };
  return { text: `Due in ${days} day${days === 1 ? '' : 's'} (${fmt(i.dueAt)})`, overdue: false };
}
