'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { CustomerEnquiry } from '@jobwork/contracts';
import { JOB_TYPE_LABELS } from '@jobwork/contracts/constants';
import {
  ActionNeededCard,
  ButtonLink,
  Callout,
  Card,
  CommandButton,
  Inline,
  ReasonField,
  DescriptionList,
  ErrorState,
  LoadingState,
  Page,
  Stack,
  StatusChip,
  TextArea,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';
import { ThreadPanel } from '../../thread-panel';

interface CustomerClarification {
  clarificationId: string;
  topic: string;
  question: string;
  lineNo: number | null;
  status: 'open' | 'answered';
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
}

const TONE: Record<CustomerEnquiry['status'], Tone> = {
  draft: 'neutral',
  requirement_review: 'progress',
  information_needed: 'attention',
  sourcing_in_progress: 'progress',
  closed: 'neutral',
  cancelled: 'neutral',
};

/**
 * The customer's enquiry detail and clarification thread (UC-04).
 *
 * Answering is the only way a submitted requirement changes from this side, and the page
 * says so: the questions are structured, the answers are recorded against them, and what
 * was originally submitted is never edited away.
 */
export default function EnquiryDetailPage() {
  const params = useParams<{ enquiryId: string }>();
  const router = useRouter();
  const enquiryId = params.enquiryId;

  const [enquiry, setEnquiry] = useState<CustomerEnquiry | null>(null);
  const [clarifications, setClarifications] = useState<CustomerClarification[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [withdrawReason, setWithdrawReason] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api<{
        enquiry: CustomerEnquiry;
        clarifications: CustomerClarification[];
      }>(`/enquiries/${enquiryId}`);
      setEnquiry(res.enquiry);
      setClarifications(res.clarifications);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [enquiryId]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = clarifications.filter((c) => c.status === 'open');
  const allAnswered = open.length > 0 && open.every((c) => (answers[c.clarificationId] ?? '').trim().length > 0);

  async function sendAnswers(): Promise<void> {
    await api(`/enquiries/${enquiryId}/clarifications`, {
      method: 'POST',
      body: {
        answers: open.map((c) => ({
          clarificationId: c.clarificationId,
          answer: answers[c.clarificationId],
        })),
      },
      idempotencyKey: `clarify-${enquiryId}-${open.map((c) => c.clarificationId).join('-')}`,
    });
    setAnswers({});
    await load();
  }

  /**
   * Withdrawing and discarding are one command and two different acts: discarding a
   * draft nobody has seen costs nothing, withdrawing a submitted enquiry takes work back
   * off JobWork's desk. The wording follows the act, the version follows the record.
   */
  async function withdraw(): Promise<void> {
    if (!enquiry) return;
    await api(`/enquiries/${enquiryId}/cancel`, {
      method: 'POST',
      body: {
        expectedVersion: enquiry.aggregateVersion,
        reason: withdrawReason.trim() || 'Withdrawn by the customer',
      },
      idempotencyKey: `cancel-${enquiryId}-${enquiry.aggregateVersion}`,
    });
    router.push('/enquiries');
  }

  async function orderAgain(): Promise<void> {
    const copy = await api<{ enquiryId: string }>(`/enquiries/${enquiryId}/copy`, {
      method: 'POST',
      body: {},
      idempotencyKey: crypto.randomUUID(),
    });
    router.push(`/enquiries/new?draft=${copy.enquiryId}`);
  }

  if (!enquiry) {
    return (
      <Page title="Enquiry" back={{ href: '/enquiries', label: 'Back to enquiries' }}>
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

  return (
    <Page
      title={enquiry.title || 'Untitled enquiry'}
      back={{ href: '/enquiries', label: 'Back to enquiries' }}
      meta={
        <>
          <span className="mono">{enquiry.reference ?? 'Draft'}</span>
          <StatusChip tone={TONE[enquiry.status]}>{enquiry.statusLabel}</StatusChip>
        </>
      }
    >
      <Stack gap={4}>
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : null}

        {enquiry.status === 'draft' ? (
          <Card
            title="This enquiry has not been sent yet"
            description="Nobody at JobWork can see it until you send it."
          >
            <Inline gap={2}>
              <ButtonLink href={`/enquiries/new?draft=${enquiryId}`}>Continue editing</ButtonLink>
              <CommandButton variant="danger" receiptLabel="Discarded" onCommand={withdraw}>
                Discard draft
              </CommandButton>
            </Inline>
          </Card>
        ) : enquiry.actionNeeded ? (
          <ActionNeededCard
            title={enquiry.actionNeeded.label}
            detail={enquiry.actionNeeded.detail}
          />
        ) : null}

        <Card title="Summary">
          <DescriptionList
            columns={2}
            items={[
              { label: 'Reference', value: enquiry.reference ?? 'Not yet submitted', mono: true },
              { label: 'Job type', value: JOB_TYPE_LABELS[enquiry.jobType] },
              { label: 'Parts', value: enquiry.itemCount, numeric: true },
              { label: 'Required by', value: enquiry.requiredByDate ?? 'Not stated' },
              {
                label: 'Submitted',
                value: enquiry.submittedAt
                  ? new Date(enquiry.submittedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST'
                  : 'Not yet',
              },
            ]}
          />
        </Card>

        <Card
          title="Questions from JobWork"
          description="Answering adds a new requirement revision. What you originally submitted stays exactly as it was."
        >
          {clarifications.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)' }}>
              No questions so far. We will ask here if anything in your requirement is unclear.
            </p>
          ) : (
            <ol style={{ listStyle: 'none' }}>
              {clarifications.map((clarification) => (
                <li
                  key={clarification.clarificationId}
                  style={{ borderTop: 'var(--hairline) solid var(--color-border)', padding: 'var(--space-3) 0' }}
                >
                  <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                    {clarification.topic}
                    {clarification.lineNo !== null ? ` · line ${clarification.lineNo}` : ''}
                  </p>
                  <p style={{ font: 'var(--text-body-strong)', margin: 'var(--space-1) 0' }}>
                    {clarification.question}
                  </p>
                  {clarification.status === 'answered' ? (
                    <p>{clarification.answer}</p>
                  ) : (
                    <TextArea
                      label={`Your answer`}
                      hint={clarification.question}
                      value={answers[clarification.clarificationId] ?? ''}
                      onChange={(event) =>
                        setAnswers((current) => ({
                          ...current,
                          [clarification.clarificationId]: event.target.value,
                        }))
                      }
                    />
                  )}
                </li>
              ))}
            </ol>
          )}

          {open.length > 0 ? (
            <CommandButton
              onCommand={sendAnswers}
              receiptLabel="Answers sent"
              disabled={!allAnswered}
              disabledReason="Answer every question before sending — a partial reply leaves sourcing waiting."
            >
              Send {open.length === 1 ? 'answer' : 'answers'}
            </CommandButton>
          ) : null}
        </Card>

        {enquiry.status !== 'draft' ? (
          <Card
            title="Anything else?"
            description="Order the same thing again, or take this one back."
          >
            <Inline gap={2}>
              <CommandButton variant="secondary" receiptLabel="Copied" onCommand={orderAgain}>
                Order this again
              </CommandButton>
            </Inline>

            {enquiry.status === 'requirement_review' || enquiry.status === 'information_needed' ? (
              <div style={{ marginTop: 'var(--space-4)' }}>
                <Callout tone="neutral" title="Withdrawing stops the work">
                  We stop reviewing it and nothing is sourced. You can raise it again later —
                  “Order this again” keeps a copy of everything you wrote.
                </Callout>
                <ReasonField
                  label="Why are you withdrawing it?"
                  audience="internal"
                  value={withdrawReason}
                  onChange={setWithdrawReason}
                />
                <CommandButton variant="danger" receiptLabel="Withdrawn" onCommand={withdraw}>
                  Withdraw enquiry
                </CommandButton>
              </div>
            ) : null}
          </Card>
        ) : null}
        {enquiry.status !== 'draft' ? (
          <ThreadPanel contextType="enquiry" contextId={enquiryId} description="Questions and answers about this enquiry, between you and JobWork." />
        ) : null}
      </Stack>
    </Page>
  );
}
