'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { SupplierBill } from '@jobwork/contracts';
import {
  Button,
  Callout,
  Card,
  CommandButton,
  DataTable,
  DescriptionList,
  ErrorState,
  FilterChips,
  Inline,
  Page,
  Stack,
  StatusChip,
  TextArea,
  TextInput,
  formatMoney,
  type Column,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

const BILL: Record<SupplierBill['status'], { label: string; tone: Tone }> = {
  submitted: { label: 'To match', tone: 'attention' },
  matched: { label: 'Matched', tone: 'positive' },
  match_exception: { label: 'Exception', tone: 'blocked' },
  exception_approved: { label: 'Exception approved', tone: 'positive' },
  rejected: { label: 'Rejected', tone: 'neutral' },
};
const SETTLEMENT: Record<NonNullable<SupplierBill['settlement']>['status'], { label: string; tone: Tone }> = {
  held: { label: 'Held', tone: 'attention' },
  eligible: { label: 'Eligible', tone: 'progress' },
  scheduled: { label: 'Scheduled', tone: 'progress' },
  paid: { label: 'Paid', tone: 'positive' },
};
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'submitted', label: 'To match' },
  { value: 'match_exception', label: 'Exceptions' },
  { value: 'matched', label: 'Matched' },
] as const;

/**
 * Supplier bills (IN-18 F-18.4; UC-31; doc 10 §5): match each bill against its PO and what was
 * accepted, send a mismatch to a second finance member, and pay a settlement once eligible.
 */
