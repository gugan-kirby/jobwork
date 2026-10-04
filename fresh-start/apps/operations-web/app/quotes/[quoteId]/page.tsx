'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Quote, QuoteLineInput, QuoteVersion } from '@jobwork/contracts';
import {
  Button,
  Callout,
  Card,
  CommandButton,
  CopyableId,
  DescriptionList,
  ErrorState,
  Inline,
  LoadingState,
  Page,
  ReasonField,
  Stack,
  StatusChip,
  TextArea,
  TextInput,
  formatMoney,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * One customer quotation, every version (F-07.5). Named commands only: request
 * approval, send, replace, withdraw. A sent version is shown exactly as sent; a
 * replacement is a new draft version beside it.
 */

const TONE: Record<Quote['status'], Tone> = {
  draft: 'neutral',
  internal_approval: 'attention',
  approved: 'progress',
  sent: 'progress',
  revision_requested: 'attention',
  accepted: 'positive',
  rejected: 'blocked',
  expired: 'neutral',
  withdrawn: 'neutral',
};

export default function QuotePage(): React.JSX.Element {
  const quoteId = useParams<{ quoteId: string }>().quoteId;
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<ApiError | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<QuoteLineInput[]>([]);
  const [form, setForm] = useState({ deliveryLeadDays: '', paymentTerms: '', validityUntil: '', assumptions: '', exclusions: '', scopeNote: '', freightMinor: '0', taxRateBp: '1800' });
  const [preview, setPreview] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = await api<Quote>(`/quotes/${quoteId}`);
      setQuote(q);
      setError(null);
      const current = q.versions.find((v) => v.versionNo === q.currentVersionNo);
      if (current) {
        setLines(current.lines.map(({ amountMinor: _a, ...rest }) => rest));
        setForm({
          deliveryLeadDays: String(current.deliveryLeadDays),
          paymentTerms: current.paymentTerms,
          validityUntil: current.validityUntil,
          assumptions: current.assumptions,
          exclusions: current.exclusions,
          scopeNote: current.scopeNote,
          freightMinor: String(current.freightMinor),
          taxRateBp: String(current.taxRateBp),
        });
      }
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [quoteId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!quote) {
    return (
      <Page title="Quotation" breadcrumb={<Link href="/quotes">← Quotations</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the quotation" /></Card>}
      </Page>
    );
  }

  const current = quote.versions.find((v) => v.versionNo === quote.currentVersionNo)!;
  const money = (minor: number): string => formatMoney({ amountMinor: minor, currency: current.currency });

  const run = async (path: string, body: Record<string, unknown>): Promise<void> => {
    setNotice(null);
    try {
      await api(`/quotes/${quoteId}/${path}`, { method: 'POST', body: { expectedVersion: quote.aggregateVersion, ...body }, idempotencyKey: `${path}-${quoteId}-${quote.aggregateVersion}` });
      await load();
    } catch (err) {
      if (err instanceof ApiError) setNotice(err);
      throw err;
    }
  };

  const versionCard = (v: QuoteVersion): React.JSX.Element => (
    <Card
      key={v.quoteVersionId}
      title={`Version ${v.versionNo}`}
      actions={<StatusChip tone={v.status === 'sent' || v.status === 'accepted' ? 'positive' : v.status === 'superseded' || v.status === 'withdrawn' ? 'neutral' : 'progress'}>{v.status.replace(/_/g, ' ')}</StatusChip>}
    >
      <DescriptionList
        columns={2}
        items={[
          { label: 'Total', value: money(v.totalMinor), numeric: true },
          { label: 'Subtotal / tax / freight', value: `${money(v.subtotalMinor)} / ${money(v.taxMinor)} / ${money(v.freightMinor)}`, numeric: true },
          { label: 'Delivery', value: `${v.deliveryLeadDays} days` },
          { label: 'Valid until', value: v.validityUntil },
          { label: 'Payment', value: v.paymentTerms },
          { label: 'Terms', value: `v${v.termsVersionNo}` },
          { label: 'Approval', value: v.approvalStatus ?? '—' },
          { label: 'Sent', value: v.sentAt ? v.sentAt.slice(0, 16).replace('T', ' ') : '—' },
          ...(v.revisionReason ? [{ label: 'Revision reason', value: v.revisionReason }] : []),
        ]}
      />
      <ul style={{ listStyle: 'none', marginTop: 'var(--space-3)', font: 'var(--text-caption)' }}>
        {v.lines.map((l) => (
          <li key={l.lineNo}>{l.lineNo}. {l.description} — {l.quantity} {l.unit} × {money(l.unitPriceMinor)} = {money(l.amountMinor)}</li>
        ))}
      </ul>
      <div style={{ marginTop: 'var(--space-3)' }}>
        <Inline gap={3}>
          <CopyableId label="Content hash" value={v.contentHash} />
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              const doc = await api<{ html: string }>(`/quotes/${quoteId}/versions/${v.versionNo}/document`);
              setPreview(doc.html);
            }}
          >
            Preview document
          </Button>
        </Inline>
      </div>
    </Card>
  );

  return (
    <Page
      title={quote.reference ?? `Draft ${quote.optionLabel} quotation`}
      breadcrumb={<Link href="/quotes">← Quotations</Link>}
      description={`${quote.customerDisplayName} · ${quote.enquiryReference ?? quote.enquiryTitle} · ${quote.optionLabel} option`}
      width="wide"
      actions={<StatusChip tone={TONE[quote.status]}>{quote.status.replace(/_/g, ' ')}</StatusChip>}
    >
      <Stack gap={4}>
        {notice ? <Callout tone="blocked" assertive title={notice.problem.title}>{notice.problem.detail ?? ''} ({notice.problem.code})</Callout> : null}
        {quote.status === 'revision_requested' ? (
          <Callout tone="attention" title="The customer asked for a revision">{quote.decisionReason}</Callout>
        ) : null}
        {quote.status === 'rejected' ? <Callout tone="blocked" title="Rejected by the customer">{quote.decisionReason}</Callout> : null}

        <Card title="Actions">
          <Inline gap={2}>
            {quote.status === 'draft' ? (
              <CommandButton receiptLabel="Requested" onCommand={() => run('request-approval', {})}>Request approval</CommandButton>
            ) : null}
            {quote.status === 'approved' ? (
              <CommandButton receiptLabel="Sent" onCommand={() => run('send', {})}>Send to customer</CommandButton>
            ) : null}
            {['sent', 'revision_requested', 'draft', 'approved', 'internal_approval'].includes(quote.status) ? (
              <Button variant="secondary" onClick={() => setReplacing((r) => !r)}>Replace with a new version…</Button>
            ) : null}
            {!['accepted', 'rejected', 'expired', 'withdrawn'].includes(quote.status) ? (
              <Button variant="ghost" onClick={() => setWithdrawing((w) => !w)}>Withdraw…</Button>
            ) : null}
            {quote.costSheetVersionId ? <Link href={`/awards`}>Cost sheet lineage</Link> : null}
          </Inline>
          {quote.status === 'internal_approval' ? <p style={{ marginTop: 'var(--space-2)', color: 'var(--color-text-muted)' }}>Waiting on <Link href="/approvals">Approvals</Link>.</p> : null}
        </Card>

        {replacing ? (
          <Card title="New version" description="Supersedes the current one once sent. The customer keeps reading the sent version until then.">
            <Stack gap={3}>
              {lines.map((l, i) => (
                <Inline key={l.lineNo} gap={2}>
                  <TextInput label={`Line ${l.lineNo}`} value={l.description} onChange={(e) => setLines((cur) => cur.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                  <TextInput label="Qty" type="number" numeric value={String(l.quantity)} onChange={(e) => setLines((cur) => cur.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} />
                  <TextInput label="Unit price (₹)" type="number" numeric value={(l.unitPriceMinor / 100).toString()} onChange={(e) => setLines((cur) => cur.map((x, j) => (j === i ? { ...x, unitPriceMinor: Math.round(Number(e.target.value || 0) * 100) } : x)))} />
                </Inline>
              ))}
              <Inline gap={2}>
                <TextInput label="Delivery (days)" type="number" numeric value={form.deliveryLeadDays} onChange={(e) => setForm({ ...form, deliveryLeadDays: e.target.value })} />
                <TextInput label="Valid until" type="date" value={form.validityUntil} onChange={(e) => setForm({ ...form, validityUntil: e.target.value })} />
                <TextInput label="Freight (₹)" type="number" numeric value={(Number(form.freightMinor) / 100).toString()} onChange={(e) => setForm({ ...form, freightMinor: String(Math.round(Number(e.target.value || 0) * 100)) })} />
              </Inline>
              <TextInput label="Payment terms" value={form.paymentTerms} onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })} />
              <TextArea label="Assumptions" value={form.assumptions} onChange={(e) => setForm({ ...form, assumptions: e.target.value })} />
              <TextArea label="Exclusions" value={form.exclusions} onChange={(e) => setForm({ ...form, exclusions: e.target.value })} />
              <ReasonField label="Why this revision" audience="customer" value={reason} onChange={setReason} />
              <CommandButton
                receiptLabel="Replaced"
                disabled={reason.trim().length < 3}
                disabledReason="Say what changed and why"
                onCommand={async () => {
                  await run('replace', {
                    revisionReason: reason.trim(),
                    content: {
                      lines,
                      taxRateBp: Number(form.taxRateBp),
                      freightMinor: Number(form.freightMinor),
                      deliveryLeadDays: Number(form.deliveryLeadDays),
                      paymentTerms: form.paymentTerms,
                      validityUntil: form.validityUntil,
                      assumptions: form.assumptions,
                      exclusions: form.exclusions,
                      scopeNote: form.scopeNote,
                    },
                  });
                  setReplacing(false);
                  setReason('');
                }}
              >
                Create version {quote.currentVersionNo + 1}
              </CommandButton>
            </Stack>
          </Card>
        ) : null}

        {withdrawing ? (
          <Card title="Withdraw this quotation">
            <ReasonField label="Why" audience="internal" value={reason} onChange={setReason} />
            <CommandButton variant="danger" receiptLabel="Withdrawn" disabled={reason.trim().length < 3} disabledReason="Say why" onCommand={async () => { await run('withdraw', { reason: reason.trim() }); setWithdrawing(false); setReason(''); }}>
              Withdraw
            </CommandButton>
          </Card>
        ) : null}

        {preview ? (
          <Card title="Document preview" actions={<Button variant="ghost" size="sm" onClick={() => setPreview(null)}>Close</Button>}>
            <iframe title="Quotation document" srcDoc={preview} style={{ width: '100%', height: 'var(--container-narrow)', border: 'var(--hairline) solid var(--color-border)', borderRadius: 'var(--radius-sm)' }} />
          </Card>
        ) : null}

        {quote.versions.map(versionCard)}
      </Stack>
    </Page>
  );
}
