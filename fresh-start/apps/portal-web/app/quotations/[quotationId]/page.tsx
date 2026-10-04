'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { CustomerQuote } from '@jobwork/contracts';
import {
  Button,
  ButtonLink,
  Callout,
  Card,
  CommandButton,
  CopyableId,
  DescriptionList,
  ErrorState,
  Icon,
  LoadingState,
  Page,
  ReasonField,
  Stack,
  StatusChip,
  formatMoney,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * Quotation detail (prototype tile 10, corrected per doc 14 §4): JobWork's identity, the
 * revision and its validity, lines and tax and terms, assumptions and exclusions, the
 * diff against the previous revision, and the three decisions. No supplier, no
 * "Chat" — contact goes through JobWork.
 */

const TONE: Record<CustomerQuote['status'], Tone> = {
  quotation_ready: 'attention',
  revision_requested: 'progress',
  accepted: 'positive',
  rejected: 'neutral',
  expired: 'neutral',
  withdrawn: 'neutral',
};

const BALANCE_WORDS: Record<CustomerQuote['balanceTrigger'], string> = {
  on_acceptance: 'on acceptance',
  before_dispatch: 'before dispatch',
  on_delivery: 'on delivery',
  net_30: '30 days from invoice',
};

const OPTION_LABEL: Record<CustomerQuote['optionLabel'], string> = {
  standard: 'Standard',
  fast: 'Fast',
  premium: 'Premium',
};

export default function QuotationDetailPage() {
  const quotationId = useParams<{ quotationId: string }>().quotationId;
  const [quote, setQuote] = useState<CustomerQuote | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'none' | 'revision' | 'reject'>('none');

  const load = useCallback(async () => {
    try {
      setQuote(await api<CustomerQuote>(`/quotations/${quotationId}`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [quotationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(kind: 'request-revision' | 'reject'): Promise<void> {
    if (!quote) return;
    await api(`/quotations/${quotationId}/${kind}`, {
      method: 'POST',
      body: { expectedVersion: quote.aggregateVersion, reason: reason.trim() },
      idempotencyKey: `${kind}-${quotationId}-${quote.aggregateVersion}`,
    });
    setMode('none');
    setReason('');
    await load();
  }

  async function download(): Promise<void> {
    const doc = await api<{ html: string; contentHash: string }>(`/quotations/${quotationId}/document`);
    const blob = new Blob([doc.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${quote?.reference ?? 'quotation'}-v${quote?.versionNo ?? 1}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!quote) {
    return (
      <Page title="Quotation" back={{ href: '/quotations', label: 'Back to quotations' }}>
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : (
          <Card>
            <LoadingState label="Loading this quotation" />
          </Card>
        )}
      </Page>
    );
  }

  const money = (minor: number): string => formatMoney({ amountMinor: minor, currency: quote.currency });
  const open = quote.status === 'quotation_ready';

  return (
    <Page
      title="Quote details"
      back={{ href: '/quotations', label: 'Back to quotations' }}
      meta={
        <>
          <span className="mono">{quote.reference}</span>
          <StatusChip tone={TONE[quote.status]}>{quote.statusLabel}</StatusChip>
        </>
      }
    >
      <Stack gap={4}>
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : null}

        <Card>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <span className="jw-brand-mark" aria-hidden="true" style={{ width: 'var(--space-7)', height: 'var(--space-7)' }}>
              <Icon name="wrench" size={1.3} />
            </span>
            <div style={{ flex: 1 }}>
              <p style={{ font: 'var(--text-body-strong)' }}>Quotation from JobWork</p>
              <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                {OPTION_LABEL[quote.optionLabel]} option · revision {quote.versionNo} · for{' '}
                <Link href={`/enquiries/${quote.enquiry.enquiryId}`}>{quote.enquiry.reference ?? quote.enquiry.title}</Link>
              </p>
            </div>
          </div>
          <p style={{ marginTop: 'var(--space-3)', font: 'var(--text-caption)', color: open && quote.daysToExpiry <= 3 ? 'var(--status-attention-fg)' : 'var(--color-text-muted)' }}>
            {open
              ? quote.daysToExpiry >= 0
                ? `Valid until ${quote.validityUntil} — ${quote.daysToExpiry} day${quote.daysToExpiry === 1 ? '' : 's'} left`
                : 'Validity has passed'
              : `Valid until ${quote.validityUntil}`}
          </p>
        </Card>

        {quote.status === 'revision_requested' ? (
          <Callout tone="progress" title="A revision is on its way">
            {quote.decisionReason ? `You asked: “${quote.decisionReason}”. ` : ''}JobWork is preparing a replacement. This revision stays readable exactly as it was sent.
          </Callout>
        ) : null}
        {quote.status === 'rejected' && quote.decisionReason ? (
          <Callout tone="neutral" title="Rejected">
            Your reason: {quote.decisionReason}
          </Callout>
        ) : null}

        {quote.siblingOptions.length > 0 ? (
          <Card title="Other options for this enquiry">
            <Stack gap={2}>
              {quote.siblingOptions.map((option) => (
                <p key={option.quotationId}>
                  <Link href={`/quotations/${option.quotationId}`}>{OPTION_LABEL[option.optionLabel]}</Link> —{' '}
                  {money(option.totalMinor)} · {option.deliveryLeadDays} days
                </p>
              ))}
            </Stack>
          </Card>
        ) : null}

        <Card title="Quote summary">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <caption className="jw-visually-hidden">Quotation lines</caption>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', font: 'var(--text-caption)', color: 'var(--color-text-muted)', padding: 'var(--space-2) 0' }}>Item</th>
                <th className="numeric" style={{ textAlign: 'right', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>Qty</th>
                <th className="numeric" style={{ textAlign: 'right', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>Unit</th>
                <th className="numeric" style={{ textAlign: 'right', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {quote.lines.map((line) => (
                <tr key={line.lineNo} style={{ borderTop: 'var(--hairline) solid var(--color-border)' }}>
                  <td style={{ padding: 'var(--space-2) 0' }}>{line.description}</td>
                  <td className="numeric" style={{ textAlign: 'right' }}>{line.quantity} {line.unit === 'piece' ? 'Nos' : line.unit}</td>
                  <td className="numeric" style={{ textAlign: 'right' }}>{money(line.unitPriceMinor)}</td>
                  <td className="numeric" style={{ textAlign: 'right' }}>{money(line.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 'var(--space-3)' }}>
            <DescriptionList
              columns={1}
              items={[
                { label: 'Subtotal', value: money(quote.subtotalMinor), numeric: true },
                ...(quote.freightMinor > 0 ? [{ label: 'Freight', value: money(quote.freightMinor), numeric: true }] : []),
                { label: `GST (${(quote.taxRateBp / 100).toFixed(0)}%)`, value: money(quote.taxMinor), numeric: true },
                { label: 'Total', value: <strong>{money(quote.totalMinor)}</strong>, numeric: true },
                { label: 'Delivery time', value: `${quote.deliveryLeadDays} days from acceptance` },
                { label: 'Payment terms', value: quote.paymentTerms },
                {
                  label: 'Payment schedule',
                  value:
                    quote.advanceBp > 0
                      ? `${(quote.advanceBp / 100).toFixed(0)} % advance on acceptance, balance ${BALANCE_WORDS[quote.balanceTrigger]}`
                      : `Full amount ${BALANCE_WORDS[quote.balanceTrigger]}`,
                },
                { label: 'Validity', value: quote.validityUntil },
                ...(quote.scopeNote ? [{ label: 'Scope', value: quote.scopeNote }] : []),
                ...(quote.assumptions ? [{ label: 'Assumptions', value: quote.assumptions }] : []),
                ...(quote.exclusions ? [{ label: 'Exclusions', value: quote.exclusions }] : []),
                { label: 'Terms', value: <Link href="/terms">{quote.terms.code.replace(/_/g, ' ')} v{quote.terms.versionNo}</Link> },
              ]}
            />
          </div>
          <div style={{ marginTop: 'var(--space-3)' }}>
            <CopyableId label="Content hash" value={quote.contentHash} />
          </div>
        </Card>

        {quote.previousVersions.length > 0 ? (
          <Card title="Earlier revisions" description="What changed, revision by revision.">
            <Stack gap={3}>
              {quote.previousVersions.map((v) => (
                <div key={v.versionNo}>
                  <p style={{ font: 'var(--text-body-strong)' }}>
                    Revision {v.versionNo} — {money(v.totalMinor)}
                    {v.sentAt ? ` · sent ${v.sentAt.slice(0, 10)}` : ''}
                  </p>
                  {v.revisionReason ? <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>{v.revisionReason}</p> : null}
                  {v.changes.length > 0 ? (
                    <ul style={{ paddingLeft: 'var(--space-4)', font: 'var(--text-caption)' }}>
                      {v.changes.map((c) => (
                        <li key={`${v.versionNo}-${c.field}`}>{c.field}: {c.from} → {c.to}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </Stack>
          </Card>
        ) : null}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
          <ButtonLink href="/help" variant="secondary" fullWidth>Contact JobWork</ButtonLink>
          <Button variant="secondary" fullWidth onClick={() => void download()}>
            Download
          </Button>
        </div>

        {open ? (
          <Stack gap={3}>
            <ButtonLink
              href={`/quotations/${quotationId}/accept`}
              fullWidth
              disabled={!quote.actions.canAccept}
            >
              Accept quote
            </ButtonLink>
            {mode === 'none' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                <Button variant="ghost" onClick={() => setMode('revision')}>Request a revision</Button>
                <Button variant="ghost" onClick={() => setMode('reject')}>Reject</Button>
              </div>
            ) : (
              <Card title={mode === 'revision' ? 'Request a revision' : 'Reject this quotation'}>
                <ReasonField
                  label={mode === 'revision' ? 'What should change?' : 'Why are you rejecting it?'}
                  audience="internal"
                  value={reason}
                  onChange={setReason}
                />
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <CommandButton
                    variant={mode === 'reject' ? 'danger' : 'primary'}
                    receiptLabel={mode === 'revision' ? 'Sent' : 'Rejected'}
                    disabled={reason.trim().length < 3}
                    disabledReason="Give JobWork a reason to work with"
                    onCommand={() => decide(mode === 'revision' ? 'request-revision' : 'reject')}
                  >
                    {mode === 'revision' ? 'Send revision request' : 'Reject quotation'}
                  </CommandButton>
                  <Button variant="secondary" onClick={() => setMode('none')}>Cancel</Button>
                </div>
              </Card>
            )}
          </Stack>
        ) : null}
      </Stack>
    </Page>
  );
}
