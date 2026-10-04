'use client';

import { useCallback, useEffect, useState } from 'react';
import type { BusinessCalendar, ControlQueue, DeadLetter, MeResponse, OperationsControls, RoleConflictView, SlaConfiguration } from '@jobwork/contracts';
import {
  Button,
  Callout,
  Card,
  CommandButton,
  DataTable,
  DescriptionList,
  ErrorState,
  formatAge,
  LoadingState,
  Page,
  ReasonField,
  Stack,
  StatusChip,
  UiLink,
  type Column,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { formatTarget } from '../queues/format';

/**
 * Operations health (F-11.3; doc 12 §7 business-control panel). The same numbers the
 * alerts are computed from, shown to the people who answer them: how each of the reader's
 * queues stands against its target; for platform and security administrators, the
 * platform's own backlogs; and anyone holding a role combination the separation-of-duties
 * rules forbid (doc 19 §9). Counts and ages only — every number links to the screen
 * where the work is done.
 */

const queueColumns = (calendar: BusinessCalendar | null): Array<Column<ControlQueue>> => [
  { key: 'queue', header: 'Queue', render: (q) => <UiLink href={`/queues?queue=${q.key}`}>{q.label}</UiLink> },
  { key: 'count', header: 'Waiting', numeric: true, render: (q) => q.count },
  {
    key: 'overdue',
    header: 'Overdue',
    numeric: true,
    render: (q) => (q.overdue > 0 ? <StatusChip tone="blocked">{`${q.overdue} overdue`}</StatusChip> : '0'),
  },
  { key: 'oldest', header: 'Oldest waiting', numeric: true, render: (q) => (q.oldestWaitingSince ? formatAge(q.oldestWaitingSince) : '—') },
  { key: 'target', header: 'Due within', render: (q) => (q.targetMinutes ? formatTarget(q.targetMinutes, calendar) : 'No target') },
];

const CONFLICT_COLUMNS: Array<Column<RoleConflictView & { ruleText: string }>> = [
  { key: 'person', header: 'Person', render: (c) => `${c.displayName} (${c.email})` },
  { key: 'roles', header: 'Roles held', render: (c) => c.roles.join(', ') },
  { key: 'rules', header: 'Rule broken', render: (c) => c.ruleText },
];

function seconds(value: number): string {
  if (value <= 0) return 'none waiting';
  return formatAge(new Date(Date.now() - value * 1000).toISOString());
}

export default function OpsHealthPage(): React.JSX.Element {
  const [data, setData] = useState<OperationsControls | null>(null);
  const [calendar, setCalendar] = useState<BusinessCalendar | null>(null);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[] | null>(null);
  const [canResolve, setCanResolve] = useState(false);
  const [resolving, setResolving] = useState<DeadLetter | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [controls, sla] = await Promise.all([api<OperationsControls>('/operations/controls'), api<SlaConfiguration>('/sla')]);
      setData(controls);
      setCalendar(sla.calendars[0] ?? null);
      if (controls.platform) {
        const [me, letters] = await Promise.all([api<MeResponse>('/auth/me'), api<{ deadLetters: DeadLetter[] }>('/operations/dead-letters')]);
        setCanResolve(me.roles.includes('platform_admin'));
        setDeadLetters(letters.deadLetters);
      }
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const platform = data?.platform ?? null;
  const sod = data?.separationOfDuties ?? null;
  const ruleReason = new Map((sod?.rules ?? []).map((r) => [r.key, r.reason]));

  return (
    <Page
      title="Operations health"
      description="How your queues stand against their service targets, and — for administrators — the platform's own backlogs and role conflicts."
      width="wide"
      actions={
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} correlationId={error.problem.correlationId} /> : null}
        {!data && !error ? <LoadingState label="Reading the controls" /> : null}

        {data ? (
          <Card title="Your queues" description={`As of ${new Date(data.generatedAt).toLocaleTimeString('en-IN', { timeStyle: 'short' })}. Overdue counts come from the last SLA sweep, at most a minute old.`} flush>
            <DataTable caption="Queues against their service targets" columns={queueColumns(calendar)} rows={data.queues} rowKey={(q) => q.key} />
          </Card>
        ) : null}

        {platform ? (
          <Card title="Platform" description="Backlogs between a committed change and its side effects. A growing number here means something is late, not lost.">
            <DescriptionList
              items={[
                {
                  label: 'Outbox',
                  value: (
                    <span style={{ display: 'inline-flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                      {`${platform.outbox.pending} pending, ${platform.outbox.processing} processing; oldest ${seconds(platform.outbox.oldestPendingSeconds)}`}
                      {platform.outbox.dead > 0 ? <StatusChip tone="blocked">{`${platform.outbox.dead} given up on — waiting for a person (outbox runbook)`}</StatusChip> : null}
                    </span>
                  ),
                },
                { label: 'File scans', value: `${platform.scan.backlog} waiting; oldest ${seconds(platform.scan.oldestSeconds)}` },
                {
                  label: 'Notification e-mail',
                  value:
                    platform.deliveries.failedLastHour + platform.deliveries.stuckSending === 0
                      ? 'No failures in the last hour'
                      : `${platform.deliveries.failedLastHour} failed in the last hour, ${platform.deliveries.stuckSending} stuck sending`,
                },
                {
                  label: 'Rate-limit counters',
                  value: platform.rateLimitStoreDegraded ? (
                    <StatusChip tone="attention">Redis unreachable — this instance counts in memory</StatusChip>
                  ) : (
                    'Shared (Redis)'
                  ),
                },
              ]}
            />
          </Card>
        ) : null}

        {deadLetters && deadLetters.length > 0 ? (
          <Card
            title="Events given up on"
            description="The worker stopped retrying these. Replay one once its cause is fixed; dismiss it if the step is no longer wanted. Both are recorded with your reason (outbox runbook)."
            flush
          >
            <Stack gap={3}>
              {resolving ? (
                <ResolvePanel
                  letter={resolving}
                  onDone={async () => {
                    setResolving(null);
                    await load();
                  }}
                  onCancel={() => setResolving(null)}
                />
              ) : null}
              <DataTable
                caption="Outbox events given up on"
                columns={deadLetterColumns(canResolve ? setResolving : null)}
                rows={deadLetters}
                rowKey={(l) => l.eventId}
              />
            </Stack>
          </Card>
        ) : null}

        {sod ? (
          <Card title="Separation of duties" description="Role combinations one person may not hold. New invitations that would break a rule are refused; these people held the combination before the rule existed.">
            <Stack gap={3}>
              {sod.conflicts.length === 0 ? (
                <Callout tone="positive" title="Nobody holds a forbidden combination">
                  Every JobWork person's roles pass the rules below.
                </Callout>
              ) : (
                <DataTable
                  caption="People holding a forbidden role combination"
                  columns={CONFLICT_COLUMNS}
                  rows={sod.conflicts.map((c) => ({ ...c, ruleText: c.rules.map((k) => ruleReason.get(k) ?? k).join(' ') }))}
                  rowKey={(c) => c.userId}
                />
              )}
              <ul style={{ margin: 0, paddingLeft: 'var(--space-5)', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                {sod.rules.map((r) => (
                  <li key={r.key}>
                    {r.roles.map((role) => (role === '*' ? 'any other role' : role)).join(' with ')}: {r.reason} ({r.source})
                  </li>
                ))}
              </ul>
            </Stack>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}

function deadLetterColumns(onResolve: ((letter: DeadLetter) => void) | null): Array<Column<DeadLetter>> {
  const columns: Array<Column<DeadLetter>> = [
    { key: 'type', header: 'Event', render: (l) => <code>{l.eventType}</code> },
    { key: 'about', header: 'About', render: (l) => l.aggregateType.replace(/_/g, ' ') },
    { key: 'age', header: 'Since', numeric: true, render: (l) => formatAge(l.occurredAt) },
    { key: 'attempts', header: 'Tries', numeric: true, render: (l) => l.attempts },
    { key: 'error', header: 'Last error', render: (l) => l.lastError ?? '—' },
  ];
  if (onResolve) {
    columns.push({
      key: 'act',
      header: '',
      render: (l) => (
        <Button size="sm" variant="secondary" onClick={() => onResolve(l)}>
          Resolve
        </Button>
      ),
    });
  }
  return columns;
}

function ResolvePanel({ letter, onDone, onCancel }: { letter: DeadLetter; onDone: () => Promise<void>; onCancel: () => void }): React.JSX.Element {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  async function resolve(verb: 'replay' | 'dismiss'): Promise<void> {
    setError(null);
    try {
      await api(`/operations/dead-letters/${letter.eventId}/${verb}`, {
        method: 'POST',
        body: { reason: reason.trim() },
        idempotencyKey: `dead-letter-${verb}-${letter.eventId}`,
      });
      await onDone();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setError(err);
      throw err;
    }
  }

  const ready = reason.trim().length >= 3;
  return (
    <div style={{ padding: 'var(--space-4) var(--table-cell-pad) 0' }}>
      <Stack gap={3}>
        <p style={{ font: 'var(--text-body-strong)' }}>
          {letter.eventType}, given up on {formatAge(letter.occurredAt)} ago
        </p>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        <ReasonField label="Why (kept with the decision)" audience="internal" value={reason} onChange={setReason} />
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <CommandButton key="replay" receiptLabel="Queued again" disabled={!ready} disabledReason="Say why" onCommand={() => resolve('replay')}>
            Replay {letter.eventType}
          </CommandButton>
          <CommandButton key="dismiss" variant="secondary" receiptLabel="Dismissed" disabled={!ready} disabledReason="Say why" onCommand={() => resolve('dismiss')}>
            Dismiss — no longer wanted
          </CommandButton>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </Stack>
    </div>
  );
}