export default function FinanceBillsPage(): React.JSX.Element {
  const [bills, setBills] = useState<SupplierBill[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['value']>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<ApiError | null>(null);
  const [text, setText] = useState({ justification: '', reason: '', scheduledFor: new Date().toISOString().slice(0, 10), paymentReference: '' });

  const load = useCallback(async () => {
    try {
      setBills(await api<SupplierBill[]>(`/supplier-bills${filter === 'all' ? '' : `?status=${filter}`}`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const bill = bills?.find((b) => b.billId === selected) ?? null;
  const money = (minor: number, currency = 'INR'): string => formatMoney({ amountMinor: minor, currency });

  const act = async (path: string, body: Record<string, unknown>): Promise<void> => {
    setNotice(null);
    try {
      await api(path, { method: 'POST', body, idempotencyKey: `${path}-${JSON.stringify(body)}` });
      await load();
    } catch (err) {
      if (err instanceof ApiError) setNotice(err);
      throw err;
    }
  };

  const columns: Array<Column<SupplierBill>> = [
    { key: 'n', header: 'Bill', render: (b) => <Button size="sm" variant="ghost" onClick={() => setSelected(b.billId)}><span className="mono">{b.number}</span></Button> },
    { key: 's', header: 'Supplier', render: (b) => b.supplierDisplayName },
    { key: 'po', header: 'PO', render: (b) => <span className="mono">{b.purchaseOrderNumber}</span> },
    { key: 'ref', header: 'Their invoice', render: (b) => b.supplierReference },
    { key: 'amt', header: 'Total', numeric: true, render: (b) => money(b.totalMinor, b.currency) },
    { key: 'st', header: 'Bill', render: (b) => <StatusChip tone={BILL[b.status].tone}>{BILL[b.status].label}</StatusChip> },
    { key: 'pay', header: 'Settlement', render: (b) => (b.settlement ? <StatusChip tone={SETTLEMENT[b.settlement.status].tone}>{SETTLEMENT[b.settlement.status].label}</StatusChip> : '—') },
  ];

  return (
    <Page title="Supplier bills" back={{ href: '/finance', label: 'Finance' }} description="Three-way match, exceptions and supplier payment." width="wide">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {notice ? <Callout tone="blocked" assertive title={notice.problem.title}>{notice.problem.detail ?? ''} ({notice.problem.code})</Callout> : null}
        <FilterChips label="Show" options={FILTERS.map((f) => ({ value: f.value, label: f.label }))} value={filter} onChange={(v) => setFilter(v as typeof filter)} />
        <Card>
          <DataTable caption="Supplier bills" columns={columns} rows={bills} rowKey={(b) => b.billId} loadingLabel="Loading bills" empty={{ title: 'No bills', detail: 'Suppliers submit bills from their portal.' }} />
        </Card>

        {bill ? (
          <Card title={`${bill.number} · ${bill.supplierDisplayName}`} description={`${bill.supplierReference} dated ${bill.billDate}`}>
            <Stack gap={3}>
              {bill.match ? (
                <DescriptionList
                  items={[
                    { label: 'Purchase order', value: `${bill.match.purchaseOrder.number}: ${bill.match.purchaseOrder.quantity} at ${money(bill.match.purchaseOrder.unitPriceMinor)} = ${money(bill.match.purchaseOrder.totalMinor)}` },
                    { label: 'Accepted at JobWork', value: `${bill.match.receipt.acceptedQuantity} worth ${money(bill.match.receipt.valueMinor)}` },
                    { label: 'Billed before', value: bill.match.billedBeforeQuantity },
                    { label: 'This bill', value: `${bill.match.bill.quantity} for ${money(bill.match.bill.taxableMinor)} + GST ${money(bill.taxMinor)}` },
                    { label: 'Tolerance', value: money(bill.match.toleranceMinor) },
                  ]}
                />
              ) : null}
              {bill.match && !bill.match.pass ? <Callout tone="attention" title="Does not match">{bill.match.reasons.join(' ')}</Callout> : null}
              {bill.decisionNote ? <Callout tone="neutral" title="Note">{bill.decisionNote}</Callout> : null}

              {bill.status === 'submitted' ? (
                <Inline gap={2}>
                  <CommandButton receiptLabel="Matched" onCommand={() => act(`/supplier-bills/${bill.billId}/match`, { expectedVersion: bill.aggregateVersion })}>Run the match</CommandButton>
                </Inline>
              ) : null}
              {bill.status === 'match_exception' && !bill.approvalRequestId ? (
                <Stack gap={2}>
                  <TextArea label="Why it should be paid anyway" value={text.justification} onChange={(e) => setText({ ...text, justification: e.target.value })} />
                  <Inline gap={2}>
                    <CommandButton receiptLabel="Sent" disabled={text.justification.length < 10} disabledReason="Explain in at least 10 characters" onCommand={() => act(`/supplier-bills/${bill.billId}/exception`, { expectedVersion: bill.aggregateVersion, justification: text.justification })}>
                      Ask a second finance member
                    </CommandButton>
                  </Inline>
                </Stack>
              ) : null}
              {bill.approvalRequestId && bill.status === 'match_exception' ? <p>Waiting in <Link href="/approvals">Approvals</Link>.</p> : null}
              {bill.status === 'submitted' || bill.status === 'match_exception' ? (
                <Inline gap={2}>
                  <TextInput label="Reason to reject" value={text.reason} onChange={(e) => setText({ ...text, reason: e.target.value })} />
                  <CommandButton variant="secondary" receiptLabel="Rejected" disabled={text.reason.length < 3} disabledReason="Give a reason" onCommand={() => act(`/supplier-bills/${bill.billId}/reject`, { expectedVersion: bill.aggregateVersion, reason: text.reason })}>
                    Reject
                  </CommandButton>
                </Inline>
              ) : null}

              {bill.settlement ? (
                <Stack gap={2}>
                  <Inline gap={2}>
                    <strong>Settlement</strong>
                    <StatusChip tone={SETTLEMENT[bill.settlement.status].tone}>{SETTLEMENT[bill.settlement.status].label}</StatusChip>
                    <span style={{ color: 'var(--color-text-muted)' }}>checked {bill.settlement.eligibility.computedAt.slice(0, 16).replace('T', ' ')}</span>
                  </Inline>
                  {bill.settlement.eligibility.reasons.length > 0 ? <Callout tone="attention" title="Held because">{bill.settlement.eligibility.reasons.join(' ')}</Callout> : null}
                  {bill.settlement.status === 'held' ? (
                    <div>
                      <CommandButton variant="secondary" receiptLabel="Checked" onCommand={() => act(`/supplier-bills/${bill.billId}/settlement/recheck`, { expectedVersion: bill.settlement!.aggregateVersion })}>Check again</CommandButton>
                    </div>
                  ) : null}
                  {bill.settlement.status === 'eligible' ? (
                    <Inline gap={2}>
                      <TextInput label="Pay on" type="date" value={text.scheduledFor} onChange={(e) => setText({ ...text, scheduledFor: e.target.value })} />
                      <CommandButton receiptLabel="Scheduled" onCommand={() => act(`/supplier-bills/${bill.billId}/settlement/schedule`, { expectedVersion: bill.settlement!.aggregateVersion, scheduledFor: text.scheduledFor })}>Schedule</CommandButton>
                    </Inline>
                  ) : null}
                  {bill.settlement.status === 'scheduled' ? (
                    <Inline gap={2}>
                      <TextInput label="Bank reference (UTR)" value={text.paymentReference} onChange={(e) => setText({ ...text, paymentReference: e.target.value })} />
                      <CommandButton receiptLabel="Paid" disabled={text.paymentReference.length < 3} disabledReason="Give the bank reference" onCommand={() => act(`/supplier-bills/${bill.billId}/settlement/pay`, { expectedVersion: bill.settlement!.aggregateVersion, paymentReference: text.paymentReference })}>
                        Mark paid
                      </CommandButton>
                    </Inline>
                  ) : null}
                  {bill.settlement.status === 'paid' ? <p>Paid {bill.settlement.paidAt?.slice(0, 10)} · ref <span className="mono">{bill.settlement.paymentReference}</span></p> : null}
                </Stack>
              ) : null}
            </Stack>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}
