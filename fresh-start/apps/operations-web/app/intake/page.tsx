'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Enquiry } from '@jobwork/contracts';
import {
  Card,
  DataTable,
  ErrorState,
  Page,
  Stack,
  StatusChip,
  type Column,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * The intake queue (doc 14 §6).
 *
 * Operations sees the real state — unlike the customer, who sees the curated projection —
 * because a reviewer cannot decide what to do next without knowing exactly where an
 * enquiry is and who it is waiting on.
 */

const STATE: Record<string, { label: string; tone: Tone }> = {
  submitted: { label: 'Waiting for triage', tone: 'attention' },
  under_review: { label: 'Under review', tone: 'progress' },
  clarification_required: { label: 'Waiting on the customer', tone: 'neutral' },
};

export default function IntakeQueuePage() {
  const [enquiries, setEnquiries] = useState<Enquiry[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<{ enquiries: Enquiry[] }>('/intake/queue')
      .then((res) => setEnquiries(res.enquiries))
      // A failed request is not an empty queue (see the portal list for the same rule).
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  const columns: ReadonlyArray<Column<Enquiry>> = [
    {
      key: 'reference',
      header: 'Reference',
      render: (enquiry) => (
        <Link href={`/intake/${enquiry.enquiryId}`} className="mono">
          {enquiry.reference}
        </Link>
      ),
    },
    {
      key: 'title',
      header: 'Title',
      // The stacked card's heading already states reference and title.
      hideOnStack: true,
      render: (enquiry) => (
        <>
          {enquiry.title}
          {enquiry.assistedIntake ? (
            <>
              {' '}
              <StatusChip tone="special" silent>
                assisted
              </StatusChip>
            </>
          ) : null}
        </>
      ),
    },
    { key: 'items', header: 'Items', render: (enquiry) => enquiry.items.length, numeric: true },
    {
      key: 'submitted',
      header: 'Submitted',
      render: (enquiry) => enquiry.submittedAt?.slice(0, 10) ?? '—',
    },
    {
      key: 'revision',
      header: 'Revision',
      numeric: true,
      render: (enquiry) =>
        enquiry.currentRevisionNo !== enquiry.submittedRevisionNo
          ? `${enquiry.submittedRevisionNo} → ${enquiry.currentRevisionNo}`
          : String(enquiry.submittedRevisionNo ?? '—'),
    },
    {
      key: 'state',
      header: 'State',
      render: (enquiry) => {
        const state = STATE[enquiry.status];
        return <StatusChip tone={state?.tone ?? 'neutral'}>{state?.label ?? enquiry.status}</StatusChip>;
      },
    },
    {
      key: 'open',
      header: 'Open questions',
      numeric: true,
      render: (enquiry) => enquiry.clarifications.filter((c) => c.status === 'open').length,
    },
  ];

  return (
    <Page
      title="Intake and enquiries"
      description="Oldest submission first. Everything here is waiting on JobWork or on a customer's answer."
      width="wide"
    >
      <Stack gap={4}>
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : null}
        {error ? null : (
        <Card flush>
          <DataTable
            caption="Enquiries awaiting triage, review or a customer answer"
            columns={columns}
            rows={enquiries}
            rowKey={(enquiry) => enquiry.enquiryId}
            loadingLabel="Loading the intake queue"
            stackTitle={(enquiry) => (
              <Link href={`/intake/${enquiry.enquiryId}`}>
                {enquiry.reference} — {enquiry.title}
              </Link>
            )}
            empty={{
              title: 'Nothing waiting',
              detail:
                'New customer submissions appear here as soon as they are made. Approved and declined enquiries leave the queue.',
            }}
          />
        </Card>
        )}
      </Stack>
    </Page>
  );
}
