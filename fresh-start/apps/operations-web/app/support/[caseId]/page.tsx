'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Invoice, PurchaseOrder, ResolutionActionKind, SalesOrder, SupportCase } from '@jobwork/contracts';
import {
  Button,
  Callout,
  Card,
  CommandButton,
  DescriptionList,
  ErrorState,
  Inline,
  LoadingState,
  Page,
  Select,
  Stack,
  StatusChip,
  TextArea,
  TextInput,
  formatMoney,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';
import { ACTION_KIND, CASE_KIND, CASE_TONE } from '../labels';

type Draft = { kind: ResolutionActionKind; description: string; amount: string; quantity: string; stockLotId: string };
type Exec = { invoiceId: string; reference: string; note: string; challanNumber: string; from: 'stock' | 'quarantine' };

const MONEY: readonly ResolutionActionKind[] = ['credit_note', 'refund', 'supplier_recovery'];
const TO_SUPPLIER: readonly ResolutionActionKind[] = ['return_to_supplier', 'rework'];

/**
 * One case (IN-18 F-18.4; doc 06 §15). Support triages, investigates and proposes; finance or
 * quality approves the proposal in Approvals; each action is carried out by its owner and verified
 * by someone else; support closes the case once every action is verified, which lifts any delivery
 * hold it carried. Internal notes never reach the customer.
 */
export default function CasePage(): React.JSX.Element {
  const caseId = useParams<{ caseId: string }>().caseId;
  const [c, setCase] = useState<SupportCase | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<ApiError | null>(null);
  const [note, setNote] = useState({ text: '', audience: 'internal' as 'customer' | 'internal' });
  const [reason, setReason] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [exec, setExec] = useState<Record<string, Exec>>({});
  const [verifyNote, setVerifyNote] = useState<Record<string, string>>({});
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [purchaseOrderId, setPurchaseOrderId] = useState('');

  const load = useCallback(async () => {
    try {
      const found = await api<SupportCase>(`/cases/${caseId}`);
      setCase(found);
      setError(null);
      const res = await api<{ invoices: Invoice[] }>('/finance/invoices').catch(() => ({ invoices: [] as Invoice[] }));
      setInvoices(res.invoices.filter((i) => i.salesOrderId === found.salesOrderId && i.status !== 'void'));
      const order = await api<SalesOrder>(`/sales-orders/${found.salesOrderId}`).catch(() => null);
      setPurchaseOrders(order?.purchaseOrders.filter((po) => po.status !== 'cancelled') ?? []);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  if (error) return <Page title="Case"><ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /></Page>;
  if (!c) return <Page title="Case"><Card><LoadingState label="Loading the case" /></Card></Page>;

  const v = { expectedVersion: c.aggregateVersion };
  const money = (minor: number): string => formatMoney({ amountMinor: minor, currency: 'INR' });
  const closed = ['closed', 'rejected', 'withdrawn'].includes(c.status);
  // A recovery holds the supplier's settlement through the case's purchase order, so a case without one names it.
  const needsPurchaseOrder = !c.purchaseOrderId && drafts.some((d) => d.kind === 'supplier_recovery');
  // Close needs every action verified or cancelled; cancelling, only while the agreed resolution is carried out.
  const unverified = c.actions.some((a) => a.status === 'planned' || a.status === 'done');
  const carryingOut = ['resolution_approved', 'executing'].includes(c.status);
  const execOf = (id: string): Exec => exec[id] ?? { invoiceId: invoices[0]?.invoiceId ?? '', reference: '', note: '', challanNumber: '', from: 'quarantine' };

  return (
    <Page title={`${c.number} · ${c.title}`} back={{ href: '/support', label: 'Support cases' }} description={`${CASE_KIND[c.kind]} on ${c.orderNumber} for ${c.customerDisplayName}`} width="wide">
      <Stack gap={4}>
        {notice ? <Callout tone="blocked" assertive title={notice.problem.title}>{notice.problem.detail ?? ''} ({notice.problem.code})</Callout> : null}

        <Card>
          <Stack gap={2}>
            <Inline gap={2}>
              <StatusChip tone={CASE_TONE[c.status]}>{c.statusLabel}</StatusChip>
              <span>Opened by {c.openedByParty === 'customer' ? 'the customer' : 'JobWork'} on {c.createdAt.slice(0, 10)}</span>
            </Inline>
            <DescriptionList
              items={[
                { label: 'Order', value: <Link href={`/sales-orders/${c.salesOrderId}`} className="mono">{c.orderNumber}</Link> },
                { label: 'Delivery', value: c.shipmentId ? <Link href={`/logistics/shipments/${c.shipmentId}`} className="mono">{c.shipmentNumber}</Link> : '—' },
                { label: 'Delivery exceptions held', value: c.linkedExceptions.length > 0 ? c.linkedExceptions.map((x) => x.number).join(', ') : '—' },
                { label: 'Supplier purchase order', value: purchaseOrders.find((po) => po.purchaseOrderId === c.purchaseOrderId)?.number ?? (c.purchaseOrderId ? 'Linked' : '—') },
                { label: 'What was reported', value: c.description },
              ]}
            />
            {c.status === 'open' ? <div><CommandButton receiptLabel="Taken" onCommand={() => act(`/cases/${c.caseId}/triage`, v)}>Take and triage</CommandButton></div> : null}
            {c.status === 'triage' ? <div><CommandButton receiptLabel="Investigating" onCommand={() => act(`/cases/${c.caseId}/investigate`, v)}>Start investigating</CommandButton></div> : null}
            {c.status === 'open' || c.status === 'triage' ? (
              <Inline gap={2}>
                <TextInput label="Reason to reject" value={reason} onChange={(e) => setReason(e.target.value)} />
                <CommandButton variant="secondary" receiptLabel="Rejected" disabled={reason.length < 3} disabledReason="Give the customer a reason" onCommand={() => act(`/cases/${c.caseId}/reject`, { ...v, reason })}>Reject</CommandButton>
              </Inline>
            ) : null}
            {c.status === 'resolution_proposed' ? <p>The proposal waits in <Link href="/approvals">Approvals</Link>.</p> : null}
            {c.status === 'verifying' ? (
              <Inline gap={2}>
                <TextInput label="Closing note to the customer" value={reason} onChange={(e) => setReason(e.target.value)} />
                <CommandButton
                  receiptLabel="Closed"
                  disabled={unverified || reason.length < 3}
                  disabledReason={unverified ? 'Every action must be verified or cancelled first' : 'Write a closing note'}
                  onCommand={() => act(`/cases/${c.caseId}/close`, { ...v, reason })}
                >
                  Close the case
                </CommandButton>
              </Inline>
            ) : null}
          </Stack>
        </Card>

        {c.status === 'investigating' ? (
          <Card title="Propose a resolution" description="Money goes to finance for approval, anything else to quality. A new proposal replaces the actions not yet carried out.">
            <Stack gap={2}>
              {drafts.map((d, i) => (
                <Inline key={i} gap={2}>
                  <Select label="Action" value={d.kind} options={Object.entries(ACTION_KIND).map(([value, label]) => ({ value, label }))} onChange={(e) => setDrafts(drafts.map((x, j) => (j === i ? { ...x, kind: e.target.value as ResolutionActionKind } : x)))} />
                  <TextInput label="What exactly" value={d.description} onChange={(e) => setDrafts(drafts.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                  {MONEY.includes(d.kind) ? <TextInput label="Amount incl. GST (₹)" type="number" numeric value={d.amount} onChange={(e) => setDrafts(drafts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} /> : null}
                  {TO_SUPPLIER.includes(d.kind) ? (
                    <>
                      <TextInput label="Stock lot id" value={d.stockLotId} onChange={(e) => setDrafts(drafts.map((x, j) => (j === i ? { ...x, stockLotId: e.target.value } : x)))} />
                      <TextInput label="Quantity" numeric value={d.quantity} onChange={(e) => setDrafts(drafts.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                    </>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}>Remove</Button>
                </Inline>
              ))}
              {needsPurchaseOrder ? (
                <Select
                  label="Supplier purchase order the recovery is against"
                  value={purchaseOrderId}
                  options={[{ value: '', label: 'Choose a purchase order' }, ...purchaseOrders.map((po) => ({ value: po.purchaseOrderId, label: `${po.number} · ${po.supplierDisplayName}` }))]}
                  onChange={(e) => setPurchaseOrderId(e.target.value)}
                />
              ) : null}
              <Inline gap={2}>
                <Button size="sm" variant="secondary" onClick={() => setDrafts([...drafts, { kind: 'credit_note', description: '', amount: '', quantity: '', stockLotId: '' }])}>Add an action</Button>
                <CommandButton
                  receiptLabel="Proposed"
                  disabled={drafts.length === 0 || drafts.some((d) => d.description.length < 3) || (needsPurchaseOrder && !purchaseOrderId)}
                  disabledReason={needsPurchaseOrder && !purchaseOrderId ? 'Choose the purchase order the recovery is against' : 'Add at least one action and describe each'}
                  onCommand={async () => {
                    await act(`/cases/${c.caseId}/proposal`, {
                      ...v,
                      actions: drafts.map((d) => ({
                        kind: d.kind,
                        description: d.description,
                        ...(MONEY.includes(d.kind) && d.amount ? { amountMinor: Math.round(Number(d.amount) * 100) } : {}),
                        ...(TO_SUPPLIER.includes(d.kind) ? { stockLotId: d.stockLotId, quantity: d.quantity } : {}),
                      })),
                      ...(needsPurchaseOrder ? { purchaseOrderId } : {}),
                    });
                    setDrafts([]);
                  }}
                >
                  Send for approval
                </CommandButton>
              </Inline>
            </Stack>
          </Card>
        ) : null}

        {c.actions.length > 0 ? (
          <Card title="Resolution actions" description="Each is carried out by its owner (finance for money, logistics for goods) and verified by someone else.">
            <Stack gap={3}>
              {c.actions.map((a) => {
                const e = execOf(a.actionId);
                const set = (patch: Partial<Exec>): void => setExec({ ...exec, [a.actionId]: { ...e, ...patch } });
                const ready = carryingOut && a.status === 'planned';
                return (
                  <Stack key={a.actionId} gap={2}>
                    <Inline gap={2}>
                      <strong>{a.seq}. {ACTION_KIND[a.kind]}</strong>
                      <span>{a.description}</span>
                      {a.amountMinor ? <span className="numeric">{money(a.amountMinor)}</span> : null}
                      {a.quantity ? <span>{a.quantity} pcs</span> : null}
                      <StatusChip tone={a.status === 'verified' ? 'positive' : a.status === 'done' ? 'progress' : a.status === 'cancelled' ? 'neutral' : 'attention'}>{a.status}</StatusChip>
                      {typeof a.result['creditNoteNumber'] === 'string' ? <span className="mono">{a.result['creditNoteNumber']}</span> : null}
                      {typeof a.result['shipmentId'] === 'string' ? <Link href={`/logistics/shipments/${a.result['shipmentId']}`} className="mono">{String(a.result['shipmentNumber'] ?? 'shipment')}</Link> : null}
                    </Inline>
                    {ready ? (
                      <Inline gap={2}>
                        {a.kind === 'credit_note' ? <Select label="Against invoice" value={e.invoiceId} options={invoices.map((i) => ({ value: i.invoiceId, label: `${i.number} · ${money(i.totalMinor)}` }))} onChange={(ev) => set({ invoiceId: ev.target.value })} /> : null}
                        {a.kind === 'refund' || a.kind === 'supplier_recovery' || a.kind === 'carrier_claim' ? <TextInput label="Reference" value={e.reference} onChange={(ev) => set({ reference: ev.target.value })} /> : null}
                        {TO_SUPPLIER.includes(a.kind) ? (
                          <>
                            <TextInput label="Delivery challan" value={e.challanNumber} onChange={(ev) => set({ challanNumber: ev.target.value })} />
                            <Select label="From" value={e.from} options={[{ value: 'quarantine', label: 'Quarantine' }, { value: 'stock', label: 'Stock' }]} onChange={(ev) => set({ from: ev.target.value as Exec['from'] })} />
                          </>
                        ) : null}
                        <TextInput label="Note" value={e.note} onChange={(ev) => set({ note: ev.target.value })} />
                        <CommandButton receiptLabel="Done" onCommand={() => act(`/case-actions/${a.actionId}/execute`, { note: e.note, reference: e.reference, challanNumber: e.challanNumber, from: e.from, ...(a.kind === 'credit_note' && e.invoiceId ? { invoiceId: e.invoiceId } : {}) })}>Carry out</CommandButton>
                        <CommandButton variant="ghost" receiptLabel="Cancelled" disabled={(verifyNote[a.actionId] ?? '').length < 3} disabledReason="Say why in the note beside Verify" onCommand={() => act(`/case-actions/${a.actionId}/cancel`, { note: verifyNote[a.actionId] ?? '' })}>Cancel</CommandButton>
                      </Inline>
                    ) : null}
                    {(a.status === 'done' && !closed) || (a.status === 'planned' && carryingOut) ? (
                      <Inline gap={2}>
                        <TextInput label={a.status === 'done' ? 'Verification note' : 'Reason to cancel'} value={verifyNote[a.actionId] ?? ''} onChange={(ev) => setVerifyNote({ ...verifyNote, [a.actionId]: ev.target.value })} />
                        {a.status === 'done' ? (
                          <CommandButton receiptLabel="Verified" disabled={(verifyNote[a.actionId] ?? '').length < 3} disabledReason="Say what you checked" onCommand={() => act(`/case-actions/${a.actionId}/verify`, { note: verifyNote[a.actionId] ?? '' })}>Verify</CommandButton>
                        ) : null}
                      </Inline>
                    ) : null}
                  </Stack>
                );
              })}
            </Stack>
          </Card>
        ) : null}

        <Card title="Timeline">
          <Stack gap={2}>
            {c.events.map((e, i) => (
              <div key={i}>
                <Inline gap={2}>
                  <span style={{ color: 'var(--color-text-muted)' }}>{e.createdAt.slice(0, 16).replace('T', ' ')}</span>
                  <strong>{e.authorParty === 'customer' ? 'Customer' : e.authorParty === 'system' ? 'System' : 'JobWork'}</strong>
                  <span>{e.kind.replace(/_/g, ' ')}</span>
                  {e.audience === 'internal' ? <StatusChip tone="neutral">internal</StatusChip> : null}
                  {e.evidenceCount > 0 ? <span>{e.evidenceCount} file(s)</span> : null}
                </Inline>
                {e.note ? <p>{e.note}</p> : null}
              </div>
            ))}
            {closed ? null : (
              <Stack gap={2}>
                <TextArea label="Add a note" value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} />
                <Inline gap={2}>
                  <Select label="Who sees it" value={note.audience} options={[{ value: 'internal', label: 'JobWork only' }, { value: 'customer', label: 'Shared with the customer' }]} onChange={(e) => setNote({ ...note, audience: e.target.value as 'customer' | 'internal' })} />
                  <CommandButton
                    receiptLabel="Added"
                    disabled={note.text.trim().length === 0}
                    disabledReason="Write a note"
                    onCommand={async () => {
                      await act(`/cases/${c.caseId}/events`, { note: note.text, audience: note.audience });
                      setNote({ ...note, text: '' });
                    }}
                  >
                    Add note
                  </CommandButton>
                </Inline>
              </Stack>
            )}
          </Stack>
        </Card>
      </Stack>
    </Page>
  );
}
