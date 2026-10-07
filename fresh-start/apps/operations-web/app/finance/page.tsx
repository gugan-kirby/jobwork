'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Invoice, ReconciliationQueue } from '@jobwork/contracts';
import {
  Callout,
  Card,
  CommandButton,
  DataTable,
  ErrorState,
  Inline,
  Page,
  Select,
  Stack,
  StatusChip,
  TextInput,
  formatMoney,
  type Column,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * Finance reconciliation (doc 10 §7, F-08.5): money that arrived but is not yet tied to
 * an invoice, the allocations waiting for a second finance user, and customer credit left
 * over from overpayments. Bank credits are entered once by their bank reference.
 */
export default function FinancePage(): React.JSX.Element {
  const [queue, setQueue] = useState<ReconciliationQueue | null>(null);
  const [openInvoices, setOpenInvoices] = useState<Invoice[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<ApiError | null>(null);
  const [bank, setBank] = useState({ reference: '', amount: '', occurredAt: new Date().toISOString().slice(0, 10) });
  const [allocating, setAllocating] = useState<{ transactionId: string; invoiceId: string; amount: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [q, issued, partial] = await Promise.all([
        api<ReconciliationQueue>('/finance/reconciliation'),
        api<{ invoices: Invoice[] }>('/finance/invoices?status=issued'),
        api<{ invoices: Invoice[] }>('/finance/invoices?status=partially_paid'),
      ]);
      setQueue(q);
      setOpenInvoices([...issued.invoices, ...partial.invoices]);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  type Suspense = ReconciliationQueue['suspense'][number];
  const suspenseColumns: Array<Column<Suspense>> = [
    { key: 'ref', header: 'Reference', render: (row) => <span className="mono">{row.reference || row.providerTransactionId}</span> },
    { key: 'source', header: 'Source', render: (row) => (row.kind === 'bank_transfer' ? 'Bank' : `Gateway (${row.provider})`) },
    { key: 'amount', header: 'Amount', numeric: true, render: (row) => money(row.amountMinor, row.currency) },
    { key: 'unallocated', header: 'Unallocated', numeric: true, render: (row) => money(row.unappliedMinor, row.currency) },
    { key: 'received', header: 'Received', render: (row) => row.receivedAt.slice(0, 10) },
    {
      key: 'act',
      header: '',
      render: (row) => (
        <CommandButton size="sm" variant="secondary" receiptLabel="Open" onCommand={async () => setAllocating({ transactionId: row.transactionId, invoiceId: openInvoices[0]?.invoiceId ?? '', amount: String(row.unappliedMinor / 100) })}>
          Allocate…
        </CommandButton>
      ),
    },
  ];

  return (
    <Page title="Finance" description="Receipts in suspense, allocations awaiting a checker, and customer credit." width="wide">
      <Stack gap={4}>
        <p>
          <Link href="/finance/bills">Supplier bills</Link> · <Link href="/finance/margin">Margin per order</Link>
        </p>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {notice ? <Callout tone="blocked" assertive title={notice.problem.title}>{notice.problem.detail ?? ''} ({notice.problem.code})</Callout> : null}

        <Card title="Receipts in suspense" description="Money received that nobody can yet tie to an invoice. It is a liability until it is allocated.">
          <DataTable
            caption="Receipts in suspense"
            columns={suspenseColumns}
            rows={queue?.suspense ?? null}
            rowKey={(row) => row.transactionId}
            loadingLabel="Loading suspense"
            empty={{ title: 'Nothing in suspense', detail: 'Every receipt is matched to an invoice.' }}
          />
        </Card>

        {allocating ? (
          <Card title="Propose an allocation" description="A second finance user must approve it in Approvals before any money moves.">
            <Inline gap={2}>
              <Select
                label="Invoice"
                value={allocating.invoiceId}
                options={openInvoices.map((i) => ({ value: i.invoiceId, label: `${i.number} · ${i.salesOrderNumber} · open ${money(i.openMinor, i.currency)}` }))}
                onChange={(e) => setAllocating({ ...allocating, invoiceId: e.target.value })}
              />
              <TextInput label="Amount (₹)" type="number" numeric value={allocating.amount} onChange={(e) => setAllocating({ ...allocating, amount: e.target.value })} />
              <CommandButton
                receiptLabel="Proposed"
                disabled={!allocating.invoiceId || !allocating.amount}
                disabledReason="Choose an invoice and an amount"
                onCommand={async () => {
                  await act('/finance/allocations', { transactionId: allocating.transactionId, invoiceId: allocating.invoiceId, amountMinor: Math.round(Number(allocating.amount) * 100) });
                  setAllocating(null);
                }}
              >
                Propose
              </CommandButton>
            </Inline>
          </Card>
        ) : null}

        <Card title="Allocations awaiting approval">
          {queue && queue.pendingAllocations.length > 0 ? (
            <Stack gap={2}>
              {queue.pendingAllocations.map((p) => (
                <Inline key={p.approvalRequestId} gap={3}>
                  <span className="mono">{p.invoiceNumber}</span>
                  <span className="numeric">{money(p.amountMinor)}</span>
                  <span>proposed by {p.requestedByName} · {p.requestedAt.slice(0, 10)}</span>
                  <StatusChip tone="attention">waiting</StatusChip>
                  <Link href="/approvals">Decide in Approvals</Link>
                </Inline>
              ))}
            </Stack>
          ) : (
            <p style={{ color: 'var(--color-text-muted)' }}>None waiting.</p>
          )}
        </Card>

        <Card title="Record a bank credit" description="Enter each credit once, by its bank reference (UTR). It lands in suspense until allocated.">
          <Inline gap={2}>
            <TextInput label="Bank reference" value={bank.reference} onChange={(e) => setBank({ ...bank, reference: e.target.value })} />
            <TextInput label="Amount (₹)" type="number" numeric value={bank.amount} onChange={(e) => setBank({ ...bank, amount: e.target.value })} />
            <TextInput label="Credited on" type="date" value={bank.occurredAt} onChange={(e) => setBank({ ...bank, occurredAt: e.target.value })} />
            <CommandButton
              variant="secondary"
              receiptLabel="Recorded"
              disabled={bank.reference.trim().length < 3 || !bank.amount}
              disabledReason="Enter the reference and amount"
              onCommand={async () => {
                await act('/finance/bank-transfers', { bankReference: bank.reference.trim(), amountMinor: Math.round(Number(bank.amount) * 100), occurredAt: new Date(`${bank.occurredAt}T12:00:00Z`).toISOString() });
                setBank({ ...bank, reference: '', amount: '' });
              }}
            >
              Record
            </CommandButton>
          </Inline>
        </Card>

        <Card title="Unapplied customer credit" description="Overpayments. The customer's money — applied to a later invoice or refunded, never kept as a wallet.">
          {queue && queue.unappliedCredits.length > 0 ? (
            <Stack gap={2}>
              {queue.unappliedCredits.map((c) => (
                <Inline key={c.creditId} gap={3}>
                  <span>{c.customerDisplayName}</span>
                  <span className="numeric">{money(c.amountMinor, c.currency)}</span>
                  <span style={{ color: 'var(--color-text-muted)' }}>since {c.createdAt.slice(0, 10)}</span>
                </Inline>
              ))}
            </Stack>
          ) : (
            <p style={{ color: 'var(--color-text-muted)' }}>None.</p>
          )}
        </Card>
      </Stack>
    </Page>
  );
}
