'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { LeakageReviewDetail, LeakageReviewListItem } from '@jobwork/contracts';
import {
  Button,
  Callout,
  Card,
  CommandButton,
  DataTable,
  DescriptionList,
  ErrorState,
  HighlightedText,
  LoadingState,
  Page,
  ReasonField,
  Select,
  Stack,
  StatusChip,
  TextArea,
  type Column,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * Held messages (F-10.4, `FR-1002`, doc 07 §12). Each row is a message nobody outside
 * JobWork can read yet, because it may name a party or carry contact details. The
 * reviewer sees exactly what was flagged and decides: release it as written, release an
 * edited copy (the original is kept), or reject it. The author never reviews their own.
 */

const STATUS: Record<LeakageReviewListItem['status'], { label: string; tone: Tone }> = {
  open: { label: 'Waiting', tone: 'attention' },
  noted: { label: 'Noted', tone: 'neutral' },
  released: { label: 'Released', tone: 'positive' },
  released_redacted: { label: 'Released edited', tone: 'positive' },
  rejected: { label: 'Rejected', tone: 'blocked' },
};

const FILTERS = [
  { value: 'open', label: 'Waiting' },
  { value: 'decided', label: 'Decided' },
];

type Decision = 'release' | 'release_redacted' | 'reject';

export default function LeakageReviewsPage(): React.JSX.Element {
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState<LeakageReviewListItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<LeakageReviewDetail | null>(null);
  const [opening, setOpening] = useState(false);
  const [reason, setReason] = useState('');
  const [redacted, setRedacted] = useState('');
  const [decisionError, setDecisionError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows((await api<{ reviews: LeakageReviewListItem[] }>(`/leakage-reviews?status=${status}`)).reviews);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setError(err);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(reviewId: string): Promise<void> {
    setOpening(true);
    setDecisionError(null);
    try {
      const detail = await api<LeakageReviewDetail>(`/leakage-reviews/${reviewId}`);
      setSelected(detail);
      setReason('');
      setRedacted(detail.suggestedRedaction);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setError(err);
    } finally {
      setOpening(false);
    }
  }

  async function decide(decision: Decision): Promise<void> {
    if (!selected) return;
    setDecisionError(null);
    try {
      const updated = await api<LeakageReviewDetail>(`/leakage-reviews/${selected.reviewId}/decide`, {
        method: 'POST',
        body: {
          decision,
          reason: reason.trim(),
          expectedVersion: selected.aggregateVersion,
          ...(decision === 'release_redacted' ? { redactedBody: redacted.trim() } : {}),
        },
        idempotencyKey: `leakage-${selected.reviewId}-${decision}`,
      });
      setSelected(updated);
      await load();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setDecisionError(err);
      throw err;
    }
  }

  const columns: Array<Column<LeakageReviewListItem>> = [
    {
      key: 'where',
      header: 'About',
      render: (row) => <Link href={row.href}>{row.context.label}</Link>,
    },
    { key: 'reader', header: 'Would be read by', render: (row) => row.readerLabel },
    { key: 'author', header: 'Written by', render: (row) => row.authorName },
    { key: 'found', header: 'Flags', numeric: true, render: (row) => row.findingCount },
    { key: 'when', header: 'Held since', render: (row) => new Date(row.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusChip tone={STATUS[row.status].tone}>{STATUS[row.status].label}</StatusChip>,
    },
    {
      key: 'act',
      header: '',
      render: (row) => (
        <Button size="sm" variant={row.status === 'open' ? 'primary' : 'ghost'} onClick={() => void open(row.reviewId)}>
          {row.status === 'open' ? 'Review' : 'View'}
        </Button>
      ),
    },
  ];

  const reasonReady = reason.trim().length >= 3;

  return (
    <Page
      title="Held messages"
      description="Messages that may name a party or carry contact details. Nobody outside JobWork sees them until someone here decides."
      width="wide"
      actions={<Select label="Show" value={status} options={FILTERS} onChange={(event) => setStatus(event.target.value)} />}
    >
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} correlationId={error.problem.correlationId} /> : null}

        {opening ? (
          <Card>
            <LoadingState label="Opening the message" />
          </Card>
        ) : selected ? (
          <Card
            title={`Held message about ${selected.context.label}`}
            description={`Would be read by ${selected.readerLabel}. Written by ${selected.authorName}.`}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                Close
              </Button>
            }
          >
            <Stack gap={3}>
              <div className="jw-leak-preview">
                <HighlightedText text={selected.body} spans={selected.findings} />
              </div>
              <ul className="jw-leak-findings">
                {selected.findings.map((f) => (
                  <li key={`${f.kind}:${f.start}`}>
                    {f.label}: <q>{f.text}</q> {f.confidence === 'low' ? '(low confidence)' : ''}
                  </li>
                ))}
              </ul>

              {selected.status !== 'open' ? (
                <DescriptionList
                  items={[
                    { label: 'Decision', value: STATUS[selected.status].label },
                    { label: 'Decided by', value: selected.decidedByName ?? '—' },
                    { label: 'Reason', value: selected.decisionReason ?? '—' },
                  ]}
                />
              ) : selected.canDecide ? (
                <>
                  {decisionError ? (
                    <ErrorState message={decisionError.problem.detail ?? decisionError.problem.title} code={decisionError.problem.code} />
                  ) : null}
                  <ReasonField label="Why (kept with the decision)" audience="internal" value={reason} onChange={setReason} />
                  <TextArea
                    label="Edited copy"
                    hint="Released instead of the original if you choose “Release edited copy”. The original is kept, unchanged."
                    value={redacted}
                    rows={4}
                    onChange={(event) => setRedacted(event.target.value)}
                  />
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <CommandButton receiptLabel="Released" disabled={!reasonReady} disabledReason="Say why" onCommand={() => decide('release')}>
                      Release as written
                    </CommandButton>
                    <CommandButton
                      variant="secondary"
                      receiptLabel="Released"
                      disabled={!reasonReady || redacted.trim().length === 0}
                      disabledReason="Say why, and write the edited copy"
                      onCommand={() => decide('release_redacted')}
                    >
                      Release edited copy
                    </CommandButton>
                    <CommandButton variant="danger" receiptLabel="Rejected" disabled={!reasonReady} disabledReason="Say why" onCommand={() => decide('reject')}>
                      Reject
                    </CommandButton>
                  </div>
                </>
              ) : (
                <Callout tone="neutral">{selected.cannotDecideReason}</Callout>
              )}
            </Stack>
          </Card>
        ) : null}

        <Card flush>
          <DataTable
            caption="Held messages"
            columns={columns}
            rows={error ? [] : rows}
            rowKey={(row) => row.reviewId}
            loadingLabel="Loading held messages"
            stackTitle={(row) => row.context.label}
            empty={{
              title: status === 'open' ? 'Nothing held' : 'No decisions yet',
              detail: status === 'open' ? 'Messages arrive here when they may name a party or carry contact details.' : 'Decided reviews appear here.',
            }}
          />
        </Card>
      </Stack>
    </Page>
  );
}
