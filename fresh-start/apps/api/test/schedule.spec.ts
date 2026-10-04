import { describe, expect, it } from 'vitest';
import { customerStatusOf, timelineFor } from '../src/modules/orders/domain/customer-status';
import { evaluateGate, splitSchedule } from '../src/modules/orders/domain/schedule';

/** The IN-08 arithmetic, pinned to the minor unit (doc 10 §4, doc 06 §§7, 13). */
describe('payment schedule and commercial gate (F-08.4/F-08.6)', () => {
  it('splits any total so advance + balance equal the quotation, tax included', () => {
    for (const [total, tax, bp] of [
      [141_600_00, 21_600_00, 5000],
      [1_000_001, 152_543, 3333],
      [99, 15, 5000],
      [7, 1, 10000],
      [7, 1, 0],
    ] as const) {
      const parts = splitSchedule({ totalMinor: total, taxMinor: tax, advanceBp: bp, balanceTrigger: 'before_dispatch' });
      expect(parts.reduce((s, p) => s + p.amountMinor, 0)).toBe(total);
      expect(parts.reduce((s, p) => s + p.taxMinor, 0)).toBe(tax);
      for (const p of parts) expect(p.subtotalMinor + p.taxMinor).toBe(p.amountMinor);
    }
  });

  it('names the instalments and drops a zero part', () => {
    expect(splitSchedule({ totalMinor: 1000, taxMinor: 0, advanceBp: 10000, balanceTrigger: 'net_30' }).map((p) => p.kind)).toEqual(['advance']);
    const none = splitSchedule({ totalMinor: 1000, taxMinor: 0, advanceBp: 0, balanceTrigger: 'net_30' });
    expect(none).toHaveLength(1);
    expect(none[0]).toMatchObject({ kind: 'balance', label: 'Full amount', trigger: 'net_30', seq: 1 });
  });

  const base = {
    currency: 'INR',
    orderTotalMinor: 100_000,
    advanceDueMinor: 50_000,
    advancePaidMinor: 0,
    otherOpenReceivablesMinor: 0,
    credit: null,
    activeHolds: [],
    today: '2026-10-04',
  };

  it('passes on a paid advance, or on credit that covers the exposure', () => {
    expect(evaluateGate({ ...base, advancePaidMinor: 50_000 })).toMatchObject({ pass: true, basis: 'advance_paid' });
    expect(evaluateGate({ ...base, credit: { limitMinor: 100_000, currency: 'INR', validUntil: null } })).toMatchObject({ pass: true, basis: 'credit_covered', creditExposureMinor: 100_000 });
  });

  it('refuses with reasons a reader can act on', () => {
    const unpaid = evaluateGate(base);
    expect(unpaid.pass).toBe(false);
    expect(unpaid.reasons.join(' ')).toMatch(/Advance of INR 500\.00 not yet received/);
    const over = evaluateGate({ ...base, otherOpenReceivablesMinor: 1, credit: { limitMinor: 100_000, currency: 'INR', validUntil: null } });
    expect(over.reasons.join(' ')).toMatch(/would be exceeded/);
    const lapsed = evaluateGate({ ...base, credit: { limitMinor: 1_000_000, currency: 'INR', validUntil: '2026-01-01' } });
    expect(lapsed.pass).toBe(false);
    const held = evaluateGate({ ...base, advancePaidMinor: 50_000, activeHolds: [{ reason: 'Cheque bounced' }] });
    expect(held).toMatchObject({ pass: false, activeHolds: 1 });
    expect(held.reasons[0]).toMatch(/Cheque bounced/);
  });

  it('projects internal order states to the customer’s words and a curated timeline', () => {
    expect(customerStatusOf('pending_commercial_release')).toBe('payment_needed');
    expect(customerStatusOf('in_supplier_to_jobwork_transit')).toBe('final_checks');
    const steps = timelineFor({ status: 'technical_confirmation', acceptedAt: '2026-10-01T00:00:00Z', advanceInvoiced: true, advancePaidAt: '2026-10-02T00:00:00Z', commercialReleasedAt: '2026-10-02T00:00:00Z', releaseBasis: 'advance_paid' });
    expect(steps.map((s) => `${s.key}:${s.state}`).slice(0, 3)).toEqual(['accepted:done', 'advance:done', 'technical:current']);
    // Nothing in the customer's timeline names a supplier or a place.
    expect(JSON.stringify(steps)).not.toMatch(/supplier|workshop|vendor/i);
  });
});
