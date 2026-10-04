'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { CustomerPayments } from '@jobwork/contracts';
import {
  ButtonLink,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  RecordList,
  Stack,
  formatMoney,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * Payments (prototype tile 14, corrected per D-03): every payment you made to JobWork,
 * matched to its invoice. There is no wallet and no "add money": an overpayment stays
 * yours as visible credit, applied to a later invoice or refunded on request.
 */
export default function PaymentsPage() {
  const [data, setData] = useState<CustomerPayments | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<CustomerPayments>('/payments')
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  return (
    <Page title="Payments" back={{ href: '/', label: 'Back to home' }} description="Every payment you have made to JobWork, matched to its invoice.">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {data && data.unappliedCreditMinor > 0 ? (
          <Callout tone="progress" title={`${formatMoney({ amountMinor: data.unappliedCreditMinor, currency: data.currency })} of your money is unapplied`}>
            You paid more than an invoice asked for. It stays yours: JobWork finance applies it to your next invoice or refunds it on request. <Link href="/help">Ask for a refund</Link>.
          </Callout>
        ) : null}
        {error ? null : data === null ? (
          <Card>
            <LoadingState label="Loading your payments" />
          </Card>
        ) : data.payments.length === 0 ? (
          <Card>
            <EmptyState
              title="No payments yet"
              detail="You pay JobWork against an invoice, through the payment gateway or by bank transfer with the invoice reference. Nothing is held in a wallet and nothing is paid to a workshop directly."
              action={
                <ButtonLink href="/invoices" variant="secondary">See your invoices</ButtonLink>
              }
            />
          </Card>
        ) : (
          <RecordList>
            {data.payments.map((p) => (
              <div key={p.transactionId} className="jw-record" style={{ cursor: 'default' }}>
                <span className="jw-record-main">
                  <span className="jw-record-ref mono">{p.invoiceNumber ?? p.reference}</span>
                  <span className="jw-record-title">{p.label}</span>
                  <span className="jw-record-caption">
                    {p.occurredAt.slice(0, 10)}
                    {p.orderNumber ? ` · order ${p.orderNumber}` : ''}
                  </span>
                </span>
                <span className="jw-record-side">
                  <span className="jw-record-figure numeric">{formatMoney({ amountMinor: p.amountMinor, currency: p.currency })}</span>
                  <span className="jw-record-meta mono">{p.reference.slice(0, 18)}</span>
                </span>
              </div>
            ))}
          </RecordList>
        )}
      </Stack>
    </Page>
  );
}
