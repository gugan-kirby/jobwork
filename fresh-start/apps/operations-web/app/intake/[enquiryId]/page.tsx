'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ClarificationTopic, CompletenessFlag, Enquiry, RequirementRevision } from '@jobwork/contracts';
import { JOB_TYPE_LABELS } from '@jobwork/contracts/constants';
import {
  Button,
  ButtonLink,
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
  ReasonField,
  Select,
  SplitPane,
  Stack,
  StatusChip,
  TextArea,
  type Column,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';
import { ThreadPanel } from '../../thread-panel';

const TOPICS: ClarificationTopic[] = [
  'material',
  'tolerance',
  'quantity',
  'documents',
  'quality',
  'delivery',
  'commercial',
  'other',
];

interface IntakeDetail {
  enquiry: Enquiry;
  completeness: CompletenessFlag[];
  revisions: RequirementRevision[];
  documentTypes: Record<string, string>;
}

/**
 * The doc 14 §6 intake workspace: requirement on the left, checklist and named commands
 * on the right, revision history underneath.
 *
 * The checklist comes from the API, not from this page. A reviewer must never be able to
 * approve something the server would refuse, and equally must never be blocked by a rule
 * the UI invented — so both sides read the same computed flags. Every action is a
 * `CommandButton`, because each one is a named command with a version guard behind it.
 */
export default function IntakeDetailPage() {
  const params = useParams<{ enquiryId: string }>();
  const enquiryId = params.enquiryId;

  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [questions, setQuestions] = useState<
    Array<{ topic: ClarificationTopic; question: string }>
  >([{ topic: 'material', question: '' }]);
  const [governing, setGoverning] = useState('');
  const [declineReason, setDeclineReason] = useState('');

  const load = useCallback(async () => {
    try {
      setDetail(await api<IntakeDetail>(`/intake/${enquiryId}`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [enquiryId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (path: string, body: Record<string, unknown> = {}): Promise<void> => {
      if (!detail) return;
      await api(`/intake/${enquiryId}/${path}`, {
        method: 'POST',
        body: { expectedVersion: detail.enquiry.aggregateVersion, ...body },
        idempotencyKey: `${path}-${enquiryId}-${detail.enquiry.aggregateVersion}`,
      });
      await load();
    },
    [detail, enquiryId, load],
  );

  if (!detail) {
    return (
      <Page title="Enquiry" breadcrumb={<Link href="/intake">← Intake queue</Link>} width="wide">
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : (
          <Card>
            <LoadingState label="Loading this enquiry" />
          </Card>
        )}
      </Page>
    );
  }

  const { enquiry, completeness, revisions, documentTypes } = detail;
  const blocking = completeness.filter((flag) => flag.severity === 'blocking');
  const openQuestions = enquiry.clarifications.filter((c) => c.status === 'open');
  const hasConflict = completeness.some((flag) => flag.code === 'cad_2d_conflict');

  const revisionColumns: ReadonlyArray<Column<RequirementRevision>> = [
    { key: 'no', header: '#', render: (r) => r.revisionNo, numeric: true },
    { key: 'kind', header: 'Kind', render: (r) => r.kind },
    {
      key: 'frozen',
      header: 'Frozen',
      render: (r) => r.frozenAt.slice(0, 19).replace('T', ' ') + ' UTC',
    },
    { key: 'hash', header: 'Hash', render: (r) => <CopyableId value={r.contentHash} label="Content hash" /> },
  ];

  return (
    <Page
      title={enquiry.title}
      breadcrumb={<Link href="/intake">← Intake queue</Link>}
      width="wide"
      meta={
        <>
          <span className="mono">{enquiry.reference}</span>
          <StatusChip tone={enquiry.status === 'approved_for_sourcing' ? 'positive' : 'progress'}>
            {enquiry.status.replace(/_/g, ' ')}
          </StatusChip>
          <StatusChip tone={enquiry.jobType === 'correction_ecn' ? 'attention' : 'neutral'} silent>
            {JOB_TYPE_LABELS[enquiry.jobType]}
          </StatusChip>
          {enquiry.assistedIntake ? <StatusChip tone="special">assisted intake</StatusChip> : null}
          <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
            revision {enquiry.currentRevisionNo} (submitted as {enquiry.submittedRevisionNo}) ·{' '}
            {enquiry.confidentiality.replace(/_/g, ' ')}
          </span>
        </>
      }
    >
      <Stack gap={4}>
        {enquiry.status === 'approved_for_sourcing' ? (
          <Callout tone="positive" title="Approved — ready to source">
            <Inline gap={3}>
              <span>The requirement is frozen and suppliers can be matched against it.</span>
              <ButtonLink href={`/rfqs/new?enquiryId=${enquiryId}`} size="sm">
                Start a sourcing round
              </ButtonLink>
            </Inline>
          </Callout>
        ) : null}

        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : null}

        <SplitPane
          main={
            <>
              <Card title="Requirement">
                <DescriptionList
                  columns={2}
                  items={[
                    { label: 'Job type', value: JOB_TYPE_LABELS[enquiry.jobType] },
                    {
                      label: 'Material',
                      value:
                        enquiry.materialSupply === 'customer_supplied'
                          ? 'Supplied by the customer (job-work custody)'
                          : 'To be sourced',
                    },
                    ...(enquiry.jobType === 'correction_ecn'
                      ? [
                          {
                            label: 'Change reference',
                            value: enquiry.changeReference || '—',
                            mono: true,
                          },
                          {
                            label: 'Corrects',
                            value: enquiry.relatedEnquiryId ? (
                              <Link href={`/intake/${enquiry.relatedEnquiryId}`}>
                                enquiry on file
                              </Link>
                            ) : (
                              'nothing on file'
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
                {enquiry.jobType === 'correction_ecn' && enquiry.changeDescription ? (
                  <p style={{ margin: 'var(--space-3) 0' }}>
                    <strong>What changed:</strong> {enquiry.changeDescription}
                  </p>
                ) : null}
                <p style={{ margin: 'var(--space-3) 0' }}>
                  {enquiry.applicationNote || <em>No application note.</em>}
                </p>
                {enquiry.items.map((item) => (
                  <div
                    key={item.enquiryItemId}
                    style={{
                      borderTop: 'var(--hairline) solid var(--color-border)',
                      paddingTop: 'var(--space-3)',
                      marginTop: 'var(--space-3)',
                    }}
                  >
                    <p style={{ font: 'var(--text-body-strong)', marginBottom: 'var(--space-2)' }}>
                      Line {item.lineNo} — {item.partName || 'unnamed'}
                    </p>
                    {item.description ? (
                      <p style={{ marginBottom: 'var(--space-2)' }}>{item.description}</p>
                    ) : null}
                    <DescriptionList
                      columns={2}
                      items={[
                        {
                          label: 'Quantities',
                          value:
                            item.quantityBreakpoints
                              .map((bp) => `${bp.quantity} ${bp.unit} (${bp.kind})`)
                              .join(' · ') || '—',
                          numeric: true,
                        },
                        { label: 'Material', value: item.materialGrade ?? '—' },
                        {
                          label: 'Tolerance',
                          value: `${item.toleranceClass ?? '—'}${
                            item.criticalTolerance
                              ? ` · ${item.criticalTolerance.value} ${item.criticalTolerance.unit}`
                              : ''
                          }`,
                          numeric: true,
                        },
                        { label: 'Inspection', value: item.inspectionLevel.replace(/_/g, ' ') },
                      ]}
                    />
                  </div>
                ))}
              </Card>

              <Card title="Documents">
                {enquiry.documents.length === 0 ? (
                  <p style={{ color: 'var(--color-text-muted)' }}>Nothing attached.</p>
                ) : (
                  <ul style={{ listStyle: 'none' }}>
                    {enquiry.documents.map((doc) => (
                      <li
                        key={doc.enquiryDocumentId}
                        style={{
                          display: 'flex',
                          gap: 'var(--space-3)',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          padding: 'var(--space-2) 0',
                          borderTop: 'var(--hairline) solid var(--color-border)',
                        }}
                      >
                        <CopyableId value={doc.documentVersionId} label="Document version" />
                        <span>{(documentTypes[doc.documentVersionId] ?? 'unknown').replace(/_/g, ' ')}</span>
                        <StatusChip tone={doc.role === 'governing' ? 'progress' : 'neutral'} silent>
                          {doc.role.replace(/_/g, ' ')}
                        </StatusChip>
                        {doc.lineNo !== null ? (
                          <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                            line {doc.lineNo}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card title="Requirement revisions" flush>
                <DataTable
                  caption="Frozen requirement revisions, oldest first"
                  columns={revisionColumns}
                  rows={revisions}
                  rowKey={(revision) => revision.requirementId}
                  stackTitle={(revision) => `Revision ${revision.revisionNo} (${revision.kind})`}
                  empty={{
                    title: 'No frozen revisions',
                    detail: 'A revision is frozen when the customer submits.',
                  }}
                />
              </Card>
            </>
          }
          side={
            <>
              <Card title="Completeness">
                {completeness.length === 0 ? (
                  <p style={{ color: 'var(--status-positive-fg)' }}>Nothing outstanding.</p>
                ) : (
                  <Stack gap={2}>
                    {completeness.map((flag, index) => (
                      <div key={`${flag.code}-${flag.lineNo ?? 'all'}-${index}`}>
                        <StatusChip tone={flag.severity === 'blocking' ? 'blocked' : 'attention'}>
                          {flag.severity}
                        </StatusChip>{' '}
                        <span style={{ font: 'var(--text-caption)' }}>
                          {flag.label}
                          {flag.lineNo !== null ? ` (line ${flag.lineNo})` : ''}
                        </span>
                      </div>
                    ))}
                  </Stack>
                )}
              </Card>

              <Card title="Actions">
                {enquiry.status === 'submitted' ? (
                  <CommandButton onCommand={() => run('triage')} receiptLabel="Triage started">
                    Start triage
                  </CommandButton>
                ) : null}

                {enquiry.status === 'under_review' ? (
                  <Stack gap={5}>
                    <div>
                      <h3 style={{ font: 'var(--text-body-strong)', marginBottom: 'var(--space-2)' }}>
                        Ask the customer
                      </h3>
                      {questions.map((question, index) => (
                        <div key={index}>
                          <Select
                            label={`Topic ${index + 1}`}
                            value={question.topic}
                            options={TOPICS.map((topic) => ({ value: topic, label: topic }))}
                            onChange={(event) =>
                              setQuestions((current) =>
                                current.map((q, i) =>
                                  i === index
                                    ? { ...q, topic: event.target.value as ClarificationTopic }
                                    : q,
                                ),
                              )
                            }
                          />
                          <TextArea
                            label={`Question ${index + 1}`}
                            value={question.question}
                            onChange={(event) =>
                              setQuestions((current) =>
                                current.map((q, i) =>
                                  i === index ? { ...q, question: event.target.value } : q,
                                ),
                              )
                            }
                          />
                        </div>
                      ))}
                      <Inline gap={2}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            setQuestions((current) => [...current, { topic: 'other', question: '' }])
                          }
                        >
                          Add a question
                        </Button>
                        <CommandButton
                          receiptLabel="Questions sent"
                          disabled={questions.every((q) => q.question.trim() === '')}
                          disabledReason="Write at least one question"
                          onCommand={async () => {
                            await run('clarifications', {
                              questions: questions.filter((q) => q.question.trim() !== ''),
                            });
                            setQuestions([{ topic: 'material', question: '' }]);
                          }}
                        >
                          Send questions
                        </CommandButton>
                      </Inline>
                    </div>

                    <div>
                      <h3 style={{ font: 'var(--text-body-strong)', marginBottom: 'var(--space-2)' }}>
                        Approve for sourcing
                      </h3>
                      {hasConflict ? (
                        <Select
                          label="Which document governs?"
                          hint="A CAD file and a drawing are both attached. Sourcing needs one declared authority."
                          value={governing}
                          placeholder="Choose one"
                          options={enquiry.documents.map((doc) => ({
                            value: doc.documentVersionId,
                            label: `${(documentTypes[doc.documentVersionId] ?? 'document').replace(/_/g, ' ')} · ${doc.documentVersionId.slice(0, 8)}`,
                          }))}
                          onChange={(event) => setGoverning(event.target.value)}
                        />
                      ) : null}
                      <CommandButton
                        receiptLabel="Approved"
                        disabled={blocking.length > 0 && !(hasConflict && governing && blocking.length === 1)}
                        disabledReason={`Resolve ${blocking.length} blocking checklist item${blocking.length === 1 ? '' : 's'} first`}
                        onCommand={() =>
                          run('approve', governing ? { governingDocumentVersionId: governing } : {})
                        }
                      >
                        Approve for sourcing
                      </CommandButton>
                    </div>

                    <div>
                      <h3 style={{ font: 'var(--text-body-strong)', marginBottom: 'var(--space-2)' }}>
                        Decline
                      </h3>
                      <ReasonField
                        audience="customer"
                        value={declineReason}
                        onChange={setDeclineReason}
                      />
                      <CommandButton
                        variant="danger"
                        receiptLabel="Declined"
                        disabled={declineReason.trim().length < 10}
                        disabledReason="A decline needs a reason the customer can act on"
                        onCommand={() => run('decline', { reason: declineReason })}
                      >
                        Decline enquiry
                      </CommandButton>
                    </div>
                  </Stack>
                ) : null}

                {enquiry.status === 'clarification_required' ? (
                  <p>
                    Waiting on the customer — {openQuestions.length} question
                    {openQuestions.length === 1 ? '' : 's'} open. It returns to review when they
                    answer.
                  </p>
                ) : null}

                {enquiry.status === 'approved_for_sourcing' ? (
                  <p style={{ color: 'var(--status-positive-fg)' }}>
                    Approved. Revision {enquiry.currentRevisionNo} is what sourcing quotes against.
                  </p>
                ) : null}

                {enquiry.status === 'closed' ? <p>Declined: {enquiry.decisionReason}</p> : null}
              </Card>

              <Card title="Clarification thread">
                {enquiry.clarifications.length === 0 ? (
                  <p style={{ color: 'var(--color-text-muted)' }}>Nothing asked yet.</p>
                ) : (
                  <ol style={{ paddingLeft: 'var(--space-4)', font: 'var(--text-caption)' }}>
                    {enquiry.clarifications.map((clarification) => (
                      <li key={clarification.clarificationId} style={{ marginBottom: 'var(--space-3)' }}>
                        <strong>
                          R{clarification.roundNo} · {clarification.topic}
                        </strong>{' '}
                        <span style={{ color: 'var(--color-text-muted)' }}>
                          (against revision {clarification.askedAgainstRevisionNo})
                        </span>
                        <p style={{ margin: 'var(--space-1) 0' }}>{clarification.question}</p>
                        {clarification.answer ? (
                          <p style={{ margin: 0 }}>{clarification.answer}</p>
                        ) : (
                          <StatusChip tone="attention">awaiting answer</StatusChip>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            </>
          }
        />
        <ThreadPanel contextType="enquiry" contextId={enquiryId} title="Conversation with the customer" />
      </Stack>
    </Page>
  );
}
