'use client';

import Link from 'next/link';
import type { CustomerInvoice } from '@jobwork/contracts';
import { CommandButton, Icon, StatusChip, formatMoney, type Tone } from '@jobwork/ui';
import { dueWords, fmt, isOpen } from '../lib/invoice-due';

/**
 * One invoice as the reference screens draw it (VF-13/VF-14): the record link, and for an
 * open invoice a due strip with its own Pay Now — a separate control, never inside the
 * link. Shared by Invoices and the Pending tab of Payments.
 */

const TONE: Record<CustomerInvoice['status'], Tone> = {
  unpaid: 'attention',
  partially_paid: 'attention',
  paid: 'positive',
  void: 'neutral',
};

export function InvoiceCard({
  invoice: i,
  now,
  onPay,
}: {
  invoice: CustomerInvoice;
  now: number;
  onPay: (invoiceId: string) => Promise<void>;
}): React.JSX.Element {
  const due = isOpen(i) ? dueWords(i, now) : null;
  const paid = i.status === 'paid';
  return (
                <article className="jw-invoice">
                  <Link href={`/invoices/${i.invoiceId}`} className="jw-record jw-record-rich jw-invoice-main">
                    <span className={`jw-record-tile ${paid ? 'jw-record-tile-green' : 'jw-record-tile-sky'}`} aria-hidden="true">
                      <Icon name={paid ? 'checkCircle' : 'invoice'} size={1.9} />
                    </span>
                    <span className="jw-record-main">
                      <span className="jw-record-top">
                        <span className="jw-record-title">{i.number}</span>
                        <StatusChip tone={TONE[i.status]}>{i.statusLabel}</StatusChip>
                      </span>
                      <span className="jw-record-caption">
                        Order #<span className="mono">{i.orderNumber}</span> •{' '}
                        {i.kind === 'advance' ? 'Advance' : i.kind === 'balance' ? 'Balance' : i.kind === 'change' ? 'Change' : 'Final'}
                      </span>
                      <span className="jw-record-foot">
                        <span className="jw-record-date">
                          <Icon name="calendar" size={1.15} />
                          {fmt(i.issuedAt)}
                        </span>
                        <span className="jw-invoice-amount numeric">
                          {formatMoney({ amountMinor: paid ? i.totalMinor : i.openMinor, currency: i.currency })}
                        </span>
                      </span>
                    </span>
                    <span className="jw-record-chevron">
                      <Icon name="chevron" size={1.4} />
                    </span>
                  </Link>
                  {due ? (
                    <div className={due.overdue ? 'jw-due jw-due-overdue' : 'jw-due'}>
                      <span className="jw-due-text">
                        <Icon name="clock" size={1.2} />
                        {due.text}
                      </span>
                      {i.pendingPayment ? (
                        <span className="jw-due-text">Verifying payment…</span>
                      ) : (
                        <CommandButton size="sm" receiptLabel="Opening payment" onCommand={() => onPay(i.invoiceId)}>
                          Pay Now<span className="jw-visually-hidden">, {i.number}</span>
                        </CommandButton>
                      )}
                    </div>
                  ) : null}
                </article>
              );
}
