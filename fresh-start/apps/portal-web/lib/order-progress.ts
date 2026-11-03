import type { CustomerOrder, CustomerOrderListItem } from '@jobwork/contracts';

/**
 * Where an order stands on the customer timeline, as a share of the way to delivery
 * (VF-11/VF-12). A position on the curated lanes, never a production estimate.
 */
export const ORDER_PROGRESS: Record<CustomerOrderListItem['status'], number> = {
  payment_needed: 10,
  technical_confirmation: 20,
  manufacturing_in_progress: 45,
  quality_review: 65,
  final_checks: 80,
  on_the_way: 90,
  delivery_confirmation_needed: 95,
  completed: 100,
  cancelled: 0,
};

export type MilestoneState = 'done' | 'current' | 'pending';

export interface Milestone {
  key: 'confirmed' | 'production' | 'delivery' | 'delivered';
  label: string;
  icon: 'check' | 'settings' | 'truck' | 'orders';
  state: MilestoneState;
  at: string | null;
}

/** The reference's four milestones, each a group of the seven curated lanes. */
const GROUPS: Array<{ key: Milestone['key']; label: string; icon: Milestone['icon']; lanes: string[] }> = [
  { key: 'confirmed', label: 'Order Confirmed', icon: 'check', lanes: ['accepted', 'advance', 'technical'] },
  { key: 'production', label: 'In Production', icon: 'settings', lanes: ['production', 'final_checks'] },
  { key: 'delivery', label: 'Out for Delivery', icon: 'truck', lanes: ['shipping'] },
  { key: 'delivered', label: 'Delivered', icon: 'orders', lanes: ['delivered'] },
];

export function milestones(timeline: CustomerOrder['timeline']): Milestone[] {
  return GROUPS.map((group) => {
    const steps = timeline.filter((step) => group.lanes.includes(step.key));
    const state: MilestoneState =
      steps.length > 0 && steps.every((s) => s.state === 'done')
        ? 'done'
        : steps.some((s) => s.state === 'current' || s.state === 'done')
          ? 'current'
          : 'pending';
    const dated = steps.filter((s) => s.at).map((s) => s.at!) ;
    return { key: group.key, label: group.label, icon: group.icon, state, at: dated.length ? dated[dated.length - 1]! : null };
  });
}
