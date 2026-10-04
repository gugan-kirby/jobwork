'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Award, BidVersion, Evaluation, Rfq } from '@jobwork/contracts';
import {
  Callout,
  Card,
  CommandButton,
  CopyableId,
  DataTable,
  DescriptionList,
  ErrorState,
  Inline,
  LiveRegion,
  LoadingState,
  Page,
  ReasonField,
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
 * One sourcing round (F-06.6). The comparison table is the point: same lines, same
 * quantities, same currency, so the numbers beside each other actually mean the same
 * thing — which is exactly what the bid validation at submit exists to guarantee.
 *
 * Single source is called out rather than left to be noticed. A round with one bid can
 * still be awarded; it just must not be awarded by accident.
 */

interface Detail {
  rfq: Rfq;
  singleSourceRisk: boolean;
  bids: Array<{
    rfqSupplierId: string;
    displayName: string;
    invitationStatus: string;
    version: BidVersion | null;
    history: BidVersion[];
  }>;
}

const INVITATION_TONE: Record<string, Tone> = {
  prepared: 'neutral',
  invited: 'progress',
  acknowledged: 'progress',
  clarifying: 'attention',
  responded: 'positive',
  declined: 'blocked',
  no_response: 'blocked',
  revoked: 'neutral',
};

export default function RfqDetailPage(): React.JSX.Element {
  const rfqId = useParams<{ rfqId: string }>().rfqId;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');
  // Evaluation and award (IN-07): the comparison this round's award will cite.
  const [commercial, setCommercial] = useState<{ evaluations: Array<{ evaluationId: string; scenarioHash: string; createdAt: string; rowCount: number }>; awards: Award[] } | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [scenario, setScenario] = useState({ inspectionPackagingMinor: '0', financingRiskBp: '0', nreAllocation: 'value', freightPolicy: 'as_quoted', freightEstimateMinor: '0' });
  const [split, setSplit] = useState<Record<string, Record<string, string>>>({});
  const [rationale, setRationale] = useState('');
  const [fallback, setFallback] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await api<Detail>(`/rfqs/${rfqId}`);
      setDetail(d);
      if (['evaluation', 'awarded'].includes(d.rfq.status)) {
        const c = await api<{ evaluations: Array<{ evaluationId: string; scenarioHash: string; createdAt: string; rowCount: number }>; awards: Award[] }>(`/rfqs/${rfqId}/evaluations`).catch(() => null);
        setCommercial(c);
        if (c?.evaluations[0]) setEvaluation(await api<Evaluation>(`/evaluations/${c.evaluations[0].evaluationId}`).catch(() => null));
      }
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [rfqId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !detail) {
    return (
      <Page title="Sourcing round" breadcrumb={<Link href="/rfqs">← Control room</Link>}>
        <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
      </Page>
    );
  }

  if (!detail) {
    return (
      <Page title="Sourcing round" breadcrumb={<Link href="/rfqs">← Control room</Link>}>
        <Card>
          <LoadingState label="Loading the round" />
        </Card>
      </Page>
    );
  }

  const { rfq } = detail;
  const responded = rfq.invitations.filter((invitation) => invitation.status === 'responded');
  const waiting = rfq.invitations.filter((invitation) =>
    ['invited', 'acknowledged', 'clarifying'].includes(invitation.status),
  );

  const invitationColumns: Array<Column<Rfq['invitations'][number]>> = [
    { key: 'name', header: 'Supplier', render: (row) => row.displayName },
    {
      key: 'status',
      header: 'State',
      render: (row) => (
        <StatusChip tone={INVITATION_TONE[row.status] ?? 'neutral'}>
          {row.status.replace(/_/g, ' ')}
        </StatusChip>
      ),
    },
    {
      key: 'eligibility',
      header: 'At release',
      render: (row) =>
        row.eligibleAtRelease ? (
          'passed the filter'
        ) : (
          <span>
            {row.exclusionsAtRelease.join(', ').replace(/_/g, ' ')}
            {row.overrideReason ? ` · override: ${row.overrideReason}` : ''}
          </span>
        ),
    },
    { key: 'versions', header: 'Bid versions', numeric: true, render: (row) => row.bidVersionCount },
    {
      key: 'decline',
      header: 'If declined',
      render: (row) => (row.declineCode ? `${row.declineCode}: ${row.declineReason ?? ''}` : '—'),
    },
    {
      key: 'action',
      header: 'Action',
      render: (row) =>
        ['revoked', 'declined', 'no_response'].includes(row.status) ? (
          <span style={{ color: 'var(--color-text-muted)' }}>—</span>
        ) : (
          <CommandButton
            size="sm"
            variant="danger"
            receiptLabel="Revoked"
            onCommand={async () => {
              if (reason.trim().length < 3) {
                throw new Error('Say why — the revocation is audited and pulls their access.');
              }
              await api(`/rfqs/${rfqId}/invitations/${row.rfqSupplierId}/revoke`, {
                method: 'POST',
                body: { reason: reason.trim() },
                idempotencyKey: crypto.randomUUID(),
              });
              setNotice(`${row.displayName} removed from the round; their document access is gone.`);
              setReason('');
              await load();
            }}
          >
            Revoke
          </CommandButton>
        ),
    },
  ];

  const bidColumns: Array<Column<Detail['bids'][number]>> = [
    { key: 'name', header: 'Supplier', render: (row) => row.displayName },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      render: (row) =>
        row.version
          ? formatMoney({ amountMinor: row.version.totalAmountMinor, currency: row.version.currency })
          : '—',
    },
    {
      key: 'lead',
      header: 'Lead time',
      numeric: true,
      render: (row) => (row.version ? `${row.version.leadTimeDays} days` : '—'),
    },
    {
      key: 'validity',
      header: 'Valid to',
      render: (row) => row.version?.validityUntil ?? '—',
    },
    {
      key: 'feasibility',
      header: 'Feasibility',
      render: (row) => row.version?.feasibility.replace(/_/g, ' ') ?? '—',
    },
    {
      key: 'version',
      header: 'Version',
      render: (row) =>
        row.version ? (
          <Inline gap={2}>
            <span>v{row.version.versionNo}</span>
            {row.version.late ? <StatusChip tone="attention">late</StatusChip> : null}
            {row.history.length > 1 ? (
              <span style={{ color: 'var(--color-text-muted)' }}>
                {row.history.length} versions
              </span>
            ) : null}
          </Inline>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <Page
      title={rfq.reference ?? `Round ${rfq.roundNo}`}
      breadcrumb={<Link href="/rfqs">← Control room</Link>}
      description={rfq.instructions || 'No instructions were sent with this round.'}
      width="wide"
      actions={
        <Inline gap={2}>
          <StatusChip tone={rfq.status === 'open' ? 'progress' : 'neutral'}>
            {rfq.status.replace(/_/g, ' ')}
          </StatusChip>
          {detail.singleSourceRisk ? <StatusChip tone="attention">single source</StatusChip> : null}
        </Inline>
      }
    >
      <Stack gap={4}>
        {notice ? <LiveRegion message={notice} /> : null}
        {error ? (
          <Callout tone="blocked" assertive title={error.problem.title}>
            {error.problem.detail ?? 'That command did not go through.'} ({error.problem.code})
          </Callout>
        ) : null}

        {detail.singleSourceRisk ? (
          <Callout tone="attention" title="Only one supplier has bid">
            An award from this round is single-source. That is allowed, but it needs the approval
            the policy asks for — and it is worth asking the others why they went quiet.
          </Callout>
        ) : null}

        <Card title="Round">
          <DescriptionList
            columns={2}
            items={[
              { label: 'Deadline', value: rfq.deadlineAt?.slice(0, 16).replace('T', ' ') ?? '—' },
              { label: 'Late bids', value: rfq.lateBidPolicy.replace(/_/g, ' ') },
              { label: 'Currency', value: rfq.currency },
              { label: 'Lines', value: String(rfq.items.length), numeric: true },
              { label: 'Documents released', value: String(rfq.release.length), numeric: true },
              { label: 'Released', value: rfq.releasedAt?.slice(0, 10) ?? 'not yet' },
              { label: 'Invited', value: String(rfq.invitations.length), numeric: true },
              { label: 'Bids in', value: String(responded.length), numeric: true },
            ]}
          />
          <div style={{ marginTop: 'var(--space-3)' }}>
            <CopyableId label="Round id" value={rfq.rfqId} />
          </div>
          <p style={{ marginTop: 'var(--space-3)' }}>
            <Link href={`/intake/${rfq.enquiryId}`}>The enquiry this round quotes →</Link>
          </p>
        </Card>

        <Card title="Bids" description="Same lines, same quantities, same currency." flush>
          <DataTable
            caption="Live bid from each supplier"
            columns={bidColumns}
            rows={detail.bids.filter((bid) => bid.version !== null)}
            rowKey={(row) => row.rfqSupplierId}
            stackTitle={(row) => row.displayName}
            empty={{
              title: 'No bids yet',
              detail: 'Suppliers appear here as they submit. Nothing is visible to them but their own.',
            }}
          />
        </Card>

        <Card title="Invitations" flush>
          <DataTable
            caption="Invited suppliers and their state"
            columns={invitationColumns}
            rows={rfq.invitations}
            rowKey={(row) => row.rfqSupplierId}
            stackTitle={(row) => row.displayName}
          />
        </Card>

        {['evaluation', 'awarded'].includes(rfq.status) ? (
          <Card
            title="Evaluate and award"
            description="Normalize the live bids under one scenario, then cite exact bid versions in an award. The proposer never approves."
          >
            <Stack gap={4}>
              {commercial?.awards.length ? (
                <Stack gap={2}>
                  {commercial.awards.map((award) => (
                    <p key={award.awardId}>
                      <Link href={`/awards/${award.awardId}`}>Award {award.proposedAt.slice(0, 10)}</Link> — {award.status}
                      {award.singleSource ? ' · single source' : ''} · buy {formatMoney({ amountMinor: award.buyTotalMinor, currency: award.currency })}
                      {award.costSheetId ? ' · cost sheet started' : ''}
                    </p>
                  ))}
                </Stack>
              ) : null}

              {rfq.status === 'evaluation' ? (
                <>
                  <Inline gap={2}>
                    <Select label="NRE allocation" value={scenario.nreAllocation} options={[{ value: 'value', label: 'by value' }, { value: 'quantity', label: 'by quantity' }, { value: 'equal', label: 'equal' }, { value: 'direct', label: 'direct (unallocated)' }]} onChange={(e) => setScenario({ ...scenario, nreAllocation: e.target.value })} />
                    <Select label="Freight" value={scenario.freightPolicy} options={[{ value: 'as_quoted', label: 'as quoted' }, { value: 'estimate', label: 'one estimate for all' }]} onChange={(e) => setScenario({ ...scenario, freightPolicy: e.target.value })} />
                    {scenario.freightPolicy === 'estimate' ? <TextInput label="Freight estimate (₹)" type="number" numeric value={(Number(scenario.freightEstimateMinor) / 100).toString()} onChange={(e) => setScenario({ ...scenario, freightEstimateMinor: String(Math.round(Number(e.target.value || 0) * 100)) })} /> : null}
                    <TextInput label="Inspection/packaging (₹)" type="number" numeric value={(Number(scenario.inspectionPackagingMinor) / 100).toString()} onChange={(e) => setScenario({ ...scenario, inspectionPackagingMinor: String(Math.round(Number(e.target.value || 0) * 100)) })} />
                    <TextInput label="Financing/risk (bp)" type="number" numeric value={scenario.financingRiskBp} onChange={(e) => setScenario({ ...scenario, financingRiskBp: e.target.value })} />
                  </Inline>
                  <div>
                    <CommandButton
                      variant="secondary"
                      receiptLabel="Evaluated"
                      onCommand={async () => {
                        const ev = await api<Evaluation>(`/rfqs/${rfqId}/evaluations`, {
                          method: 'POST',
                          body: { scenario: { nreAllocation: scenario.nreAllocation, freightPolicy: scenario.freightPolicy, freightEstimateMinor: Number(scenario.freightEstimateMinor), inspectionPackagingMinor: Number(scenario.inspectionPackagingMinor), financingRiskBp: Number(scenario.financingRiskBp) } },
                          idempotencyKey: crypto.randomUUID(),
                        });
                        setEvaluation(ev);
                        await load();
                      }}
                    >
                      Run comparison
                    </CommandButton>
                  </div>
                </>
              ) : null}

              {evaluation ? (
                <Stack gap={3}>
                  <p>
                    Latest comparison <Link href={`/evaluations/${evaluation.evaluationId}`}>({evaluation.rows.length} bids, {evaluation.createdAt.slice(0, 16).replace('T', ' ')})</Link>
                  </p>
                  <DataTable
                    caption="Normalized comparison"
                    columns={[
                      { key: 'rank', header: '#', numeric: true, render: (r: Evaluation['rows'][number]) => r.rank },
                      { key: 'supplier', header: 'Supplier', render: (r: Evaluation['rows'][number]) => `${r.supplierDisplayName} v${r.versionNo}` },
                      { key: 'original', header: 'Original', numeric: true, render: (r: Evaluation['rows'][number]) => formatMoney({ amountMinor: r.originalTotalMinor, currency: evaluation.currency }) },
                      { key: 'normalized', header: 'Normalized landed', numeric: true, render: (r: Evaluation['rows'][number]) => <strong>{formatMoney({ amountMinor: r.normalizedLandedMinor, currency: evaluation.currency })}</strong> },
                      { key: 'lead', header: 'Lead', numeric: true, render: (r: Evaluation['rows'][number]) => `${r.leadTimeDays} d` },
                      { key: 'flags', header: 'Flags', render: (r: Evaluation['rows'][number]) => r.flags.map((f) => f.replace(/_/g, ' ')).join(', ') || '—' },
                    ]}
                    rows={evaluation.rows}
                    rowKey={(r) => r.bidVersionId}
                    stackTitle={(r) => `#${r.rank} ${r.supplierDisplayName}`}
                  />

                  {rfq.status === 'evaluation' ? (
                    <Stack gap={3}>
                      <h3 style={{ font: 'var(--text-body-strong)' }}>Propose an award</h3>
                      <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                        Per line, give each supplier the quantity it will make. Quantities must add up to the line's quantity exactly; a split is allowed.
                      </p>
                      {rfq.items.map((item) => {
                        const target = item.quantityBreakpoints[0]?.quantity ?? 0;
                        const perItem = split[item.rfqItemId] ?? {};
                        const awarded = evaluation.rows.reduce((sum, r) => sum + Number(perItem[r.bidVersionId] ?? 0), 0);
                        return (
                          <div key={item.rfqItemId} style={{ borderTop: 'var(--hairline) solid var(--color-border)', paddingTop: 'var(--space-3)' }}>
                            <p style={{ font: 'var(--text-body-strong)' }}>
                              Line {item.lineNo} — {item.partName} · {target} {item.quantityBreakpoints[0]?.unit ?? ''} · awarded {awarded}
                              {awarded !== target ? <StatusChip tone="attention"> does not add up</StatusChip> : <StatusChip tone="positive"> adds up</StatusChip>}
                            </p>
                            <Inline gap={2}>
                              {evaluation.rows.map((r) => (
                                <TextInput
                                  key={r.bidVersionId}
                                  label={`${r.supplierDisplayName} (v${r.versionNo})`}
                                  type="number"
                                  numeric
                                  value={perItem[r.bidVersionId] ?? ''}
                                  onChange={(e) => setSplit({ ...split, [item.rfqItemId]: { ...perItem, [r.bidVersionId]: e.target.value } })}
                                />
                              ))}
                            </Inline>
                          </div>
                        );
                      })}
                      <TextArea label="Rationale" value={rationale} onChange={(e) => setRationale(e.target.value)} />
                      {detail.singleSourceRisk || evaluation.rows.length === 1 ? (
                        <TextArea label="Fallback if this supplier fails" hint="Required: single source." value={fallback} onChange={(e) => setFallback(e.target.value)} />
                      ) : null}
                      <CommandButton
                        receiptLabel="Proposed"
                        disabled={rationale.trim().length < 3}
                        disabledReason="Give a rationale"
                        onCommand={async () => {
                          const award = await api<Award>('/awards', {
                            method: 'POST',
                            body: {
                              rfqId,
                              evaluationId: evaluation.evaluationId,
                              items: rfq.items.map((item) => ({
                                rfqItemId: item.rfqItemId,
                                targetQuantity: item.quantityBreakpoints[0]?.quantity ?? 0,
                                lines: Object.entries(split[item.rfqItemId] ?? {})
                                  .filter(([, qty]) => Number(qty) > 0)
                                  .map(([bidVersionId, qty]) => {
                                    const row = evaluation.rows.find((r) => r.bidVersionId === bidVersionId)!;
                                    const line = row.lines.find((l) => l.rfqItemId === item.rfqItemId)!;
                                    return { bidVersionId, bidQuantity: line.quantity, quantity: Number(qty) };
                                  }),
                              })),
                              rationale: rationale.trim(),
                              fallbackNote: fallback.trim(),
                            },
                            idempotencyKey: crypto.randomUUID(),
                          });
                          setNotice(`Award proposed; it needs approval before anything is selected.`);
                          setRationale('');
                          setSplit({});
                          await load();
                          window.location.assign(`/awards/${award.awardId}`);
                        }}
                      >
                        Propose award
                      </CommandButton>
                    </Stack>
                  ) : null}
                </Stack>
              ) : rfq.status === 'evaluation' ? (
                <p style={{ color: 'var(--color-text-muted)' }}>Run a comparison to start an award.</p>
              ) : null}
            </Stack>
          </Card>
        ) : null}

        <Card
          title="Close the round"
          description={
            waiting.length > 0
              ? `${waiting.length} supplier${waiting.length === 1 ? ' is' : 's are'} still inside the deadline.`
              : 'Everyone has answered or the deadline has passed.'
          }
        >
          <ReasonField label="Note" audience="internal" value={reason} onChange={setReason} />
          <CommandButton
            receiptLabel="Closed"
            disabled={!['open', 'responses_received'].includes(rfq.status)}
            onCommand={async () => {
              const result = await api<{ status: string; responded: number }>(
                `/rfqs/${rfqId}/close`,
                {
                  method: 'POST',
                  body: {
                    expectedVersion: rfq.aggregateVersion,
                    ...(reason.trim() ? { reason: reason.trim() } : {}),
                  },
                  idempotencyKey: `close:${rfqId}:${rfq.aggregateVersion}`,
                },
              );
              setNotice(
                result.status === 'no_bid'
                  ? 'Closed with no bids. Nobody is left waiting on us.'
                  : `Closed for evaluation with ${result.responded} bid${result.responded === 1 ? '' : 's'}.`,
              );
              setReason('');
              await load();
            }}
          >
            Close for evaluation
          </CommandButton>
        </Card>
      </Stack>
    </Page>
  );
}
