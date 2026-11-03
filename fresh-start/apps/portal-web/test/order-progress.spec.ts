import { describe, expect, it } from 'vitest';
import { milestones, ORDER_PROGRESS } from '../lib/order-progress';

/** VF-12: the four reference milestones are groups of the seven curated lanes. */
describe('order milestones', () => {
  const lane = (key: string, state: 'done' | 'current' | 'pending', at: string | null = null) => ({ key, label: key, state, at, detail: null });

  it('marks a group done only when every lane in it is done, and current while any is under way', () => {
    const result = milestones([
      lane('accepted', 'done', '2026-10-03'),
      lane('advance', 'done', '2026-10-04'),
      lane('technical', 'done', '2026-10-05'),
      lane('production', 'current', '2026-10-06'),
      lane('final_checks', 'pending'),
      lane('shipping', 'pending'),
      lane('delivered', 'pending'),
    ]);
    expect(result.map((m) => [m.key, m.state])).toEqual([
      ['confirmed', 'done'],
      ['production', 'current'],
      ['delivery', 'pending'],
      ['delivered', 'pending'],
    ]);
    expect(result[0]!.at).toBe('2026-10-05');
  });

  it('runs from payment to completion without going backwards', () => {
    const order = ['payment_needed', 'technical_confirmation', 'manufacturing_in_progress', 'quality_review', 'final_checks', 'on_the_way', 'delivery_confirmation_needed', 'completed'] as const;
    const values = order.map((s) => ORDER_PROGRESS[s]);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(values.at(-1)).toBe(100);
  });
});
