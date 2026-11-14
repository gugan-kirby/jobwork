'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { CustomerQuote } from '@jobwork/contracts';
import { displayMoney, loadEnquiryFacts, unitLabel, type EnquiryFacts } from '../../../lib/enquiry-facts';
import {
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
 * VF-10, VF-18 (reference screen 10, ADR-0007): the supplier's public card, the quote summary
 * with Download Quote and Accept Quote, the enquiry details, specifications and attachments.
 * Call and message reach JobWork's help and support until shared threads land (ADR-0007
 * P5). Price breakdown and terms sit under one closed row: the customer must be able to
 * read what they accept, and the revision and reject decisions live there too.
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
  const [facts, setFacts] = useState<EnquiryFacts | null>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await api<CustomerQuote>(`/quotations/${quotationId}`);
      setQuote(loaded);
      setError(null);
      setFacts(await loadEnquiryFacts(loaded.enquiry.enquiryId).catch(() => null));
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

  async function downloadFile(versionId: string): Promise<void> {
    const grant = await api<{ url: string }>(`/documents/versions/${versionId}/download`);
    window.location.assign(grant.url);
  }

  const open = quote.status === 'quotation_ready';

  const quantity = quote.lines.reduce((sum, line) => sum + line.quantity, 0);
  const unit = unitLabel(quote.lines[0]?.unit);

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
              <Icon name="factory" size={2} />
            </span>
            <div style={{ display: 'grid', gap: 'var(--space-1)', minWidth: 0 }}>
              <div className="jw-counterpart-top">
                <p className="jw-counterpart-name">{quote.supplier?.name ?? 'JobWork'}</p>
                <div className="jw-icon-actions">
                  <Link href="/help" aria-label="Call">
                    <Icon name="phone" size={1.3} />
                  </Link>
                  <Link href="/support" aria-label="Chat">
                    <Icon name="message" size={1.3} />
                  </Link>
                </div>
              </div>
              {quote.supplier?.verified ? (
                <p className="jw-counterpart-line jw-counterpart-line-strong">
                  <Icon name="checkCircle" size={1.15} />
                  Verified Vendor
                </p>
              ) : null}
              {quote.supplier?.city ? (
                <p className="jw-counterpart-line">
                  <Icon name="location" size={1.1} /> {[quote.supplier.city, quote.supplier.state].filter(Boolean).join(', ')}
                </p>
              ) : null}
              {quote.supplier ? (
                <p className="jw-counterpart-line jw-rating">
                  <Icon name="star" size={1.1} />{' '}
                  {quote.supplier.ratingAverage !== null
                    ? `${quote.supplier.ratingAverage.toFixed(1)} (${quote.supplier.ratingCount} Reviews)`
                    : 'New'}
                </p>
              ) : null}
              {open ? null : (
                <span>
                  <StatusChip tone={TONE[quote.status]}>{quote.statusLabel}</StatusChip>
                </span>
              )}
            </div>
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
                <p className="jw-summary-amount numeric">{displayMoney(quote.totalMinor, quote.currency)}</p>
              </div>
              <div>
                <p className="jw-summary-fact">
                  <Icon name="calendar" size={1.2} />
                  Lead Time: <strong>{quote.deliveryLeadDays} Days</strong>
                </p>
                <p className="jw-summary-fact">
                  <Icon name="layers" size={1.2} />
                  Min. Quantity: <strong>{quantity} {unit}</strong>
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

        <section aria-labelledby="quote-enquiry">
          <h2 id="quote-enquiry" className="jw-section-heading">
            Enquiry Details
          </h2>
          <div className="jw-panel">
            <DescriptionList
              layout="split"
              items={[
                { label: 'Part / Job Name', value: quote.enquiry.title },
                { label: 'Category', value: facts?.category ?? '—' },
                { label: 'Material', value: facts?.material ?? '—' },
                { label: 'Quantity', value: facts?.quantity ?? `${quantity} ${unit}` },
                { label: 'Delivery Location', value: facts?.location ?? '—' },
              ]}
            />
          </div>
        </section>

        <section aria-labelledby="quote-specifications">
          <h2 id="quote-specifications" className="jw-section-heading">
            Specifications
          </h2>
          <div className="jw-panel">
            <p className="jw-note-row">
              <Icon name="enquiries" size={1.4} />
              <span>{facts?.specifications || 'None added'}</span>
            </p>
          </div>
        </section>

        {facts && facts.files.length > 0 ? (
          <section aria-labelledby="quote-attachments">
            <h2 id="quote-attachments" className="jw-section-heading">
              Attachments
            </h2>
            <div className="jw-panel">
              <ul className="jw-attached" style={{ margin: 'var(--space-3) 0' }}>
                {facts.files.map((file) => (
                  <li key={file.versionId}>
                    <span className="jw-file-badge" aria-hidden="true">
                      <span>{file.name.split('.').pop()?.toUpperCase().slice(0, 4) ?? 'FILE'}</span>
                    </span>
                    {file.name}
                    <button type="button" aria-label={`Download ${file.name}`} onClick={() => void downloadFile(file.versionId)}>
                      <Icon name="download" size={1.3} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        <details className="jw-more">
          <summary>Price &amp; Terms</summary>
          <Stack gap={4}>
            {quote.siblingOptions.length > 0 ? (
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
            ) : null}
            <div className="jw-panel">
              <DescriptionList
                layout="split"
                items={[
                  ...quote.lines.flatMap((line) => [
                    { label: quote.lines.length > 1 ? `Part ${line.lineNo}` : 'Part Name', value: line.description },
                    { label: 'Quantity', value: `${line.quantity} ${unitLabel(line.unit)}`, numeric: true },
                    { label: 'Unit Price', value: money(line.unitPriceMinor), numeric: true },
                  ]),
                  { label: 'Subtotal', value: money(quote.subtotalMinor), numeric: true },
                  ...(quote.freightMinor > 0 ? [{ label: 'Freight', value: money(quote.freightMinor), numeric: true }] : []),
                  { label: `GST (${(quote.taxRateBp / 100).toFixed(0)}%)`, value: money(quote.taxMinor), numeric: true },
                  { label: 'Total Amount', value: <strong>{money(quote.totalMinor)}</strong>, numeric: true },
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
                  ...(quote.scopeNote ? [{ label: 'Scope', value: quote.scopeNote }] : []),
                  ...(quote.assumptions ? [{ label: 'Assumptions', value: quote.assumptions }] : []),
                  ...(quote.exclusions ? [{ label: 'Exclusions', value: quote.exclusions }] : []),
                ]}
              />
            </div>
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
                <Button variant="ghost" disabled={!quote.actions.canRequestRevision} disabledReason="Only your company’s requesters and approvers can ask for a revision" onClick={() => setMode('revision')}>Request a revision</Button>
                <Button variant="ghost" disabled={!quote.actions.canReject} disabledReason="Only someone allowed to approve purchases can reject" onClick={() => setMode('reject')}>Reject</Button>
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
        </details>
      </Stack>
    </Page>
  );
}
