'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CustomerOrderListItem } from '@jobwork/contracts';
import {
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  FilterChips,
  Icon,
  IconTextInput,
  LoadingState,
  Page,
  RecordCard,
  RecordList,
  Stack,
  Select,
  StatusChip,
  type RecordTint,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { ORDER_PROGRESS } from '../../lib/order-progress';

/**
 * Orders (prototype tile 11, corrected): JobWork's commitment to you, from acceptance to
 * delivery. Status words are the customer's (doc 06 §13) and nothing names a workshop.
 *
 * VF-11 (reference screen 11): tab root titled "My Orders", search with sort, a tab strip,
 * and rich cards with a progress bar. The reference's "Vendor" line is not drawn. Progress
 * is the order's place on the customer timeline (`F-09.5`), not a production estimate.
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

type Filter = 'all' | 'in_progress' | 'completed' | 'cancelled';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

function bucket(order: CustomerOrderListItem): Exclude<Filter, 'all'> {
  if (order.status === 'cancelled') return 'cancelled';
  if (order.status === 'completed') return 'completed';
  return 'in_progress';
}

const TILE: Record<Exclude<Filter, 'all'>, RecordTint> = {
  in_progress: 'blue',
  completed: 'green',
  cancelled: 'neutral',
};

const SHORT_STATUS: Record<Exclude<Filter, 'all'>, string> = {
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

type Sort = 'newest' | 'oldest' | 'name';

const SORTS: Array<{ value: Sort; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Part name, A to Z' },
];

const when = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

export default function OrdersPage() {
  const [orders, setOrders] = useState<CustomerOrderListItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [showOptions, setShowOptions] = useState(false);

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
  const needle = search.trim().toLowerCase();
  const visible = all
    .filter((o) => filter === 'all' || bucket(o) === filter)
    .filter((o) => !needle || `${o.number} ${o.title}`.toLowerCase().includes(needle))
    .sort((a, b) =>
      sort === 'name'
        ? a.title.localeCompare(b.title)
        : sort === 'oldest'
          ? a.acceptedAt.localeCompare(b.acceptedAt)
          : b.acceptedAt.localeCompare(a.acceptedAt),
    );

  return (
    <Page title="My Orders" description="Track your confirmed jobs and order progress">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        <div className="jw-search-row">
          <IconTextInput
            icon="search"
            label="Search orders..."
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className="jw-square-button"
            aria-label="Sort orders"
            aria-expanded={showOptions}
            aria-controls="order-sort"
            onClick={() => setShowOptions((open) => !open)}
          >
            <Icon name="sliders" size={1.5} />
          </button>
        </div>
        {showOptions ? (
          <div id="order-sort">
            <Select label="Sort by" value={sort} options={SORTS} onChange={(event) => setSort(event.target.value as Sort)} />
          </div>
        ) : null}
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
                reference={`Order #${o.number}`}
                title={o.title}
                caption={o.actionNeeded ? o.actionNeeded.label : undefined}
                status={<StatusChip tone={TONE[o.status]}>{SHORT_STATUS[bucket(o)]}</StatusChip>}
                icon={{ name: 'factory', tint: TILE[bucket(o)] }}
                date={when(o.acceptedAt)}
                {...(bucket(o) === 'in_progress' ? { progress: ORDER_PROGRESS[o.status] } : {})}
              />
            ))}
          </RecordList>
        )}
      </Stack>
    </Page>
  );
}
