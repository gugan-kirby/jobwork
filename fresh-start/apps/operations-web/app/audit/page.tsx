'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Button,
  Callout,
  Card,
  CopyableId,
  DataTable,
  ErrorState,
  Inline,
  LoadingState,
  Page,
  Stack,
  TextInput,
  type Column,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

interface AuditEvent {
  id: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  correlationId: string;
  data: Record<string, unknown>;
}

/**
 * The audit explorer (UC-37, F-02.6).
 *
 * Correlation ids are the point of this screen: one id ties a command to its audit row,
 * its outbox event and whatever the worker did next, so every id here is copyable rather
 * than something to squint at and retype.
 */
export default function AuditPage(): React.JSX.Element {
  // A boundary because the subject filter arrives in the URL: every record in the
  // console links here for its own history (F-OPS.5).
  return (
    <Suspense
      fallback={
        <Page title="Audit explorer" width="wide">
          <Card>
            <LoadingState label="Loading the audit trail" />
          </Card>
        </Page>
      }
    >
      <AuditExplorer />
    </Suspense>
  );
}

function AuditExplorer(): React.JSX.Element {
  const searchParams = useSearchParams();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [correlationId, setCorrelationId] = useState('');
  const [subjectType] = useState(searchParams.get('subjectType') ?? '');
  const [subjectId] = useState(searchParams.get('subjectId') ?? '');
  const [aboutOrganizationId] = useState(searchParams.get('aboutOrganizationId') ?? '');
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setError(null);
      const params = new URLSearchParams();
      if (action) params.set('action', action);
      if (correlationId) params.set('correlationId', correlationId);
      if (subjectType) params.set('subjectType', subjectType);
      if (subjectId) params.set('subjectId', subjectId);
      if (aboutOrganizationId) params.set('aboutOrganizationId', aboutOrganizationId);
      if (cursor) params.set('cursor', cursor);
      try {
        const res = await api<{ events: AuditEvent[]; nextCursor: string | null }>(
          `/audit-events?${params.toString()}`,
        );
        setEvents((prev) => (cursor && prev ? [...prev, ...res.events] : res.events));
        setNextCursor(res.nextCursor);
      } catch (err) {
        // Left null on purpose: "no audit events match" is a claim about the data, and
        // we do not have any data to make it about.
        if (err instanceof ApiError) setError(err);
      }
    },
    [action, correlationId, subjectType, subjectId, aboutOrganizationId],
  );

  useEffect(() => {
    void load();
    // Filters are applied explicitly; typing must not refire the query per keystroke.
  }, []);

  const columns: ReadonlyArray<Column<AuditEvent>> = [
    {
      key: 'time',
      header: 'Time',
      render: (event) =>
        new Date(event.occurredAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST',
    },
    { key: 'action', header: 'Action', render: (event) => <strong>{event.action}</strong> },
    {
      key: 'subject',
      header: 'Subject',
      render: (event) => (
        <>
          {event.subjectType}/ <CopyableId value={event.subjectId} label="Subject id" />
        </>
      ),
    },
    {
      key: 'actor',
      header: 'Actor',
      render: (event) => (
        <>
          {event.actorType}
          {event.actorId ? (
            <>
              : <CopyableId value={event.actorId} label="Actor id" />
            </>
          ) : null}
        </>
      ),
    },
    {
      key: 'correlation',
      header: 'Correlation',
      render: (event) => <CopyableId value={event.correlationId} label="Correlation id" edge={8} />,
    },
  ];

  return (
    <Page
      title="Audit explorer"
      description="Every command that changed business state, newest first. One correlation id ties a request to its audit row, its outbox event and the work that followed."
      width="wide"
    >
      <Stack gap={4}>
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : null}

        {aboutOrganizationId ? (
          <Callout tone="neutral" title="Showing one organization">
            Everything filed against <code>{aboutOrganizationId}</code> — the organization
            record itself, its memberships and users, and commands issued from inside it.{' '}
            <a href="/audit">Show everything</a>.
          </Callout>
        ) : subjectId ? (
          <Callout tone="neutral" title={`Showing one ${subjectType || 'record'}`}>
            Filtered to <code>{subjectId}</code>. <a href="/audit">Show everything</a>.
          </Callout>
        ) : null}

        <Card title="Filters">
          <Inline gap={3} align="flex-end">
            <div style={{ flex: 1, minWidth: 240 }}>
              <TextInput
                label="Action"
                placeholder="e.g. sourcing.enquiry_submitted"
                value={action}
                onChange={(event) => setAction(event.target.value)}
              />
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <TextInput
                label="Correlation ID"
                value={correlationId}
                onChange={(event) => setCorrelationId(event.target.value)}
              />
            </div>
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <Button onClick={() => void load()}>Apply filters</Button>
            </div>
          </Inline>
        </Card>

        <Card flush>
          <DataTable
            caption="Audit events matching the current filters"
            columns={columns}
            rows={events}
            rowKey={(event) => event.id}
            loadingLabel="Loading audit events"
            stackTitle={(event) => event.action}
            empty={{
              title: 'No audit events match',
              detail:
                'Clear the filters to see everything, or check the action name — actions are namespaced, like sourcing.enquiry_submitted.',
            }}
          />
        </Card>

        {nextCursor ? (
          <div>
            <Button variant="secondary" onClick={() => void load(nextCursor)}>
              Load more
            </Button>
          </div>
        ) : null}
      </Stack>
    </Page>
  );
}
