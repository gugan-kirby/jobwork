'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { MeResponse, QueueAssignee, QueueItem, QueuesView, SlaConfiguration } from '@jobwork/contracts';
import {
  Button,
  Card,
  CommandButton,
  DataTable,
  ErrorState,
  FilterChips,
  LoadingState,
  Page,
  QueueTable,
  ReasonField,
  Select,
  Stack,
  type Column,
  type QueueTableItem,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { formatTarget, formatWorkingWeek, isDueToday } from './format';

/**
 * Work queues (F-11.1; doc 07 §11; doc 21 queue table). Every item the reader's roles
 * work, across intake, sourcing, approvals, finance, production and reviews, ordered by
 * deadline. Owner and deadline are the queue's own state; whether an item is here at all
 * is the owning record's state, so this list and the command-center counts agree.
 *
 * Filters live in the URL — a link to "my overdue approvals" is the saved filter people
 * actually share — and the last one used is remembered on this browser.
 */

type View = 'all' | 'mine' | 'unassigned' | 'overdue' | 'today';

const VIEWS: Array<{ value: View; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Mine' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
];

const REMEMBERED = 'jw.queues.filter';

interface TargetRow {
  key: string;
  label: string;
  team: string;
  target: string;
}

const TARGET_COLUMNS: Array<Column<TargetRow>> = [
  { key: 'queue', header: 'Queue', render: (row) => row.label },
  { key: 'team', header: 'Team', render: (row) => row.team },
  { key: 'target', header: 'Due within', render: (row) => row.target },
];

interface Row extends QueueTableItem {
  item: QueueItem;
}

export default function QueuesPage(): React.JSX.Element {
  return (
    <Suspense fallback={<LoadingState label="Loading queues" />}>
      <Queues />
    </Suspense>
  );
}

function matches(view: View, item: QueueItem, me: string | null): boolean {
  switch (view) {
    case 'mine':
      return item.assignee?.userId === me;
    case 'unassigned':
      return item.assignee === null;
    case 'overdue':
      return item.state === 'overdue';
    case 'today':
      return isDueToday(item.dueAt, item.timeZone);
    default:
      return true;
  }
}

function Queues(): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [data, setData] = useState<QueuesView | null>(null);
  const [config, setConfig] = useState<SlaConfiguration | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [reassigning, setReassigning] = useState<QueueItem | null>(null);

  const view = (VIEWS.some((v) => v.value === params.get('view')) ? params.get('view') : 'all') as View;
  const queue = params.get('queue') ?? 'all';

  // An empty URL restores the last filter used here; a URL with a filter always wins.
  useEffect(() => {
    if (params.toString() !== '') return;
    try {
      const remembered = window.localStorage.getItem(REMEMBERED);
      if (remembered) router.replace(`${pathname}?${remembered}`);
    } catch {
      // Storage blocked (private window): the default filter is fine.
    }
  }, [params, pathname, router]);

  function setFilter(next: { view?: View; queue?: string }): void {
    const query = new URLSearchParams();
    const v = next.view ?? view;
    const q = next.queue ?? queue;
    if (q !== 'all') query.set('queue', q);
    if (v !== 'all') query.set('view', v);
    const text = query.toString();
    try {
      window.localStorage.setItem(REMEMBERED, text);
    } catch {
      // Remembering is a convenience; the URL is the filter.
    }
    router.replace(text ? `${pathname}?${text}` : pathname);
  }

  const load = useCallback(async () => {
    setError(null);
    try {
      const [account, queues, sla] = await Promise.all([
        api<MeResponse>('/auth/me'),
        api<QueuesView>('/queues'),
        api<SlaConfiguration>('/sla'),
      ]);
      setMe(account);
      setData(queues);
      setConfig(sla);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const meId = me?.userId ?? null;
  const rows = useMemo<Row[] | null>(() => {
    if (!data) return null;
    return data.items
      .filter((item) => (queue === 'all' || item.queueKey === queue) && matches(view, item, meId))
      .map((item) => ({
        key: `${item.queueKey}:${item.subjectId}`,
        reference: item.reference,
        title: item.title,
        queueLabel: item.queueLabel,
        href: item.href,
        waitingSince: item.waitingSince,
        dueAt: item.dueAt,
        timeZone: item.timeZone,
        state: item.state,
        escalationLevel: item.escalationLevel,
        owner: item.assignee?.displayName ?? null,
        mine: item.assignee !== null && item.assignee.userId === meId,
        item,
      }));
  }, [data, queue, view, meId]);

  async function command(item: QueueItem, verb: 'take' | 'release', body: unknown): Promise<void> {
    setActionError(null);
    try {
      await api<QueueItem>(`/queues/${item.queueKey}/items/${item.subjectId}/${verb}`, {
        method: 'POST',
        body,
        idempotencyKey: `queue-${verb}-${item.queueKey}-${item.subjectId}-${item.assignmentVersion ?? 0}`,
      });
      await load();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setActionError(err);
      await load();
      throw err;
    }
  }

  const counts = useMemo(() => {
    const items = (data?.items ?? []).filter((i) => queue === 'all' || i.queueKey === queue);
    return Object.fromEntries(VIEWS.map((v) => [v.value, items.filter((i) => matches(v.value, i, meId)).length])) as Record<View, number>;
  }, [data, queue, meId]);

  const queueOptions = [
    // No count until there is one: "(0)" while loading would be a claim, not a placeholder.
    { value: 'all', label: data ? `All queues (${data.items.length})` : 'All queues' },
    ...(data?.queues ?? []).map((q) => ({ value: q.key, label: `${q.label} (${q.count}${q.overdue ? `, ${q.overdue} overdue` : ''})` })),
  ];
  const calendar = config?.calendars[0] ?? null;

  return (
    <Page
      title="Work queues"
      description="Everything waiting on your teams, oldest deadline first. Take an item to own it; hand it back or reassign it with a reason."
      width="wide"
      actions={<Select label="Queue" value={queue} options={queueOptions} onChange={(event) => setFilter({ queue: event.target.value })} />}
    >
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} correlationId={error.problem.correlationId} /> : null}
        <FilterChips
          label="Show items"
          value={view}
          options={VIEWS.map((v) => ({ ...v, count: data ? counts[v.value] : undefined }))}
          onChange={(value) => setFilter({ view: value })}
        />
        {actionError ? <ErrorState message={actionError.problem.detail ?? actionError.problem.title} code={actionError.problem.code} /> : null}

        {reassigning ? (
          <ReassignPanel
            item={reassigning}
            onDone={async () => {
              setReassigning(null);
              await load();
            }}
            onCancel={() => setReassigning(null)}
          />
        ) : null}

        <Card flush>
          <QueueTable
            caption="Items waiting in your queues"
            items={rows}
            showQueue={queue === 'all'}
            empty={
              view === 'all'
                ? undefined
                : { title: 'Nothing matches this filter', detail: 'Choose “All” to see everything waiting in these queues.' }
            }
            actions={(row) => {
              const item = row.item;
              // Keyed: Take and Hand back sit in the same slot, and an unkeyed swap would
              // carry Take's "done" state into Hand back as a false receipt.
              const primary = row.mine ? (
                <CommandButton key="release" size="sm" variant="secondary" receiptLabel="Handed back" onCommand={() => command(item, 'release', { expectedVersion: item.assignmentVersion })}>
                  Hand back
                </CommandButton>
              ) : item.assignee === null ? (
                <CommandButton key="take" size="sm" receiptLabel="Yours" onCommand={() => command(item, 'take', { expectedVersion: item.assignmentVersion })}>
                  Take
                </CommandButton>
              ) : null;
              return (
                <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
                  {primary}
                  <Button size="sm" variant="ghost" onClick={() => setReassigning(item)}>
                    Reassign
                  </Button>
                </span>
              );
            }}
          />
        </Card>

        <Card
          title="Service targets"
          description="Working time on the business calendar below, counted from when an item arrived — or from when its target took effect, if it was already waiting. An item is due at its target and raised with the whole team at twice it."
          flush
        >
          {config && data ? (
            <Stack gap={3}>
              <DataTable
                caption="Service targets by queue"
                columns={TARGET_COLUMNS}
                rows={data.queues
                  .filter((q) => q.targetMinutes !== null)
                  .map((q) => ({ key: q.key, label: q.label, team: q.owningTeam, target: formatTarget(q.targetMinutes!, calendar) }))}
                rowKey={(row) => row.key}
              />
              {calendar ? (
                <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)', padding: '0 var(--table-cell-pad) var(--space-3)' }}>
                  Calendar “{calendar.calendarKey}” version {calendar.version}: {formatWorkingWeek(calendar)}, {calendar.timeZone}.{' '}
                  {calendar.holidays.length} holidays declared. Last change: {calendar.reason}.
                </p>
              ) : null}
            </Stack>
          ) : (
            <LoadingState label="Loading targets" />
          )}
        </Card>
      </Stack>
    </Page>
  );
}

