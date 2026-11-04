'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { OperationsSummary, WorkQueue } from '@jobwork/contracts';
import { ButtonLink, Card, ErrorState, Icon, LoadingState, Page, type IconName } from '@jobwork/ui';
import { api, ApiError } from '../lib/api';

interface Me {
  displayName: string;
  email: string;
  organizationType: string | null;
  roles: string[];
  mfaEnrolled: boolean;
}

/**
 * The control room (doc 14 §6, F-OPS.3, VF-19): a status band that answers "how much, and
 * how late" before anything else, the work laid out along the line it moves on, and a
 * worklist ordered by what has waited longest. Picking a stage narrows the worklist.
 * Queues are chosen by the server from the operator's roles, so this page never renders
 * a number somebody cannot act on.
 */

type Stage = { key: string; label: string; icon: IconName; queues: ReadonlyArray<WorkQueue['key']> };

const STAGES: readonly Stage[] = [
  { key: 'intake', label: 'Intake', icon: 'enquiries', queues: ['enquiries_awaiting_triage', 'clarifications_awaiting_customer'] },
  {
    key: 'network',
    label: 'Network',
    icon: 'team',
    queues: ['supplier_applications_received', 'invitations_pending', 'supplier_files_awaiting_decision', 'supplier_evidence_awaiting_review', 'suppliers_unmatchable'],
  },
  { key: 'sourcing', label: 'Sourcing', icon: 'quote', queues: ['rfqs_in_evaluation', 'approvals_pending'] },
  { key: 'orders', label: 'Orders', icon: 'orders', queues: ['orders_awaiting_release', 'purchase_orders_to_issue', 'baselines_to_release', 'work_packages_to_release'] },
  { key: 'quality', label: 'Quality', icon: 'shieldCheck', queues: ['milestones_to_verify', 'inspections_awaiting_review', 'ncrs_open'] },
  {
    key: 'delivery',
    label: 'Delivery',
    icon: 'truck',
    queues: ['shipments_to_release', 'shipments_awaiting_receiving', 'receiving_discrepancies_open', 'customer_dispatches_to_release', 'deliveries_awaiting_pod', 'delivery_exceptions_open'],
  },
  { key: 'control', label: 'Finance & control', icon: 'payment', queues: ['payments_unmatched', 'supplier_bills_to_match', 'settlements_held', 'cases_open', 'leakage_reviews_open'] },
];

const DAY = 24 * 60 * 60 * 1000;

function daysWaiting(queue: WorkQueue, now: number): number | null {
  return queue.oldestWaitingSince ? Math.max(0, Math.floor((now - Date.parse(queue.oldestWaitingSince)) / DAY)) : null;
}

function ageClass(days: number | null): string {
  if (days === null || days <= 2) return 'ops-age-fresh';
  return days <= 14 ? 'ops-age-due' : 'ops-age-late';
}

function ageText(days: number | null): string {
  if (days === null) return 'new';
  return days === 0 ? 'today' : `${days}d`;
}

function greeting(now: Date): string {
  const hour = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(now));
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

export default function HomePage(): React.JSX.Element {
  const [me, setMe] = useState<Me | null>(null);
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [anonymous, setAnonymous] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    try {
      const account = await api<Me>('/auth/me');
      setMe(account);
      // A summary the actor may not read is not an error worth showing them; the page
      // still works as the account view it always was.
      setSummary(await api<OperationsSummary>('/operations/summary').catch(() => null));
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.problem.status === 401) setAnonymous(true);
      else setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (anonymous) {
    return (
      <Page title="JobWork operations" width="narrow">
        <Card>
          <p>
            <Link href="/login">Sign in</Link> to continue.
          </p>
        </Card>
      </Page>
    );
  }

  if (!me) {
    return (
      <Page title="JobWork operations" width="narrow">
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} correlationId={error.problem.correlationId} />
        ) : (
          <Card>
            <LoadingState label="Loading your account" />
          </Card>
        )}
      </Page>
    );
  }

  return <ControlRoom me={me} summary={summary} />;
}

