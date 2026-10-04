'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CustomerOrderListItem } from '@jobwork/contracts';
import {
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  FilterChips,
  LoadingState,
  Page,
  RecordCard,
  RecordList,
  Stack,
  StatusChip,
  formatMoney,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * Orders (prototype tile 11, corrected): JobWork's commitment to you, from acceptance to
 * delivery. Status words are the customer's (doc 06 §13) and nothing names a workshop.
 */

const TONE: Record<CustomerOrderListItem['status'], Tone> = {
  payment_needed: 'attention',
  technical_confirmation: 'progress',
  manufacturing_in_progress: 'progress',
  quality_review: 'progress',
  final_checks: 'progress',
  on_the_way: 'progress',
  delivery_confirmation_needed: 'attention',
  completed: 'positive',
  cancelled: 'neutral',
};

type Filter = 'all' | 'needs_you' | 'in_progress' | 'completed';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'needs_you', label: 'Needs you' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
];

function bucket(order: CustomerOrderListItem): Filter {
  if (order.actionNeeded || order.status === 'payment_needed' || order.status === 'delivery_confirmation_needed') return 'needs_you';
  if (order.status === 'completed' || order.status === 'cancelled') return 'completed';
  return 'in_progress';
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<CustomerOrderListItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    api<{ orders: CustomerOrderListItem[] }>('/orders')
      .then((res) => setOrders(res.orders))
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  const all = useMemo(() => orders ?? [], [orders]);
  const counts = useMemo(() => {
    const map = new Map<Filter, number>();
    for (const o of all) map.set(bucket(o), (map.get(bucket(o)) ?? 0) + 1);
    return map;
  }, [all]);
  const visible = all.filter((o) => filter === 'all' || bucket(o) === filter);

  return (
    <Page title="Orders" back={{ href: '/', label: 'Back to home' }} description="Work JobWork is doing for you, from acceptance to delivery.">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        <FilterChips
          label="Filter orders"
          value={filter}
          options={FILTERS.map((f) => ({ ...f, count: f.value === 'all' ? all.length : counts.get(f.value) ?? 0 }))}
          onChange={setFilter}
        />
        {error ? null : orders === null ? (
          <Card>
            <LoadingState label="Loading your orders" />
          </Card>
        ) : visible.length === 0 ? (
          <Card>
            <EmptyState
              title={all.length === 0 ? 'No orders yet' : 'Nothing matches'}
              detail={
                all.length === 0
                  ? 'An order starts the moment you accept a JobWork quotation. From then on you follow it here: what is confirmed, what is in production, what has shipped.'
                  : 'Try another filter.'
              }
              action={
                all.length === 0 ? (
                  <ButtonLink href="/quotations" variant="secondary">
                    See your quotations
                  </ButtonLink>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <RecordList>
            {visible.map((o) => (
              <RecordCard
                key={o.orderId}
                href={`/orders/${o.orderId}`}
                reference={o.number}
                title={o.title}
                caption={o.actionNeeded ? o.actionNeeded.label : o.expectedDeliveryAt ? `Expected by ${o.expectedDeliveryAt}` : `Accepted ${o.acceptedAt.slice(0, 10)}`}
                figure={formatMoney({ amountMinor: o.totalMinor, currency: o.currency })}
                status={<StatusChip tone={TONE[o.status]}>{o.statusLabel}</StatusChip>}
              />
            ))}
          </RecordList>
        )}
      </Stack>
    </Page>
  );
}
