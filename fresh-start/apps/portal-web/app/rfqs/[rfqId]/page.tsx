'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { BidVersion, SupplierRfq } from '@jobwork/contracts';
import {
  Button,
  Callout,
  Card,
  CommandButton,
  DataTable,
  DescriptionList,
  ErrorState,
  Inline,
  LiveRegion,
  LoadingState,
  MoneyInput,
  Page,
  Select,
  Stack,
  StatusChip,
  TextArea,
  TextInput,
  formatMoney,
  type Column,
  type MoneyValue,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';
import { ThreadPanel } from '../../thread-panel';

/**
 * The supplier's RFQ workspace and bid builder (F-06.4, F-06.5, UC-12/13).
 *
 * Three things this screen is careful about:
 *
 *  1. **It says what the deadline means.** A countdown, and the round's own late-bid
 *     policy in words, because "we might accept it" and "we will not" are different
 *     decisions for a shop deciding whether to work tonight.
 *  2. **A revision is visibly a new version.** The previous one stays on the page with
 *     its total, so a supplier can see exactly what they changed — the same diff JobWork
 *     evaluates against.
 *  3. **Nothing about the customer appears**, because the payload has no such field.
 */

interface LineDraft {
  rfqItemId: string;
  lineNo: number;
  partName: string;
  quantity: number;
  unit: string;
  unitPrice: MoneyValue;
  setupAmount: MoneyValue;
}

function countdown(deadlineAt: string | null): string {
  if (!deadlineAt) return 'No deadline stated';
  const ms = new Date(deadlineAt).getTime() - Date.now();
  if (ms <= 0) return 'The deadline has passed';
  const hours = Math.floor(ms / 3_600_000);
  return hours < 48 ? `${hours} hours left` : `${Math.floor(hours / 24)} days left`;
}

export default function SupplierRfqPage(): React.JSX.Element {
  const rfqId = useParams<{ rfqId: string }>().rfqId;
  const [rfq, setRfq] = useState<SupplierRfq | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [leadTimeDays, setLeadTimeDays] = useState('21');
  const [validityUntil, setValidityUntil] = useState(
    new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
  );
  const [feasibility, setFeasibility] = useState('feasible');
  const [assumptions, setAssumptions] = useState('');
  const [exclusions, setExclusions] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [freight, setFreight] = useState<MoneyValue>({ amountMinor: 0, currency: 'INR' });
  const [nre, setNre] = useState<MoneyValue>({ amountMinor: 0, currency: 'INR' });
  const [revisionReason, setRevisionReason] = useState('');
  const [declineCode, setDeclineCode] = useState('capacity');
  const [declineReason, setDeclineReason] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await api<SupplierRfq>(`/supplier/rfqs/${rfqId}`);
      setRfq(next);
      // One priced row per quantity the round asks for: the shape the API validates.
      setLines(
        next.items.flatMap((item) =>
          item.quantityBreakpoints.map((breakpoint) => ({
            rfqItemId: item.rfqItemId,
            lineNo: item.lineNo,
            partName: item.partName,
            quantity: breakpoint.quantity,
            unit: breakpoint.unit,
            unitPrice: { amountMinor: 0, currency: next.currency },
            setupAmount: { amountMinor: 0, currency: next.currency },
          })),
        ),
      );
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [rfqId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !rfq) {
    return (
      <Page title="Request for quotation" breadcrumb={<Link href="/rfqs">← RFQs</Link>}>
        <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
      </Page>
    );
  }

  if (!rfq) {
    return (
      <Page title="Request for quotation" breadcrumb={<Link href="/rfqs">← RFQs</Link>}>
        <Card>
          <LoadingState label="Loading the request" />
        </Card>
      </Page>
    );
  }

  const live = rfq.bid?.versions.find((version) => version.status === 'submitted') ?? null;
  const previous = rfq.bid?.versions.filter((version) => version.status !== 'submitted') ?? [];
  const closed = rfq.status !== 'open' && rfq.status !== 'responses_received';
  const answered = rfq.invitationStatus === 'declined' || rfq.invitationStatus === 'no_response';

  const linesTotal = lines.reduce(
    (total, line) => total + line.unitPrice.amountMinor * line.quantity + line.setupAmount.amountMinor,
    0,
  );
  const total = linesTotal + freight.amountMinor + nre.amountMinor;

  async function submit(): Promise<void> {
    setError(null);
    try {
      const result = await api<{ versionNo: number; late: boolean }>(
        `/supplier/rfqs/${rfqId}/bid/submit`,
        {
          method: 'POST',
          body: {
            currency: rfq!.currency,
            taxTreatment: 'gst_extra',
            lines: lines.map((line) => ({
              rfqItemId: line.rfqItemId,
              lineNo: line.lineNo,
              quantity: line.quantity,
              unit: line.unit,
              unitPriceMinor: line.unitPrice.amountMinor,
              setupAmountMinor: line.setupAmount.amountMinor,
              note: '',
            })),
            nreAmountMinor: nre.amountMinor,
            freightAmountMinor: freight.amountMinor,
            leadTimeDays: Number(leadTimeDays),
            validityUntil,
            feasibility,
            assumptions,
            exclusions,
            paymentTerms,
            note: '',
            ...(live ? { revisionReason } : {}),
          },
          idempotencyKey: crypto.randomUUID(),
        },
      );
      setNotice(
        result.late
          ? `Version ${result.versionNo} received after the deadline and flagged as late.`
          : `Version ${result.versionNo} submitted. It cannot be edited — a change means a new version.`,
      );
      setRevisionReason('');
      await load();
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      throw err;
    }
  }

  const documentColumns: Array<Column<SupplierRfq['documents'][number]>> = [
    { key: 'file', header: 'File', render: (row) => row.filename },
    { key: 'role', header: 'Role', render: (row) => row.role.replace(/_/g, ' ') },
    {
      key: 'sha',
      header: 'Digest',
      render: (row) => <span className="mono">{row.sha256.slice(0, 12)}…</span>,
    },
    {
      key: 'get',
      header: '',
      render: (row) => (
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            const grant = await api<{ url: string }>(
              `/documents/versions/${row.documentVersionId}/download`,
            );
            window.location.assign(grant.url);
          }}
        >
          Download
        </Button>
      ),
    },
  ];

  return (
    <Page
      title={rfq.reference ?? 'Request for quotation'}
      breadcrumb={<Link href="/rfqs">← RFQs</Link>}
      description={rfq.instructions || 'No special instructions for this round.'}
      width="wide"
      actions={
        <Inline gap={2}>
          <StatusChip tone={closed ? 'neutral' : 'progress'}>
            {rfq.status === 'superseded' ? 'Closed: requirements updated' : countdown(rfq.deadlineAt)}
          </StatusChip>
          <StatusChip tone={live ? 'positive' : 'attention'}>
            {live ? `your bid v${live.versionNo}` : 'not quoted yet'}
          </StatusChip>
        </Inline>
      }
    >
      <Stack gap={4}>
        {notice ? <LiveRegion message={notice} /> : null}
        {rfq.status === 'superseded' ? (
          <Callout tone="neutral" title="This round closed because the requirement changed">
            Your bid is kept exactly as you submitted it, but it priced the earlier requirement and will not be awarded. If your
            capabilities still match, JobWork will invite you to the new round.
          </Callout>
        ) : null}
        {error ? (
          <Callout tone="blocked" assertive title={error.problem.title}>
            {error.problem.detail ?? 'That did not go through.'} ({error.problem.code})
          </Callout>
        ) : null}

        <Card title="What is being asked for">
          <DescriptionList
            columns={2}
            items={[
              { label: 'Bids close', value: rfq.deadlineAt?.slice(0, 16).replace('T', ' ') ?? '—' },
              {
                label: 'After the deadline',
                value:
                  rfq.lateBidPolicy === 'reject'
                    ? 'Late bids are refused — submit before the date'
                    : 'Late bids are accepted but flagged as late',
              },
              { label: 'Quote in', value: rfq.currency },
              { label: 'Lines', value: String(rfq.items.length), numeric: true },
            ]}
          />
        </Card>

        <Card title="Drawings and specifications" description="Exactly what this round is quoted against." flush>
          <DataTable
            caption="Released documents"
            columns={documentColumns}
            rows={rfq.documents}
            rowKey={(row) => row.documentVersionId}
            stackTitle={(row) => row.filename}
            empty={{ title: 'No documents', detail: 'This round was released without attachments.' }}
          />
        </Card>

        {rfq.invitationStatus === 'invited' && !closed ? (
          <Card
            title="Can you quote this?"
            description="Telling us early is worth as much as a price — it lets us go elsewhere without waiting."
          >
            <Inline gap={2}>
              <CommandButton
                receiptLabel="Noted"
                onCommand={async () => {
                  await api(`/supplier/rfqs/${rfqId}/acknowledge`, {
                    method: 'POST',
                    body: { note: '' },
                    idempotencyKey: crypto.randomUUID(),
                  });
                  setNotice('Thanks — we have told sourcing you are looking at it.');
                  await load();
                }}
              >
                Yes, we are looking
              </CommandButton>
            </Inline>
          </Card>
        ) : null}

        {!closed && !answered ? (
          <Card title="Your bid" description="Priced per line, at the quantities asked for.">
            {lines.map((line, index) => (
              <div
                key={`${line.rfqItemId}-${line.quantity}`}
                style={{
                  borderBottom: 'var(--hairline) solid var(--color-border)',
                  paddingBottom: 'var(--space-3)',
                  marginBottom: 'var(--space-3)',
                }}
              >
                <p style={{ font: 'var(--text-body-strong)' }}>
                  Line {line.lineNo} · {line.partName} · {line.quantity} {line.unit}
                </p>
                <Inline gap={3}>
                  <MoneyInput
                    label="Price each"
                    value={line.unitPrice}
                    onChange={(value) =>
                      setLines(
                        lines.map((row, i) =>
                          i === index ? { ...row, unitPrice: value ?? row.unitPrice } : row,
                        ),
                      )
                    }
                  />
                  <MoneyInput
                    label="One-off setup"
                    value={line.setupAmount}
                    onChange={(value) =>
                      setLines(
                        lines.map((row, i) =>
                          i === index ? { ...row, setupAmount: value ?? row.setupAmount } : row,
                        ),
                      )
                    }
                  />
                </Inline>
              </div>
            ))}

            <Inline gap={3}>
              <MoneyInput label="Tooling / NRE" value={nre} onChange={(v) => setNre(v ?? nre)} />
              <MoneyInput label="Freight" value={freight} onChange={(v) => setFreight(v ?? freight)} />
            </Inline>
            <TextInput
              label="Lead time (days)"
              required
              value={leadTimeDays}
              onChange={(event) => setLeadTimeDays(event.target.value)}
            />
            <TextInput
              label="Price valid until"
              type="date"
              required
              hint="After this date the price is no longer binding on you."
              value={validityUntil}
              onChange={(event) => setValidityUntil(event.target.value)}
            />
            <Select
              label="Feasibility"
              value={feasibility}
              options={[
                { value: 'feasible', label: 'We can make it as specified' },
                { value: 'feasible_with_deviation', label: 'We can, with a deviation we describe' },
                { value: 'not_feasible', label: 'Not feasible for us' },
              ]}
              onChange={(event) => setFeasibility(event.target.value)}
            />
            <TextArea
              label="Assumptions"
              hint="What your price assumes. These travel with the bid."
              value={assumptions}
              onChange={(event) => setAssumptions(event.target.value)}
            />
            <TextArea
              label="Exclusions"
              hint="What is not in the price."
              value={exclusions}
              onChange={(event) => setExclusions(event.target.value)}
            />
            <TextInput
              label="Payment terms"
              value={paymentTerms}
              onChange={(event) => setPaymentTerms(event.target.value)}
            />

            {live ? (
              <TextInput
                label="What changed, and why?"
                required
                hint="Your previous version stays on record; this creates a new one."
                value={revisionReason}
                onChange={(event) => setRevisionReason(event.target.value)}
              />
            ) : null}

            <Callout tone="neutral" title={`Total ${formatMoney({ amountMinor: total, currency: rfq.currency })}`}>
              Lines {formatMoney({ amountMinor: linesTotal, currency: rfq.currency })} + tooling{' '}
              {formatMoney({ amountMinor: nre.amountMinor, currency: rfq.currency })} + freight{' '}
              {formatMoney({ amountMinor: freight.amountMinor, currency: rfq.currency })}. Taxes extra.
            </Callout>

            <Inline gap={2}>
              <CommandButton
                receiptLabel="Submitted"
                disabled={Boolean(live) && revisionReason.trim().length < 3}
                onCommand={submit}
              >
                {live ? 'Submit a revised bid' : 'Submit bid'}
              </CommandButton>
              <CommandButton
                variant="secondary"
                receiptLabel="Saved"
                onCommand={async () => {
                  await api(`/supplier/rfqs/${rfqId}/bid/draft`, {
                    method: 'POST',
                    body: {
                      draft: {
                        leadTimeDays: Number(leadTimeDays),
                        validityUntil,
                        assumptions,
                        exclusions,
                        paymentTerms,
                      },
                    },
                    idempotencyKey: crypto.randomUUID(),
                  });
                  setNotice('Draft saved. Nothing has been sent to JobWork yet.');
                }}
              >
                Save draft
              </CommandButton>
            </Inline>
          </Card>
        ) : null}

        {rfq.bid && rfq.bid.versions.length > 0 ? (
          <Card
            title="What you have submitted"
            description="Every version stays exactly as it was sent. A change is a new version, never an edit."
          >
            <Stack gap={3}>
              {rfq.bid.versions.map((version: BidVersion) => (
                <div
                  key={version.bidVersionId}
                  style={{
                    borderLeft: `var(--rule-emphasis) solid var(--status-${version.status === 'submitted' ? 'positive' : 'neutral'}-fg)`,
                    paddingLeft: 'var(--space-3)',
                  }}
                >
                  <Inline gap={2}>
                    <StatusChip tone={version.status === 'submitted' ? 'positive' : 'neutral'}>
                      v{version.versionNo} · {version.status}
                    </StatusChip>
                    {version.late ? <StatusChip tone="attention">late</StatusChip> : null}
                  </Inline>
                  <p>
                    {formatMoney({
                      amountMinor: version.totalAmountMinor,
                      currency: version.currency,
                    })}{' '}
                    · {version.leadTimeDays} days · valid to {version.validityUntil}
                  </p>
                  {version.revisionReason ? (
                    <p style={{ color: 'var(--color-text-muted)' }}>
                      Changed because: {version.revisionReason}
                    </p>
                  ) : null}
                  <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                    sent {version.receivedAt.slice(0, 16).replace('T', ' ')} · fingerprint{' '}
                    <span className="mono">{version.contentHash.slice(0, 12)}…</span>
                  </p>
                </div>
              ))}
            </Stack>
            {previous.length > 0 && live ? (
              <p style={{ marginTop: 'var(--space-3)', color: 'var(--color-text-muted)' }}>
                Your live bid is v{live.versionNo}; {previous.length} earlier version
                {previous.length === 1 ? '' : 's'} remain readable above.
              </p>
            ) : null}
          </Card>
        ) : null}

        {!closed && !answered && !live ? (
          <Card
            title="Not for you?"
            description="A quick decline is more useful to everyone than silence, and it does not count against you."
          >
            <Select
              label="Why"
              value={declineCode}
              options={[
                { value: 'capacity', label: 'No capacity in the window' },
                { value: 'capability', label: 'Outside what we do' },
                { value: 'lead_time', label: 'Lead time is too short' },
                { value: 'material', label: 'Material we do not handle' },
                { value: 'commercial', label: 'Commercially not for us' },
                { value: 'other', label: 'Something else' },
              ]}
              onChange={(event) => setDeclineCode(event.target.value)}
            />
            <TextInput
              label="Anything you want sourcing to know"
              required
              value={declineReason}
              onChange={(event) => setDeclineReason(event.target.value)}
            />
            <CommandButton
              variant="secondary"
              receiptLabel="Declined"
              disabled={declineReason.trim().length < 3}
              onCommand={async () => {
                await api(`/supplier/rfqs/${rfqId}/decline`, {
                  method: 'POST',
                  body: { declineCode, reason: declineReason.trim() },
                  idempotencyKey: crypto.randomUUID(),
                });
                setNotice('Thanks for telling us — sourcing can move on straight away.');
                await load();
              }}
            >
              Decline this RFQ
            </CommandButton>
          </Card>
        ) : null}
        <ThreadPanel
          contextType="rfq"
          contextId={rfqId}
          title="Questions to JobWork"
          description="Your questions stay between you and JobWork. Answers JobWork sends to every invited supplier also appear here, without names."
        />
      </Stack>
    </Page>
  );
}
