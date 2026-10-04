'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { ReviewQueueItem } from '@jobwork/contracts';
import {
  Card,
  CommandButton,
  CopyableId,
  DescriptionList,
  EmptyState,
  ErrorState,
  Inline,
  LiveRegion,
  LoadingState,
  Page,
  Stack,
  StatusChip,
  TextInput,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * Supplier verification review queue (doc 06 §14, F-04.2).
 *
 * The reviewer's two acts are deliberately asymmetric: verifying asks for the expiry the
 * evidence itself shows, and returning demands a reason the supplier can act on — a
 * rejection without one is not a decision, it is a dead end.
 */
export default function VerificationQueuePage() {
  const [items, setItems] = useState<ReviewQueueItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [expiries, setExpiries] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ items: ReviewQueueItem[] }>('/suppliers/verification/queue');
      setItems(res.items);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(item: ReviewQueueItem, decision: 'verify' | 'return'): Promise<void> {
    const reason = reasons[item.verificationItemId]?.trim();
    const expiresAt = expiries[item.verificationItemId];
    await api(`/suppliers/verification/${item.verificationItemId}/review`, {
      method: 'POST',
      idempotencyKey: `review:${item.verificationItemId}:${decision}`,
      body: {
        decision,
        ...(reason ? { reason } : {}),
        ...(decision === 'verify' && expiresAt
          ? { expiresAt: new Date(`${expiresAt}T00:00:00Z`).toISOString() }
          : {}),
      },
    });
    setNotice(
      decision === 'verify'
        ? `${item.organizationName}: ${item.kind} verified.`
        : `${item.organizationName}: ${item.kind} returned for evidence.`,
    );
    await load();
  }

  return (
    <Page
      title="Supplier verification"
      description="Evidence waiting on a reviewer. You cannot decide an item you submitted, and a verified item stops counting the moment its stored expiry passes."
      width="wide"
    >
      <Stack gap={4}>
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : null}
        {notice ? <LiveRegion message={notice} /> : null}

        {items === null ? (
          <Card>
            <LoadingState label="Loading the review queue" />
          </Card>
        ) : items.length === 0 ? (
          <Card>
            <EmptyState
              title="Nothing waiting for review"
              detail="Items appear here when a supplier submits or renews evidence. Expiring items are swept in automatically as their dates approach."
            />
          </Card>
        ) : (
          items.map((item) => (
            <Card
              key={item.verificationItemId}
              title={
                <Link href={`/suppliers/${item.supplierProfileId}`}>{item.organizationName}</Link>
              }
              description={`${item.kind.replace(/_/g, ' ')} · version ${item.versionNo} · ${
                item.submittedAt
                  ? new Date(item.submittedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST'
                  : 'not submitted'
              }`}
              actions={
                <StatusChip tone={item.status === 'under_review' ? 'progress' : 'neutral'}>
                  {item.status.replace(/_/g, ' ')}
                </StatusChip>
              }
            >
              <DescriptionList
                columns={2}
                items={[
                  { label: 'Reference', value: item.referenceValue ?? '—', mono: true },
                  {
                    label: 'Evidence',
                    value: item.evidenceDocumentVersionId ? (
                      <CopyableId value={item.evidenceDocumentVersionId} label="Evidence version" />
                    ) : (
                      <span style={{ color: 'var(--color-text-muted)' }}>none attached</span>
                    ),
                  },
                  {
                    label: 'Declared expiry',
                    value: item.expiresAt
                      ? new Date(item.expiresAt).toLocaleDateString('en-IN')
                      : '—',
                  },
                ]}
              />

              <div style={{ marginTop: 'var(--space-4)' }}>
                <Inline gap={3} align="flex-end">
                  <div style={{ width: 200 }}>
                    <TextInput
                      label="Expiry on the document"
                      hint="What the evidence itself says."
                      type="date"
                      value={expiries[item.verificationItemId] ?? ''}
                      onChange={(event) =>
                        setExpiries((prev) => ({
                          ...prev,
                          [item.verificationItemId]: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 'var(--field-min-width)' }}>
                    <TextInput
                      label="Reason"
                      hint="Required to return. The supplier reads this and acts on it."
                      placeholder="What the supplier must fix"
                      value={reasons[item.verificationItemId] ?? ''}
                      onChange={(event) =>
                        setReasons((prev) => ({
                          ...prev,
                          [item.verificationItemId]: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <div style={{ marginBottom: 'var(--space-4)' }}>
                    <Inline gap={2}>
                      <CommandButton
                        receiptLabel="Verified"
                        onCommand={() => decide(item, 'verify')}
                      >
                        Verify
                      </CommandButton>
                      <CommandButton
                        variant="secondary"
                        receiptLabel="Returned"
                        disabled={!(reasons[item.verificationItemId] ?? '').trim()}
                        disabledReason="Returning evidence requires a reason the supplier can act on"
                        onCommand={() => decide(item, 'return')}
                      >
                        Return for evidence
                      </CommandButton>
                    </Inline>
                  </div>
                </Inline>
              </div>
            </Card>
          ))
        )}
      </Stack>
    </Page>
  );
}
