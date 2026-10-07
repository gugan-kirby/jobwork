'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CustomerCase, CustomerOrderListItem } from '@jobwork/contracts';
import {
  Callout,
  Card,
  CommandButton,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  RecordCard,
  RecordList,
  Select,
  Stack,
  StatusChip,
  TextArea,
  TextInput,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { CASE_KIND, CASE_TONE, CUSTOMER_CASE_KINDS } from './labels';

/**
 * Support (customer; IN-18 F-18.4; UC-34). Raise something wrong with an order — a delivery,
 * a part that failed, a disagreement — and follow it to its resolution. JobWork answers here.
 */
export default function SupportPage(): React.JSX.Element {
  const router = useRouter();
  const [cases, setCases] = useState<CustomerCase[] | null>(null);
  const [orders, setOrders] = useState<CustomerOrderListItem[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<ApiError | null>(null);
  const [form, setForm] = useState({ salesOrderId: '', kind: 'delivery_issue', title: '', description: '' });

  const load = useCallback(async () => {
    try {
      const [c, o] = await Promise.all([api<CustomerCase[]>('/support/cases'), api<{ orders: CustomerOrderListItem[] }>('/orders')]);
      setCases(c);
      setOrders(o.orders);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Page title="Support" description="Tell JobWork what went wrong with an order and follow it until it is put right.">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {notice ? <Callout tone="blocked" assertive title={notice.problem.title}>{notice.problem.detail ?? ''}</Callout> : null}

        <Card title="Raise a case">
          {orders.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)' }}>Cases are raised on an order; you have none yet.</p>
          ) : (
            <Stack gap={2}>
              <Select label="Order" value={form.salesOrderId} options={[{ value: '', label: 'Choose…' }, ...orders.map((o) => ({ value: o.orderId, label: `${o.number} · ${o.title}` }))]} onChange={(e) => setForm({ ...form, salesOrderId: e.target.value })} />
              <Select label="What is it about" value={form.kind} options={CUSTOMER_CASE_KINDS.map((k) => ({ value: k.value, label: k.label }))} onChange={(e) => setForm({ ...form, kind: e.target.value })} />
              <TextInput label="In a few words" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              <TextArea label="What happened" hint="Quantities, part numbers and what you saw help JobWork act quickly." value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              <div>
                <CommandButton
                  receiptLabel="Raised"
                  disabled={!form.salesOrderId || form.title.trim().length < 3 || form.description.trim().length < 3}
                  disabledReason="Choose the order and describe the problem"
                  onCommand={async () => {
                    setNotice(null);
                    try {
                      const created = await api<CustomerCase>('/support/cases', { method: 'POST', body: form, idempotencyKey: `case-${form.salesOrderId}-${form.title}` });
                      router.push(`/support/${created.caseId}`);
                    } catch (err) {
                      if (err instanceof ApiError) setNotice(err);
                      throw err;
                    }
                  }}
                >
                  Raise case
                </CommandButton>
              </div>
            </Stack>
          )}
        </Card>

        {error ? null : cases === null ? (
          <Card>
            <LoadingState label="Loading your cases" />
          </Card>
        ) : cases.length === 0 ? (
          <Card>
            <EmptyState title="No cases" detail="Nothing raised so far." />
          </Card>
        ) : (
          <RecordList>
            {cases.map((c) => (
              <RecordCard
                key={c.caseId}
                href={`/support/${c.caseId}`}
                reference={c.number}
                title={c.title}
                caption={`${CASE_KIND[c.kind]} · ${c.orderNumber} · raised ${c.createdAt.slice(0, 10)}`}
                status={<StatusChip tone={CASE_TONE[c.status]}>{c.statusLabel}</StatusChip>}
              />
            ))}
          </RecordList>
        )}
      </Stack>
    </Page>
  );
}
