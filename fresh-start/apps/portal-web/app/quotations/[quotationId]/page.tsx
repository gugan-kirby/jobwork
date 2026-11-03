'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { CustomerQuote } from '@jobwork/contracts';
import {
  BrandGlyph,
  Button,
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
 *
 * VF-10 (reference screen 10, corrected): the reference's vendor card (name, "Verified
 * Vendor", city, rating, call and chat) is JobWork's card — the accountable counterpart —
 * whose call and message buttons reach JobWork's help and support. The tinted summary
 * carries the amount, lead time and quantity with Download Quote and Accept Quote; the
 * breakdown and terms follow as split rows in bordered panels.
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

  const quantity = quote.lines.reduce((sum, line) => sum + line.quantity, 0);
  const unit = quote.lines[0]?.unit === 'piece' || !quote.lines[0] ? 'Nos' : quote.lines[0].unit;

  return (
    <Page
      title="Quote Details"
      back={{ href: '/quotations', label: 'Back to quotations' }}
    >
      <Stack gap={5}>
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : null}

        <section className="jw-tinted-card" aria-label="Quoted by">
          <div className="jw-counterpart">
            <span className="jw-counterpart-tile" aria-hidden="true">
              <BrandGlyph size={40} />
            </span>
            <div style={{ display: 'grid', gap: 'var(--space-1)', minWidth: 0 }}>
              <div className="jw-counterpart-top">
                <p className="jw-counterpart-name">JobWork</p>
                <div className="jw-icon-actions">
                  <Link href="/help" aria-label="Call or email JobWork">
                    <Icon name="phone" size={1.3} />
                  </Link>
                  <Link href="/support" aria-label="Message JobWork">
                    <Icon name="message" size={1.3} />
                  </Link>
                </div>
              </div>
              <p className="jw-counterpart-line jw-counterpart-line-strong">
                <Icon name="checkCircle" size={1.15} />
                Accountable counterpart
              </p>
              <p className="jw-counterpart-line">
                <span className="mono">{quote.reference}</span> · {OPTION_LABEL[quote.optionLabel]} · v{quote.versionNo}
              </p>
              <p className="jw-counterpart-line">
                for{' '}
                <Link href={`/enquiries/${quote.enquiry.enquiryId}`} className="jw-inline-link">
                  {quote.enquiry.reference ?? quote.enquiry.title}
                </Link>
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusChip tone={TONE[quote.status]}>{quote.statusLabel}</StatusChip>
            <span
              className="jw-counterpart-line"
              style={open && quote.daysToExpiry <= 3 ? { color: 'var(--status-attention-fg)' } : undefined}
            >
              {open
                ? quote.daysToExpiry >= 0
                  ? `Valid until ${quote.validityUntil} — ${quote.daysToExpiry} day${quote.daysToExpiry === 1 ? '' : 's'} left`
                  : 'Validity has passed'
                : `Valid until ${quote.validityUntil}`}
            </span>
          </div>
        </section>

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

        <section aria-labelledby="quote-summary">
          <h2 id="quote-summary" className="jw-section-heading">
            Quote Summary
          </h2>
          <div className="jw-tinted-card">
            <div className="jw-summary-figures">
              <div>
                <p className="jw-summary-label">Quote Amount</p>
                <p className="jw-summary-amount numeric">{money(quote.totalMinor)}</p>
              </div>
              <div>
                <p className="jw-summary-fact">
                  <Icon name="calendar" size={1.2} />
                  Lead Time: <strong>{quote.deliveryLeadDays} Days</strong>
                </p>
                <p className="jw-summary-fact">
                  <Icon name="layers" size={1.2} />
                  Quantity: <strong>{quantity} {unit}</strong>
                </p>
              </div>
            </div>
            <div className={open ? 'jw-action-pair' : undefined}>
              <button type="button" className="jw-cta-outline jw-cta-sm jw-cta-icon" onClick={() => void download()}>
                <Icon name="download" size={1.2} />
                Download Quote
              </button>
              {open ? (
                quote.actions.canAccept ? (
                  <Link href={`/quotations/${quotationId}/accept`} className="jw-cta jw-cta-sm jw-cta-icon">
                    <Icon name="checkCircle" size={1.2} />
                    Accept Quote
                  </Link>
                ) : (
                  <Button disabled disabledReason="Only someone allowed to approve purchases can accept">
                    Accept Quote
                  </Button>
                )
              ) : null}
            </div>
          </div>
        </section>

        {quote.siblingOptions.length > 0 ? (
          <section aria-labelledby="quote-options">
            <h2 id="quote-options" className="jw-section-heading">
              Other Options
            </h2>
            <div className="jw-panel">
              <DescriptionList
                layout="split"
                items={quote.siblingOptions.map((option) => ({
                  label: OPTION_LABEL[option.optionLabel],
                  value: (
                    <Link href={`/quotations/${option.quotationId}`} className="jw-inline-link">
                      {money(option.totalMinor)} · {option.deliveryLeadDays} days
                    </Link>
                  ),
                }))}
              />
            </div>
          </section>
        ) : null}

        <section aria-labelledby="quote-price">
          <h2 id="quote-price" className="jw-section-heading">
            Price Breakdown
          </h2>
          <div className="jw-panel">
            <DescriptionList
              layout="split"
              items={[
                ...quote.lines.flatMap((line) => [
                  { label: quote.lines.length > 1 ? `Part ${line.lineNo}` : 'Part / Job Name', value: line.description },
                  { label: 'Quantity', value: `${line.quantity} ${line.unit === 'piece' ? 'Nos' : line.unit}`, numeric: true },
                  { label: 'Unit Price', value: money(line.unitPriceMinor), numeric: true },
                ]),
                { label: 'Subtotal', value: money(quote.subtotalMinor), numeric: true },
                ...(quote.freightMinor > 0 ? [{ label: 'Freight', value: money(quote.freightMinor), numeric: true }] : []),
                { label: `GST (${(quote.taxRateBp / 100).toFixed(0)}%)`, value: money(quote.taxMinor), numeric: true },
                { label: 'Total Amount', value: <strong>{money(quote.totalMinor)}</strong>, numeric: true },
              ]}
            />
          </div>
        </section>

        <section aria-labelledby="quote-terms">
          <h2 id="quote-terms" className="jw-section-heading">
            Terms
          </h2>
          <div className="jw-panel">
            <DescriptionList
              layout="split"
              items={[
                { label: 'Delivery Time', value: `${quote.deliveryLeadDays} days from acceptance` },
                { label: 'Payment Terms', value: quote.paymentTerms },
                {
                  label: 'Payment Schedule',
                  value:
                    quote.advanceBp > 0
                      ? `${(quote.advanceBp / 100).toFixed(0)} % advance on acceptance, balance ${BALANCE_WORDS[quote.balanceTrigger]}`
                      : `Full amount ${BALANCE_WORDS[quote.balanceTrigger]}`,
                },
                { label: 'Validity', value: quote.validityUntil },
                {
                  label: 'Conditions',
                  value: (
                    <Link href="/terms" className="jw-inline-link">
                      {quote.terms.code.replace(/_/g, ' ')} v{quote.terms.versionNo}
                    </Link>
                  ),
                },
              ]}
            />
          </div>
        </section>

        {quote.scopeNote || quote.assumptions || quote.exclusions ? (
          <section aria-labelledby="quote-notes">
            <h2 id="quote-notes" className="jw-section-heading">
              Notes
            </h2>
            <div className="jw-panel">
              {[
                ['Scope', quote.scopeNote],
                ['Assumptions', quote.assumptions],
                ['Exclusions', quote.exclusions],
              ]
                .filter(([, text]) => text)
                .map(([label, text]) => (
                  <p key={label} className="jw-note-row">
                    <Icon name="document" size={1.4} />
                    <span>
                      <strong>{label}: </strong>
                      {text}
                    </span>
                  </p>
                ))}
            </div>
          </section>
        ) : null}

        <CopyableId label="Content hash" value={quote.contentHash} />

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

        {open ? (
          <Stack gap={3}>
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
