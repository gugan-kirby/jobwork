'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { CustomerOrder, CustomerQuote } from '@jobwork/contracts';
import {
  ButtonLink,
  Callout,
  Card,
  Checkbox,
  CommandButton,
  CopyableId,
  DescriptionList,
  ErrorState,
  LoadingState,
  Page,
  Stack,
  formatMoney,
} from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';

/**
 * Acceptance (UC-05, `FR-407`). The page shows exactly what will be bound — revision,
 * total, schedule, terms version and the content hash — and sends those same values
 * back. If anything changed since it loaded, the server refuses and the page says so;
 * the customer never accepts something other than what is on the screen.
 */

const BALANCE_WORDS: Record<CustomerQuote['balanceTrigger'], string> = {
  on_acceptance: 'on acceptance',
  before_dispatch: 'before dispatch',
  on_delivery: 'on delivery',
  net_30: '30 days from invoice',
};

export default function AcceptQuotationPage() {
  const quotationId = useParams<{ quotationId: string }>().quotationId;
  const router = useRouter();
  const [quote, setQuote] = useState<CustomerQuote | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    api<CustomerQuote>(`/quotations/${quotationId}`)
      .then(setQuote)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, [quotationId]);

  if (!quote) {
    return (
      <Page title="Accept quotation" back={{ href: `/quotations/${quotationId}`, label: 'Back to the quotation' }}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the quotation" /></Card>}
      </Page>
    );
  }

  const money = (minor: number): string => formatMoney({ amountMinor: minor, currency: quote.currency });
  const advanceMinor = Math.round((quote.totalMinor * quote.advanceBp) / 10_000);
  const open = quote.actions.canAccept;

  async function accept(): Promise<void> {
    if (!quote) return;
    const order = await api<CustomerOrder>(`/quotations/${quotationId}/accept`, {
      method: 'POST',
      body: {
        expectedVersion: quote.aggregateVersion,
        quoteVersionNo: quote.versionNo,
        contentHash: quote.contentHash,
        termsHash: quote.terms.hash,
        acknowledgeTerms: true,
      },
      // One key per revision: a double tap or a retry after a dropped connection returns the same order.
      idempotencyKey: `accept-${quotationId}-v${quote.versionNo}`,
    });
    router.push(`/orders/${order.orderId}?accepted=1`);
  }

  return (
    <Page title="Accept quotation" back={{ href: `/quotations/${quotationId}`, label: 'Back to the quotation' }} width="narrow">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {!open ? (
          <Callout tone="neutral" title="This quotation is not open for acceptance">
            It is {quote.statusLabel.toLowerCase()}. <Link href={`/quotations/${quotationId}`}>Back to the quotation</Link>.
          </Callout>
        ) : null}

        <Card title="What you are accepting">
          <DescriptionList
            columns={1}
            items={[
              { label: 'Quotation', value: `${quote.reference} · revision ${quote.versionNo}`, mono: true },
              { label: 'Issued by', value: 'JobWork' },
              { label: 'Total (incl. GST)', value: <strong>{money(quote.totalMinor)}</strong>, numeric: true },
              { label: 'Delivery', value: `${quote.deliveryLeadDays} days from release` },
              {
                label: 'Payment',
                value:
                  quote.advanceBp > 0
                    ? `${money(advanceMinor)} advance now (${(quote.advanceBp / 100).toFixed(0)} %), balance ${BALANCE_WORDS[quote.balanceTrigger]}`
                    : `Full amount ${BALANCE_WORDS[quote.balanceTrigger]}`,
              },
              { label: 'Valid until', value: quote.validityUntil },
              { label: 'Terms', value: <Link href="/terms">{quote.terms.code.replace(/_/g, ' ')} v{quote.terms.versionNo}</Link> },
            ]}
          />
          <div style={{ marginTop: 'var(--space-3)' }}>
            <CopyableId label="Content hash" value={quote.contentHash} />
          </div>
        </Card>

        <Card title="What happens next">
          <ol style={{ paddingLeft: 'var(--space-5)', display: 'grid', gap: 'var(--space-2)' }}>
            <li>Your order is created from this exact revision and its terms. Neither can change afterwards.</li>
            {quote.advanceBp > 0 ? <li>JobWork issues the advance invoice straight away. Pay it from the order or the invoice page.</li> : null}
            <li>Once the advance is received (or your approved credit covers it), engineering confirms the technical baseline and production is released.</li>
          </ol>
        </Card>

        {open ? (
          <Card>
            <Stack gap={3}>
              <Checkbox
                label="I have read the quotation and the terms, and I accept them on behalf of my organization."
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <CommandButton
                fullWidth
                receiptLabel="Accepted"
                disabled={!acknowledged}
                disabledReason="Confirm you have read the quotation and terms"
                onCommand={accept}
                onProblem={() => undefined}
              >
                Accept and place order
              </CommandButton>
              <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                Only approvers can accept. If the total is above your approval limit, ask a colleague with a higher limit.
              </p>
            </Stack>
          </Card>
        ) : null}

        <ButtonLink href="/help" fullWidth variant="secondary">
          Questions? Contact JobWork
        </ButtonLink>
      </Stack>
    </Page>
  );
}
