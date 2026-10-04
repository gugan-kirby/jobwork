import type { CustomerOrderStatus, CustomerOrderTimelineStep, SalesOrderStatus } from '@jobwork/contracts';

/**
 * The customer-facing projection of an order (doc 06 §13): action-oriented words, never
 * the internal state, never a supplier's name or location. The timeline is curated — a
 * handful of lanes the customer recognises, each either done, current or ahead.
 */

export const CUSTOMER_STATUS_LABEL: Record<CustomerOrderStatus, string> = {
  payment_needed: 'Payment needed',
  technical_confirmation: 'Technical confirmation',
  manufacturing_in_progress: 'Manufacturing in progress',
  quality_review: 'Quality review',
  final_checks: 'Final checks',
  on_the_way: 'On the way',
  delivery_confirmation_needed: 'Delivery confirmation needed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export function customerStatusOf(status: SalesOrderStatus): CustomerOrderStatus {
  switch (status) {
    case 'pending_commercial_release':
      return 'payment_needed';
    case 'pending_technical_release':
    case 'planning':
      return 'technical_confirmation';
    case 'released_to_production':
    case 'in_production':
      return 'manufacturing_in_progress';
    case 'quality_hold':
    case 'quality_released':
      return 'quality_review';
    case 'ready_supplier_dispatch':
    case 'in_supplier_to_jobwork_transit':
    case 'received_jobwork':
    case 'ready_customer_dispatch':
      return 'final_checks';
    case 'in_customer_transit':
      return 'on_the_way';
    case 'delivered':
      return 'delivery_confirmation_needed';
    case 'customer_accepted':
    case 'closed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
  }
}

const LANES: Array<{ key: string; label: string; reachedBy: ReadonlySet<CustomerOrderStatus> }> = [
  { key: 'accepted', label: 'Quotation accepted', reachedBy: new Set(['payment_needed', 'technical_confirmation', 'manufacturing_in_progress', 'quality_review', 'final_checks', 'on_the_way', 'delivery_confirmation_needed', 'completed']) },
  { key: 'advance', label: 'Advance payment', reachedBy: new Set(['technical_confirmation', 'manufacturing_in_progress', 'quality_review', 'final_checks', 'on_the_way', 'delivery_confirmation_needed', 'completed']) },
  { key: 'technical', label: 'Technical confirmation', reachedBy: new Set(['manufacturing_in_progress', 'quality_review', 'final_checks', 'on_the_way', 'delivery_confirmation_needed', 'completed']) },
  { key: 'production', label: 'Manufacturing', reachedBy: new Set(['final_checks', 'on_the_way', 'delivery_confirmation_needed', 'completed']) },
  { key: 'final_checks', label: 'Final checks', reachedBy: new Set(['on_the_way', 'delivery_confirmation_needed', 'completed']) },
  { key: 'shipping', label: 'On the way', reachedBy: new Set(['delivery_confirmation_needed', 'completed']) },
  { key: 'delivered', label: 'Delivered', reachedBy: new Set(['completed']) },
];

const CURRENT_LANE: Record<CustomerOrderStatus, string | null> = {
  payment_needed: 'advance',
  technical_confirmation: 'technical',
  manufacturing_in_progress: 'production',
  quality_review: 'production',
  final_checks: 'final_checks',
  on_the_way: 'shipping',
  delivery_confirmation_needed: 'delivered',
  completed: null,
  cancelled: null,
};

export function timelineFor(input: {
  status: CustomerOrderStatus;
  acceptedAt: string;
  advanceInvoiced: boolean;
  advancePaidAt: string | null;
  commercialReleasedAt: string | null;
  releaseBasis: string | null;
  baselineReleasedAt?: string | null;
  progress?: Array<{ label: string; at: string }>;
  scheduleUnderReview?: boolean;
}): CustomerOrderTimelineStep[] {
  const current = CURRENT_LANE[input.status];
  return LANES.filter((lane) => lane.key !== 'advance' || input.advanceInvoiced || input.releaseBasis === 'credit_covered').map((lane) => {
    const done = lane.reachedBy.has(input.status);
    const state: CustomerOrderTimelineStep['state'] = done ? 'done' : lane.key === current ? 'current' : 'pending';
    let at: string | null = null;
    let detail: string | null = null;
    if (lane.key === 'accepted') at = input.acceptedAt;
    if (lane.key === 'technical' && done) at = input.baselineReleasedAt ?? null;
    const latest = input.progress?.[input.progress.length - 1];
    if (lane.key === 'advance') {
      at = input.advancePaidAt ?? (done ? input.commercialReleasedAt : null);
      if (done && input.releaseBasis === 'credit_covered') detail = 'Covered by your approved credit terms.';
      if (state === 'current') detail = 'Pay the advance invoice to release the order.';
    }
    if (lane.key === 'technical' && state === 'current') detail = 'JobWork engineering is confirming the technical baseline. We will ask if a drawing or change needs your approval.';
    if (lane.key === 'production' && state === 'current') {
      detail =
        input.status === 'quality_review'
          ? 'An internal quality review is under way. We will come back to you only if a decision is needed.'
          : input.scheduleUnderReview
            ? 'Schedule under review by JobWork. We will confirm any change to your delivery date.'
            : latest
              ? `Latest checkpoint: ${latest.label}.`
              : 'Your parts are being made. Checkpoints appear here as JobWork verifies them.';
      at = latest?.at ?? null;
    }
    if (lane.key === 'final_checks' && state === 'current') detail = 'Incoming inspection and packing at JobWork.';
    if (lane.key === 'shipping' && state === 'current') detail = 'Dispatched to your delivery site.';
    if (lane.key === 'delivered' && state === 'current') detail = 'Confirm receipt, or report an issue.';
    return { key: lane.key, label: lane.label, state, at, detail };
  });
}

export function nextStepFor(input: {
  status: CustomerOrderStatus;
  openInvoice: { number: string; kind: string } | null;
}): { owner: 'you' | 'jobwork'; label: string; detail: string } {
  switch (input.status) {
    case 'payment_needed':
      return {
        owner: 'you',
        label: 'Pay the advance',
        detail: input.openInvoice
          ? `Invoice ${input.openInvoice.number} is open. Once it is settled the order is released to engineering.`
          : 'JobWork will issue the advance invoice shortly.',
      };
    case 'technical_confirmation':
      return { owner: 'jobwork', label: 'Technical confirmation', detail: 'Engineering is confirming the baseline before work starts.' };
    case 'manufacturing_in_progress':
      return { owner: 'jobwork', label: 'Manufacturing', detail: 'Production is under way. Nothing is needed from you.' };
    case 'quality_review':
      return { owner: 'jobwork', label: 'Quality review', detail: 'An internal review is under way. We only come to you if a decision is needed.' };
    case 'final_checks':
      return { owner: 'jobwork', label: 'Final checks', detail: 'Incoming inspection and packing at JobWork.' };
    case 'on_the_way':
      return { owner: 'you', label: 'Prepare to receive', detail: 'Your consignment is on the way. Have receiving ready.' };
    case 'delivery_confirmation_needed':
      return { owner: 'you', label: 'Confirm delivery', detail: 'Accept the delivery or report an issue.' };
    case 'completed':
      return { owner: 'jobwork', label: 'Completed', detail: 'This order is closed. Reorder from the enquiry whenever you need the same part again.' };
    case 'cancelled':
      return { owner: 'jobwork', label: 'Cancelled', detail: 'This order was cancelled.' };
  }
}
