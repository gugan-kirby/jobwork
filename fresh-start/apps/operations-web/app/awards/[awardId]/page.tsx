'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { Award, CostComponent, CostComponentCode, CostSheet, Quote } from '@jobwork/contracts';
import {
  Button,
  Callout,
  Card,
  CommandButton,
  CopyableId,
  DataTable,
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
  type Column,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * An award and everything that hangs off it (F-07.3–F-07.5): the exact bid lines it
 * cites, its approval, the cost sheet built from it, and the quotations drafted from
 * the approved cost sheet. The cost sheet is the one place margin is visible, and the
 * role check on the API keeps it that way (BR-AUTH-03).
 */

const AWARD_TONE: Record<Award['status'], Tone> = {
  proposed: 'attention',
  approved: 'positive',
  rejected: 'blocked',
  withdrawn: 'neutral',
};

const SHEET_TONE: Record<CostSheet['status'], Tone> = {
  draft: 'neutral',
  pending_approval: 'attention',
  approved: 'positive',
  returned: 'blocked',
  superseded: 'neutral',
};

const COMPONENT_CODES: Array<{ value: CostComponentCode; label: string }> = [
  { value: 'freight_inbound', label: 'Freight — supplier to JobWork' },
  { value: 'freight_outbound', label: 'Freight — JobWork to customer' },
  { value: 'inspection', label: 'Inspection' },
  { value: 'quality_reserve', label: 'Quality / rework reserve' },
  { value: 'packaging', label: 'Packaging' },
  { value: 'logistics_handling', label: 'Handling' },
  { value: 'finance', label: 'Finance / credit cost' },
  { value: 'risk_contingency', label: 'Risk contingency' },
  { value: 'engineering', label: 'Engineering effort' },
  { value: 'other', label: 'Other' },
];

export default function AwardPage(): React.JSX.Element {
  const awardId = useParams<{ awardId: string }>().awardId;
  const router = useRouter();
  const [award, setAward] = useState<Award | null>(null);
  const [sheet, setSheet] = useState<CostSheet | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [components, setComponents] = useState<CostComponent[]>([]);
  const [marginPct, setMarginPct] = useState('15');
  const [note, setNote] = useState('');
  const [option, setOption] = useState<'standard' | 'fast' | 'premium'>('standard');
  const [quoteForm, setQuoteForm] = useState({
    deliveryLeadDays: '14',
    paymentTerms: '50% advance, balance before dispatch',
    validityUntil: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
    freightMinor: '0',
    taxRateBp: '1800',
    assumptions: '',
    exclusions: '',
    scopeNote: '',
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const a = await api<Award>(`/awards/${awardId}`);
      setAward(a);
      const cs = await api<{ costSheet: CostSheet | null }>(`/awards/${awardId}/cost-sheet`);
      setSheet(cs.costSheet);
      const current = cs.costSheet?.versions.find((v) => v.versionNo === cs.costSheet?.currentVersionNo);
      if (current) {
        setComponents(current.components);
        setMarginPct((current.marginBp / 100).toFixed(1));
        setNote(current.note);
      }
      const q = await api<{ quotes: Quote[] }>(`/quotes?enquiryId=${a.enquiryId}`);
      setQuotes(q.quotes);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [awardId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!award) {
    return (
      <Page title="Award" breadcrumb={<Link href="/rfqs">← Control room</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the award" /></Card>}
      </Page>
    );
  }

  const money = (minor: number): string => formatMoney({ amountMinor: minor, currency: award.currency });
  const current = sheet?.versions.find((v) => v.versionNo === sheet.currentVersionNo) ?? null;
  const approvedVersion = sheet?.versions.find((v) => v.status === 'approved') ?? null;
  const editable = !current || current.status === 'draft' || current.status === 'returned' || current.status === 'approved';
  const marginBp = Math.round(Number(marginPct) * 100);

  const lineColumns: Array<Column<Award['lines'][number]>> = [
    { key: 'line', header: 'Line', render: (l) => l.lineNo, numeric: true },
    { key: 'supplier', header: 'Supplier', render: (l) => l.supplierDisplayName },
    { key: 'qty', header: 'Awarded', numeric: true, render: (l) => `${l.quantity} ${l.unit} (priced at ${l.bidQuantity})` },
    { key: 'unit', header: 'Unit price', numeric: true, render: (l) => money(l.unitPriceMinor) },
    { key: 'setup', header: 'Setup', numeric: true, render: (l) => money(l.setupAmountMinor) },
    { key: 'total', header: 'Line total', numeric: true, render: (l) => money(l.lineTotalMinor) },
    { key: 'version', header: 'Bid version', render: (l) => <CopyableId label="Bid version" value={l.bidVersionId} /> },
  ];

  return (
    <Page
      title={`Award on ${award.rfqReference ?? 'round'}`}
      breadcrumb={<Link href={`/rfqs/${award.rfqId}`}>← Sourcing round</Link>}
      width="wide"
      actions={
        <Inline gap={2}>
          <StatusChip tone={AWARD_TONE[award.status]}>{award.status}</StatusChip>
          {award.singleSource ? <StatusChip tone="attention">single source</StatusChip> : null}
        </Inline>
      }
    >
      <Stack gap={4}>
        {error ? <Callout tone="blocked" assertive title={error.problem.title}>{error.problem.detail ?? ''} ({error.problem.code})</Callout> : null}

        {award.status === 'proposed' ? (
          <Callout tone="attention" title="Waiting for approval">
            Proposed {award.proposedAt.slice(0, 10)}. Somebody other than the proposer decides it in <Link href="/approvals">Approvals</Link>.
          </Callout>
        ) : null}

        <Card title="What was awarded" description={award.rationale} flush>
          <DataTable caption="Award lines" columns={lineColumns} rows={award.lines} rowKey={(l) => l.awardLineId} stackTitle={(l) => `Line ${l.lineNo} — ${l.supplierDisplayName}`} />
          <div style={{ padding: 'var(--space-4) var(--space-5)' }}>
            <DescriptionList
              columns={2}
              items={[
                { label: 'Buy total', value: money(award.buyTotalMinor), numeric: true },
                { label: 'Approval', value: award.approvalStatus ?? '—' },
                ...(award.fallbackNote ? [{ label: 'Fallback', value: award.fallbackNote }] : []),
                { label: 'Evaluation', value: award.evaluationId ? <Link href={`/evaluations/${award.evaluationId}`}>open comparison</Link> : 'none cited' },
              ]}
            />
          </div>
        </Card>

        {award.status === 'approved' ? (
          <Card
            title="Cost sheet"
            description="Landed cost from the award lines, JobWork's own components, one margin on sell. Nothing here reaches the customer."
            actions={sheet ? <StatusChip tone={SHEET_TONE[sheet.status]}>{sheet.status.replace(/_/g, ' ')}</StatusChip> : undefined}
          >
            <Stack gap={4}>
              {current ? (
                <DescriptionList
                  columns={2}
                  items={[
                    { label: `Version ${current.versionNo}`, value: current.status.replace(/_/g, ' ') },
                    { label: 'Buy total', value: money(current.buyTotalMinor), numeric: true },
                    { label: 'Landed total', value: money(current.landedTotalMinor), numeric: true },
                    { label: 'Margin', value: `${(current.marginBp / 100).toFixed(1)} % · ${money(current.marginMinor)}`, numeric: true },
                    { label: 'Sell total (ex tax)', value: money(current.sellTotalMinor), numeric: true },
                    { label: 'Policy floor', value: `${(sheet!.minMarginBp / 100).toFixed(1)} %`, numeric: true },
                  ]}
                />
              ) : null}
              {current && current.marginBp < sheet!.minMarginBp ? (
                <Callout tone={current.marginBp < 0 ? 'blocked' : 'attention'} title={current.marginBp < 0 ? 'Negative margin' : 'Below the policy floor'}>
                  Approval of this version is an exception that finance signs. A quotation cannot be drafted from it until then.
                </Callout>
              ) : null}

              {editable ? (
                <Stack gap={3}>
                  <h3 style={{ font: 'var(--text-body-strong)' }}>{current && current.status === 'approved' ? 'New version' : 'Components'}</h3>
                  {components.map((component, index) => (
                    <Inline key={index} gap={2}>
                      <Select
                        label="Component"
                        value={component.code}
                        options={COMPONENT_CODES}
                        onChange={(e) => setComponents((cur) => cur.map((c, i) => (i === index ? { ...c, code: e.target.value as CostComponentCode, label: COMPONENT_CODES.find((o) => o.value === e.target.value)?.label ?? c.label } : c)))}
                      />
                      <TextInput
                        label="Amount (₹)"
                        type="number"
                        numeric
                        value={(component.amountMinor / 100).toString()}
                        onChange={(e) => setComponents((cur) => cur.map((c, i) => (i === index ? { ...c, amountMinor: Math.round(Number(e.target.value || 0) * 100) } : c)))}
                      />
                      <TextInput label="Basis" value={component.basis} onChange={(e) => setComponents((cur) => cur.map((c, i) => (i === index ? { ...c, basis: e.target.value } : c)))} />
                      <Button variant="ghost" size="sm" onClick={() => setComponents((cur) => cur.filter((_, i) => i !== index))}>Remove</Button>
                    </Inline>
                  ))}
                  <div>
                    <Button variant="secondary" size="sm" onClick={() => setComponents((cur) => [...cur, { code: 'freight_outbound', label: 'Freight — JobWork to customer', amountMinor: 0, basis: '' }])}>
                      Add a component
                    </Button>
                  </div>
                  <TextInput label="Target margin on sell (%)" type="number" numeric value={marginPct} onChange={(e) => setMarginPct(e.target.value)} hint={`Policy floor ${sheet ? (sheet.minMarginBp / 100).toFixed(1) : '10.0'} %. Below it, finance must approve; negative blocks the quote until approved.`} />
                  <TextArea label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
                  <Inline gap={2}>
                    <CommandButton
                      receiptLabel="Saved"
                      onCommand={async () => {
                        await api(`/awards/${awardId}/cost-sheet`, { method: 'POST', body: { components, targetMarginBp: marginBp, note }, idempotencyKey: crypto.randomUUID() });
                        await load();
                      }}
                    >
                      {current && current.status === 'approved' ? 'Save as new version' : 'Save cost sheet'}
                    </CommandButton>
                    {current && (current.status === 'draft' || current.status === 'returned') ? (
                      <CommandButton
                        variant="secondary"
                        receiptLabel="Requested"
                        onCommand={async () => {
                          await api(`/cost-sheets/${sheet!.costSheetId}/request-approval`, { method: 'POST', body: {}, idempotencyKey: `cs-approve-${sheet!.costSheetId}-${current.versionNo}` });
                          await load();
                        }}
                      >
                        Request approval
                      </CommandButton>
                    ) : null}
                  </Inline>
                </Stack>
              ) : current ? (
                <p style={{ color: 'var(--color-text-muted)' }}>Version {current.versionNo} is {current.status.replace(/_/g, ' ')}; it is frozen until a decision in <Link href="/approvals">Approvals</Link>.</p>
              ) : null}
            </Stack>
          </Card>
        ) : null}

        {approvedVersion ? (
          <Card title="Quotations" description="Drafted from the approved cost sheet's sell lines. Each option is its own quotation in one offer set.">
            <Stack gap={3}>
              {quotes.length > 0 ? (
                <ul style={{ listStyle: 'none', display: 'grid', gap: 'var(--space-2)' }}>
                  {quotes.map((q) => (
                    <li key={q.quoteId}>
                      <Link href={`/quotes/${q.quoteId}`}>{q.reference ?? `Draft ${q.optionLabel}`}</Link> — {q.optionLabel} · {q.status.replace(/_/g, ' ')} · v{q.currentVersionNo}
                    </li>
                  ))}
                </ul>
              ) : null}
              <h3 style={{ font: 'var(--text-body-strong)' }}>Draft a quotation</h3>
              <Select label="Option" value={option} options={[{ value: 'standard', label: 'Standard' }, { value: 'fast', label: 'Fast' }, { value: 'premium', label: 'Premium' }]} onChange={(e) => setOption(e.target.value as typeof option)} />
              <Inline gap={2}>
                <TextInput label="Delivery (days)" type="number" numeric value={quoteForm.deliveryLeadDays} onChange={(e) => setQuoteForm({ ...quoteForm, deliveryLeadDays: e.target.value })} />
                <TextInput label="Valid until" type="date" value={quoteForm.validityUntil} onChange={(e) => setQuoteForm({ ...quoteForm, validityUntil: e.target.value })} />
                <TextInput label="GST (bp)" type="number" numeric value={quoteForm.taxRateBp} onChange={(e) => setQuoteForm({ ...quoteForm, taxRateBp: e.target.value })} />
                <TextInput label="Freight (₹)" type="number" numeric value={(Number(quoteForm.freightMinor) / 100).toString()} onChange={(e) => setQuoteForm({ ...quoteForm, freightMinor: String(Math.round(Number(e.target.value || 0) * 100)) })} />
              </Inline>
              <TextInput label="Payment terms" value={quoteForm.paymentTerms} onChange={(e) => setQuoteForm({ ...quoteForm, paymentTerms: e.target.value })} />
              <TextArea label="Scope" value={quoteForm.scopeNote} onChange={(e) => setQuoteForm({ ...quoteForm, scopeNote: e.target.value })} />
              <TextArea label="Assumptions" value={quoteForm.assumptions} onChange={(e) => setQuoteForm({ ...quoteForm, assumptions: e.target.value })} />
              <TextArea label="Exclusions" value={quoteForm.exclusions} onChange={(e) => setQuoteForm({ ...quoteForm, exclusions: e.target.value })} />
              <CommandButton
                receiptLabel="Drafted"
                onCommand={async () => {
                  const quote = await api<Quote>('/quotes', {
                    method: 'POST',
                    body: {
                      costSheetVersionId: approvedVersion.costSheetVersionId,
                      optionLabel: option,
                      content: {
                        deliveryLeadDays: Number(quoteForm.deliveryLeadDays),
                        paymentTerms: quoteForm.paymentTerms,
                        validityUntil: quoteForm.validityUntil,
                        taxRateBp: Number(quoteForm.taxRateBp),
                        freightMinor: Number(quoteForm.freightMinor),
                        assumptions: quoteForm.assumptions,
                        exclusions: quoteForm.exclusions,
                        scopeNote: quoteForm.scopeNote,
                      },
                    },
                    idempotencyKey: crypto.randomUUID(),
                  });
                  router.push(`/quotes/${quote.quoteId}`);
                }}
              >
                Draft {option} quotation
              </CommandButton>
            </Stack>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}
