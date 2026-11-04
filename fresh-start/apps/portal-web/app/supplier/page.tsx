'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { ChecklistRow, SupplierBill, SupplierPurchaseOrder, SupplierRfqListItem, SupplierSelfView, SupplierSummary } from '@jobwork/contracts';
import {
  Button,
  Callout,
  Card,
  CommandButton,
  Donut,
  Sparkline,
  ErrorState,
  Icon,
  Inline,
  LoadingState,
  Page,
  ProcessArt,
  QueueCard,
  Stack,
  StatusChip,
  TextInput,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { displayMoney } from '../../lib/enquiry-facts';

/**
 * The supplier's home (F-SO.7): where the file stands, what is still owed, and the one
 * command that moves it forward.
 *
 * The checklist here is the *same* computed rows the reviewer sees, so a supplier is
 * never told it is ready for a decision JobWork cannot make — and every row links to the
 * page that fixes it, because a list of problems without a way to act on them is a
 * complaint, not a workflow.
 *
 * VF-15, VF-18 (reference screen 15): the vendor dashboard, in the image's words. Counts and
 * revenue are the vendor's own: Total Revenue is the taxable value of its paid bills.
 * Requests name no customer (`BR-COM-06`). Until a vendor is active the checklist and its
 * file steps follow the dashboard; availability lives on the Company page.
 */

const STATUS_TONE: Record<string, Tone> = {
  onboarding: 'progress',
  submitted: 'progress',
  active: 'positive',
  paused: 'attention',
  rejected: 'blocked',
  exited: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  onboarding: 'Getting set up',
  submitted: 'With JobWork for review',
  active: 'In the network',
  paused: 'Suspended',
  rejected: 'Not accepted',
  exited: 'Left the network',
};

const STATUS_DETAIL: Record<string, string> = {
  onboarding:
    'Finish the list below, then send your file to JobWork. Nothing is shared with customers until you are accepted.',
  submitted:
    'A JobWork sourcing reviewer has your file. You can still correct anything below; we will tell you the outcome by email.',
  active:
    'You can be matched to enquiries. Keep your evidence current — expired evidence takes you out of matching the day it lapses.',
  paused: 'You are temporarily out of matching. The reason is below.',
  rejected: 'JobWork did not accept this file. The reason is below; you can correct it and send it again.',
  exited: 'This account is no longer part of the supplier network.',
};

/** Where each checklist row is fixed. Nothing is listed that cannot be acted on. */
const ROW_TARGET: Record<string, { href: string; label: string }> = {
  company_identity: { href: '/supplier/company', label: 'Company details' },
  primary_contact: { href: '/supplier/company', label: 'Company details' },
  works_site: { href: '/supplier/company', label: 'Company details' },
  capabilities: { href: '/capabilities', label: 'Capabilities' },
};

function rowTarget(row: ChecklistRow): { href: string; label: string } {
  return (
    ROW_TARGET[row.key] ??
    (row.key.startsWith('verification_')
      ? { href: '/supplier/compliance', label: 'Compliance' }
      : { href: '/supplier', label: 'Home' })
  );
}

function rowTone(row: ChecklistRow): Tone {
  if (row.state === 'complete') return 'positive';
  return row.blocking ? 'blocked' : 'progress';
}

export default function SupplierHomePage(): React.JSX.Element {
  const [view, setView] = useState<SupplierSelfView | null>(null);
  const [summary, setSummary] = useState<SupplierSummary | null>(null);
  const [rfqs, setRfqs] = useState<SupplierRfqListItem[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<SupplierPurchaseOrder[]>([]);
  const [bills, setBills] = useState<SupplierBill[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [pauseNote, setPauseNote] = useState('');
  const [pauseUntil, setPauseUntil] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [self, work, invited, orders, ownBills] = await Promise.all([
        api<SupplierSelfView>('/suppliers/me'),
        // Dates only matter once somebody is in the network; before that the checklist
        // is the whole story, so a refused summary is not an error worth showing.
        api<SupplierSummary>('/suppliers/me/summary').catch(() => null),
        // The overview tiles (prototype tile 15) count the supplier's own RFQs, bids,
        // purchase orders and settlements, from the supplier's routes (FW W1: the
        // internal `/rfqs` list refused a supplier and every tile read 0).
        api<{ rfqs: SupplierRfqListItem[] }>('/supplier/rfqs').then((res) => res.rfqs).catch(() => []),
        api<{ purchaseOrders: SupplierPurchaseOrder[] }>('/supplier/purchase-orders').then((res) => res.purchaseOrders).catch(() => []),
        api<SupplierBill[]>('/supplier/bills').catch(() => []),
      ]);
      setView(self);
      setSummary(work);
      setRfqs(invited);
      setPurchaseOrders(orders.filter((po) => po.status !== 'cancelled'));
      setBills(ownBills);
      setPauseNote(self.profile.acceptingWorkNote);
      setPauseUntil(self.profile.acceptingWorkUntil ?? '');
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <Page title="Your supplier account">
        <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
      </Page>
    );
  }

  if (!view) {
    return (
      <Page title="Your supplier account">
        <Card>
          <LoadingState label="Loading your account" />
        </Card>
      </Page>
    );
  }

  const outstanding = view.checklist.filter((row) => row.state !== 'complete');
  const status = view.profile.status;

  const openRfqs = rfqs.filter((r) => r.status === 'open').length;
  const bidsSent = rfqs.filter((r) => r.bidVersionCount > 0).length;
  const waiting = summary ? summary.queues.filter((queue) => queue.count > 0) : [];
  const paidBills = bills.filter((bill) => bill.settlement?.status === 'paid');
  const monthOf = (iso: string): string => iso.slice(0, 7);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const months = Array.from({ length: 6 }, (_, index) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - (5 - index));
    return date.toISOString().slice(0, 7);
  });
  const revenueIn = (month: string): number =>
    paidBills.filter((bill) => monthOf(bill.settlement?.paidAt ?? bill.billDate) === month).reduce((sum, bill) => sum + bill.taxableMinor, 0);
  const revenue = paidBills.reduce((sum, bill) => sum + bill.taxableMinor, 0);
  const monthRevenue = revenueIn(thisMonth);
  const lastMonthRevenue = revenueIn(months[4]!);
  const change = lastMonthRevenue > 0 ? ((monthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100 : null;

  // Everything past the dashboard: a vendor still joining needs it in view, an active one
  // keeps it one tap away (reference screen 15 shows only the dashboard).
  const account = (
    <>
        {waiting.length > 0 ? (
          <div
            style={{
              display: 'grid',
              gap: 'var(--space-3)',
              gridTemplateColumns: 'repeat(auto-fit, minmax(18rem, 1fr))',
            }}
          >
            {waiting.map((queue) => (
              <QueueCard
                key={queue.key}
                label={queue.label}
                detail={
                  queue.nearestDate ? `${queue.detail} Nearest date ${queue.nearestDate.slice(0, 10)}.` : queue.detail
                }
                count={queue.count}
                href={queue.href}
              />
            ))}
          </div>
        ) : null}

        <section aria-labelledby="supplier-quick">
          <h2 id="supplier-quick" className="jw-section-title">
            Quick actions
          </h2>
          <nav aria-label="Supplier quick actions" className="jw-menu">
            {[
              { href: '/rfqs', icon: 'enquiries' as const, label: 'RFQs', detail: 'Requests JobWork has sent you' },
              { href: '/rfqs', icon: 'quote' as const, label: 'Bids', detail: 'What you have quoted' },
              { href: '/supplier/orders', icon: 'orders' as const, label: 'Purchase orders', detail: 'Awarded work' },
              { href: '/supplier/company', icon: 'settings' as const, label: 'Profile & settings', detail: 'Company, compliance, capabilities' },
            ].map((row) => (
              <Link key={row.label} href={row.href} className="jw-menu-row">
                <span className="jw-menu-icon">
                  <Icon name={row.icon} size={1.3} />
                </span>
                <span className="jw-menu-label">
                  {row.label}
                  <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>{row.detail}</span>
                </span>
                <span className="jw-menu-chevron">
                  <Icon name="chevron" />
                </span>
              </Link>
            ))}
          </nav>
        </section>

        <Card title="Status">
          <p>{STATUS_DETAIL[status]}</p>
          {view.profile.decisionReason && (status === 'rejected' || status === 'paused' || status === 'onboarding') ? (
            <Callout tone={status === 'onboarding' ? 'attention' : 'blocked'} assertive>
              JobWork said: {view.profile.decisionReason}
            </Callout>
          ) : null}
          {status === 'active' && view.exclusions.length > 0 ? (
            <Callout tone="attention">
              You are in the network but not currently matchable. Outstanding:{' '}
              {view.exclusions.join(', ').replace(/_/g, ' ')}.
            </Callout>
          ) : null}
        </Card>

        <Card
          title="What JobWork still needs"
          description={
            outstanding.length === 0
              ? 'Nothing outstanding.'
              : `${outstanding.length} item${outstanding.length === 1 ? '' : 's'} to finish.`
          }
        >
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {view.checklist.map((row) => {
              const target = rowTarget(row);
              return (
                <li
                  key={row.key}
                  style={{
                    display: 'flex',
                    gap: 'var(--space-3)',
                    alignItems: 'baseline',
                    flexWrap: 'wrap',
                    padding: 'var(--space-3) 0',
                    borderBottom: 'var(--hairline) solid var(--color-border)',
                  }}
                >
                  <StatusChip tone={rowTone(row)} silent>
                    {row.state === 'complete' ? 'Done' : row.blocking ? 'Needed' : 'Waiting'}
                  </StatusChip>
                  <span style={{ font: 'var(--text-body-strong)' }}>{row.label}</span>
                  <span style={{ color: 'var(--color-text-muted)', flex: '1 1 20ch' }}>
                    {row.detail}
                  </span>
                  {row.state === 'complete' ? null : (
                    <Link href={target.href}>{target.label} →</Link>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        {status === 'active' || status === 'paused' ? (
          <Card
            title="Can you take work right now?"
            description="Yours to set, and it takes effect immediately. It is not a mark against you — JobWork simply stops matching you until you say otherwise."
          >
            <Inline gap={3}>
              <StatusChip tone={view.profile.acceptingWork ? 'positive' : 'attention'}>
                {view.profile.acceptingWork ? 'Taking work' : 'Not taking work'}
              </StatusChip>
              {view.profile.acceptingWorkUntil ? (
                <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                  back on {view.profile.acceptingWorkUntil}
                </span>
              ) : null}
            </Inline>
            {view.profile.acceptingWorkNote ? (
              <p style={{ color: 'var(--color-text-muted)' }}>{view.profile.acceptingWorkNote}</p>
            ) : null}

            {view.profile.acceptingWork ? (
              <>
                <TextInput
                  label="Why, and for how long?"
                  hint="Optional. Sourcing reads this — “shutdown until Diwali”, “one machine down”."
                  value={pauseNote}
                  onChange={(event) => setPauseNote(event.target.value)}
                />
                <TextInput
                  label="Back on"
                  type="date"
                  hint="Optional. Nothing happens automatically on that date; you switch back yourself."
                  value={pauseUntil}
                  onChange={(event) => setPauseUntil(event.target.value)}
                />
                <CommandButton
                  variant="secondary"
                  receiptLabel="Paused"
                  onCommand={async () => {
                    await api('/suppliers/me/availability', {
                      method: 'POST',
                      body: {
                        acceptingWork: false,
                        note: pauseNote,
                        ...(pauseUntil ? { acceptingWorkUntil: pauseUntil } : {}),
                      },
                      idempotencyKey: crypto.randomUUID(),
                    });
                    await load();
                  }}
                >
                  Pause new work
                </CommandButton>
              </>
            ) : (
              <CommandButton
                receiptLabel="Resumed"
                onCommand={async () => {
                  await api('/suppliers/me/availability', {
                    method: 'POST',
                    body: { acceptingWork: true, note: '' },
                    idempotencyKey: crypto.randomUUID(),
                  });
                  await load();
                }}
              >
                Start taking work again
              </CommandButton>
            )}
          </Card>
        ) : null}

        {status === 'onboarding' || status === 'rejected' ? (
          <Card
            title="Send your file to JobWork"
            description="A sourcing reviewer checks your evidence and decides. You will keep access to everything here while they do."
          >
            <CommandButton
              disabled={!view.canSubmit}
              receiptLabel="Sent"
              onCommand={async () => {
                await api('/suppliers/me/submit', {
                  method: 'POST',
                  body: { expectedVersion: view.profile.aggregateVersion },
                  idempotencyKey: `submit-${view.profile.supplierProfileId}-${view.profile.aggregateVersion}`,
                });
                await load();
              }}
            >
              Send for review
            </CommandButton>
            {!view.canSubmit ? (
              <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                Finish the items marked “Needed” above and this becomes available.
              </p>
            ) : null}
          </Card>
        ) : null}
        {status !== 'exited' ? <LeaveTheNetwork name={view.profile.displayName} /> : null}
    </>
  );

  return (
    <Page title="Supplier home" titleHidden>
      <Stack gap={4}>
        <section className="jw-welcome" aria-label="Welcome">
          <div>
            <p className="jw-welcome-eyebrow">Vendor Dashboard</p>
            <p className="jw-welcome-title">Welcome, {view.profile.displayName || 'vendor'} 👋</p>
            <p className="jw-welcome-sub">Manage enquiries, quotes and orders from buyers</p>
            {status === 'active' ? null : (
              <div style={{ marginTop: 'var(--space-3)' }}>
                <StatusChip tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? status}</StatusChip>
              </div>
            )}
          </div>
          <ProcessArt name="vmc" size={92} />
        </section>

        <section aria-labelledby="supplier-overview">
          <h2 id="supplier-overview" className="jw-visually-hidden">
            Overview
          </h2>
          <div className="jw-tiles">
            {[
              { href: '/rfqs', tint: 'blue', icon: 'mail' as const, value: openRfqs, label: 'New Enquiries' },
              { href: '/rfqs/quotes', tint: 'violet', icon: 'document' as const, value: bidsSent, label: 'Quotes Sent' },
              { href: '/supplier/orders', tint: 'green', icon: 'orders' as const, value: purchaseOrders.length, label: 'Active Orders' },
              { href: '/supplier/bills', tint: 'orange', icon: 'payment' as const, value: displayMoney(revenue, 'INR'), label: 'Total Revenue' },
            ].map((tile) => (
              <Link key={tile.label} href={tile.href} className={`jw-tile jw-tile-${tile.tint}`}>
                <span className="jw-tile-glyph" aria-hidden="true">
                  <Icon name={tile.icon} size={1.4} />
                </span>
                <span className="jw-tile-value numeric">{tile.value}</span>
                <span className="jw-tile-label">{tile.label}</span>
              </Link>
            ))}
          </div>
        </section>

        <section className="jw-panel" aria-labelledby="supplier-rfqs">
          <div className="jw-panel-head">
            <h2 id="supplier-rfqs" className="jw-panel-title">
              <Icon name="mail" size={1.3} />
              Enquiry Requests
            </h2>
            <Link href="/rfqs" className="jw-panel-link">
              View All <Icon name="chevron" size={1} />
            </Link>
          </div>
          {rfqs.filter((r) => r.status === 'open').length === 0 ? (
            <p className="jw-panel-body jw-record-caption">No open enquiries right now.</p>
          ) : (
            rfqs
              .filter((r) => r.status === 'open')
              .slice(0, 3)
              .map((r, index) => (
                <div key={r.rfqId} className="jw-panel-row">
                  <span className={`jw-record-tile ${['jw-record-tile-blue', 'jw-record-tile-violet', 'jw-record-tile-orange'][index % 3]}`} aria-hidden="true">
                    <Icon name={(['factory', 'layers', 'hexagon'] as const)[index % 3] ?? 'factory'} size={1.6} />
                  </span>
                  <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                    <span className="jw-offer-title mono">{r.reference ?? 'RFQ'}</span>
                    <span className="jw-record-caption">
                      {r.itemCount} {r.itemCount === 1 ? 'part' : 'parts'}
                      {r.deadlineAt ? ` • due ${new Date(r.deadlineAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' })}` : ''}
                    </span>
                  </span>
                  <Link href={`/rfqs/${r.rfqId}`} className={index === 0 ? 'jw-cta jw-cta-xs' : 'jw-cta-outline jw-cta-xs'}>
                    {r.bidVersionCount > 0 ? 'Revise' : 'Quote Now'}
                    <span className="jw-visually-hidden">, {r.reference ?? 'RFQ'}</span>
                  </Link>
                </div>
              ))
          )}
        </section>

        <section className="jw-panel" aria-labelledby="supplier-orders">
          <div className="jw-panel-head">
            <h2 id="supplier-orders" className="jw-panel-title">
              <Icon name="orders" size={1.3} />
              Orders Overview
            </h2>
            <Link href="/supplier/orders" className="jw-panel-link">
              View All <Icon name="chevron" size={1} />
            </Link>
          </div>
          <div className="jw-panel-body">
            <Donut
              totalLabel="Orders"
              slices={[
                { label: 'In Production', value: purchaseOrders.filter((po) => po.status === 'acknowledged' && po.baselineStatus === 'baseline_released').length },
                { label: 'Awaiting Start', value: purchaseOrders.filter((po) => po.status === 'acknowledged' && po.baselineStatus === 'pending_baseline').length },
                { label: 'To Acknowledge', value: purchaseOrders.filter((po) => po.status === 'issued').length },
              ]}
            />
          </div>
        </section>

        <section className="jw-panel" aria-labelledby="supplier-revenue">
          <div className="jw-panel-head">
            <h2 id="supplier-revenue" className="jw-panel-title">
              <Icon name="payment" size={1.3} />
              Revenue <span className="jw-record-caption">(This Month)</span>
            </h2>
          </div>
          <div className="jw-revenue">
            <div>
              <p className="jw-revenue-amount numeric">{displayMoney(monthRevenue, 'INR')}</p>
              {change !== null ? (
                <StatusChip tone={change >= 0 ? 'positive' : 'attention'} silent>
                  {change >= 0 ? '+' : ''}
                  {change.toFixed(1)}%
                </StatusChip>
              ) : null}
            </div>
            <Sparkline
              label={`Paid revenue over six months: ${months.map((month) => `${month} ${displayMoney(revenueIn(month), 'INR')}`).join(', ')}`}
              points={months.map((month) => ({ label: `${month}: ${displayMoney(revenueIn(month), 'INR')}`, value: revenueIn(month) }))}
            />
          </div>
        </section>

        {status === 'active' ? (
          <details className="jw-more">
            <summary>Account &amp; Availability</summary>
            <Stack gap={4}>{account}</Stack>
          </details>
        ) : (
          account
        )}
      </Stack>
    </Page>
  );
}

/**
 * Leaving is terminal, so it is typed rather than clicked, and it sits at the bottom
 * behind a disclosure — a destructive action should take a decision, not a stray tap.
 */
function LeaveTheNetwork({ name }: { name: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');

  if (!open) {
    return (
      <Card title="Leaving JobWork">
        <p style={{ color: 'var(--color-text-muted)' }}>
          You can leave the network at any time. Work already agreed is unaffected.
        </p>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          I want to leave
        </Button>
      </Card>
    );
  }

  return (
    <Card title="Leaving JobWork">
      <Callout tone="blocked" title="This cannot be undone here">
        You stop being matched immediately. Your record, your evidence and everything you have
        already been awarded stay exactly as they are. Coming back means being admitted again.
      </Callout>
      <TextInput
        label={`Type “${name}” to confirm`}
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
      />
      <TextInput
        label="Anything you want us to know?"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <Inline gap={2}>
        <CommandButton
          variant="danger"
          receiptLabel="Left"
          disabled={confirmation.trim().toLowerCase() !== name.trim().toLowerCase()}
          onCommand={async () => {
            await api('/suppliers/me/exit', {
              method: 'POST',
              body: { confirmation: confirmation.trim(), reason },
              idempotencyKey: crypto.randomUUID(),
            });
            window.location.reload();
          }}
        >
          Leave the network
        </CommandButton>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Stay
        </Button>
      </Inline>
    </Card>
  );
}