function ReassignPanel({ item, onDone, onCancel }: { item: QueueItem; onDone: () => Promise<void>; onCancel: () => void }): React.JSX.Element {
  const [people, setPeople] = useState<QueueAssignee[] | null>(null);
  const [assignee, setAssignee] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<{ assignees: QueueAssignee[] }>(`/queues/${item.queueKey}/assignees`)
      .then((r) => setPeople(r.assignees))
      .catch((err: unknown) => {
        if (err instanceof ApiError) setError(err);
      });
  }, [item.queueKey]);

  async function reassign(): Promise<void> {
    setError(null);
    try {
      await api<QueueItem>(`/queues/${item.queueKey}/items/${item.subjectId}/reassign`, {
        method: 'POST',
        body: { assigneeUserId: assignee === 'queue' ? null : assignee, reason: reason.trim(), expectedVersion: item.assignmentVersion },
        idempotencyKey: `queue-reassign-${item.queueKey}-${item.subjectId}-${item.assignmentVersion ?? 0}-${assignee}`,
      });
      await onDone();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setError(err);
      throw err;
    }
  }

  const options = [
    { value: 'queue', label: 'Nobody — back to the queue' },
    ...(people ?? []).filter((p) => p.userId !== item.assignee?.userId).map((p) => ({ value: p.userId, label: p.displayName })),
  ];
  const ready = assignee !== '' && reason.trim().length >= 3;

  return (
    <Card
      title={`Reassign ${item.reference}`}
      description={`${item.title} — ${item.queueLabel}. ${item.assignee ? `Now with ${item.assignee.displayName}.` : 'Nobody has it yet.'}`}
      actions={
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      }
    >
      <Stack gap={3}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {people === null && !error ? (
          <LoadingState label="Finding people who work this queue" />
        ) : (
          <Select label="Give it to" placeholder="Choose a person" value={assignee} options={options} onChange={(event) => setAssignee(event.target.value)} />
        )}
        <ReasonField label="Why (kept with the change)" audience="internal" value={reason} onChange={setReason} />
        <div>
          <CommandButton receiptLabel="Reassigned" disabled={!ready} disabledReason="Choose a person and say why" onCommand={reassign}>
            Reassign {item.reference}
          </CommandButton>
        </div>
      </Stack>
    </Card>
  );
}