function ControlRoom({ me, summary }: { me: Me; summary: OperationsSummary | null }): React.JSX.Element {
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);
  const queues = useMemo(() => summary?.queues ?? [], [summary]);
  const stageOf = (queue: WorkQueue): Stage | undefined => STAGES.find((stage) => stage.queues.includes(queue.key));

  const waiting = queues
    .filter((queue) => queue.count > 0)
    .sort((a, b) => (daysWaiting(b, now.getTime()) ?? -1) - (daysWaiting(a, now.getTime()) ?? -1));
  const stages = STAGES.map((stage) => {
    const own = queues.filter((queue) => stage.queues.includes(queue.key));
    const count = own.reduce((sum, queue) => sum + queue.count, 0);
    const oldest = Math.max(-1, ...own.filter((queue) => queue.count > 0).map((queue) => daysWaiting(queue, now.getTime()) ?? 0));
    return { ...stage, present: own.length > 0, count, oldest: oldest < 0 ? null : oldest };
  }).filter((stage) => stage.present);

  const total = waiting.reduce((sum, queue) => sum + queue.count, 0);
  const oldest = waiting.length > 0 ? daysWaiting(waiting[0]!, now.getTime()) : null;
  const clearStages = stages.filter((stage) => stage.count === 0).length;
  const worklist = stageFilter ? waiting.filter((queue) => stageOf(queue)?.key === stageFilter) : waiting;
  const clear = queues.filter((queue) => queue.count === 0);
  const isAdministrator = me.roles.includes('platform_admin') || me.roles.includes('security_admin');
  const firstName = me.displayName.split(' ')[0];

  return (
    <Page title={`${greeting(now)}, ${firstName}`} titleHidden width="wide">
      <div className="ops-room">
        <section className="ops-deck" aria-label="Status">
          <div className="ops-deck-copy">
            <p className="ops-deck-eyebrow">
              Control room ·{' '}
              {now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' })}
            </p>
            <p className="ops-deck-title">
              {greeting(now)}, {firstName}
            </p>
            <p className="ops-deck-sub">
              {summary === null
                ? 'Counting what is waiting.'
                : total === 0
                  ? 'Every queue your roles cover is clear.'
                  : `${total} ${total === 1 ? 'item is' : 'items are'} waiting across ${stages.length - clearStages} ${stages.length - clearStages === 1 ? 'stage' : 'stages'}.`}
            </p>
          </div>
          <dl className="ops-readouts">
            <div>
              <dt>Waiting</dt>
              <dd>{summary === null ? '—' : total}</dd>
            </div>
            <div>
              <dt>Oldest</dt>
              <dd className={oldest !== null && oldest > 14 ? 'ops-readout-late' : undefined}>{oldest === null ? '—' : ageText(oldest)}</dd>
            </div>
            <div>
              <dt>Stages clear</dt>
              <dd>
                {clearStages}
                <span>/{stages.length}</span>
              </dd>
            </div>
          </dl>
        </section>

        {!me.mfaEnrolled ? (
          <div className="ops-lock" role="status">
            <Icon name="lock" size={1.3} />
            <p>
              <strong>Actions are locked.</strong> Set up two-factor authentication to approve, release or send anything.
            </p>
            <ButtonLink href="/account/security" size="sm">
              Enrol now
            </ButtonLink>
          </div>
        ) : null}

        {stages.length > 0 ? (
          <nav className="ops-line" aria-label="Work by stage">
            <ol>
              {stages.map((stage) => (
                <li key={stage.key}>
                  <button
                    type="button"
                    aria-pressed={stageFilter === stage.key}
                    className={stage.count > 0 ? ageClass(stage.oldest) : 'ops-stage-clear'}
                    onClick={() => setStageFilter((current) => (current === stage.key ? null : stage.key))}
                  >
                    <span className="ops-node" aria-hidden="true">
                      <Icon name={stage.count > 0 ? stage.icon : 'check'} size={1.2} />
                    </span>
                    <span className="ops-stage-count">{stage.count}</span>
                    <span className="ops-stage-label">{stage.label}</span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}

        <div className="ops-columns">
          <section aria-labelledby="ops-worklist" className="ops-worklist">
            <div className="ops-heading">
              <h2 id="ops-worklist">Worklist</h2>
              <p>{stageFilter ? `${STAGES.find((s) => s.key === stageFilter)?.label} only` : 'Oldest first'}</p>
              {stageFilter ? (
                <button type="button" className="ops-link-button" onClick={() => setStageFilter(null)}>
                  Show all
                </button>
              ) : null}
            </div>
            {summary === null ? (
              <Card>
                <LoadingState label="Counting what is waiting" />
              </Card>
            ) : worklist.length === 0 ? (
              <div className="ops-empty">
                <Icon name="checkCircle" size={2} />
                <p className="ops-empty-title">{stageFilter ? 'Nothing waiting in this stage' : 'Nothing is waiting on you'}</p>
                <p>New work appears here as customers submit enquiries, suppliers send evidence and files come up for a decision.</p>
              </div>
            ) : (
              <ol className="ops-rows">
                {worklist.map((queue, index) => {
                  const days = daysWaiting(queue, now.getTime());
                  const stage = stageOf(queue);
                  return (
                    <li key={queue.key} style={{ animationDelay: `${index * 45}ms` }}>
                      <Link href={queue.href} className={`ops-row ${ageClass(days)}`}>
                        <span className="ops-row-count">{queue.count}</span>
                        <span className="ops-row-main">
                          <span className="ops-row-title">{queue.label}</span>
                          <span className="ops-row-detail">{queue.detail}</span>
                        </span>
                        <span className="ops-row-stage">{stage?.label}</span>
                        <span className="ops-row-age">
                          {ageText(days)}
                          <span className="jw-visually-hidden"> oldest waiting</span>
                        </span>
                        <Icon name="chevron" size={1.1} />
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <aside className="ops-side" aria-label="More">
            <section aria-labelledby="ops-clear">
              <div className="ops-heading">
                <h2 id="ops-clear">Clear</h2>
                <p>{clear.length} queues empty</p>
              </div>
              <ul className="ops-clear-list">
                {clear.map((queue) => (
                  <li key={queue.key}>
                    <Link href={queue.href}>{queue.label}</Link>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="ops-jump">
              <div className="ops-heading">
                <h2 id="ops-jump">Jump to</h2>
              </div>
              <ul className="ops-jump">
                <li>
                  <Link href="/suppliers">
                    <Icon name="factory" size={1.1} /> Supplier network
                  </Link>
                </li>
                {isAdministrator ? (
                  <li>
                    <Link href="/organizations">
                      <Icon name="team" size={1.1} /> Organizations &amp; people
                    </Link>
                  </li>
                ) : null}
                <li>
                  <Link href="/audit">
                    <Icon name="search" size={1.1} /> Audit explorer
                  </Link>
                </li>
              </ul>
            </section>

            <section aria-labelledby="ops-session" className="ops-session">
              <div className="ops-heading">
                <h2 id="ops-session">Your session</h2>
              </div>
              <p className="ops-session-name">{me.displayName}</p>
              <p>{me.email}</p>
              <p>{me.roles.join(', ').replace(/_/g, ' ') || 'No roles in this context'}</p>
              <p className={me.mfaEnrolled ? 'ops-session-good' : 'ops-session-warn'}>
                Two-factor {me.mfaEnrolled ? 'enrolled' : 'not enrolled'}
              </p>
            </section>
          </aside>
        </div>
      </div>
    </Page>
  );
}
