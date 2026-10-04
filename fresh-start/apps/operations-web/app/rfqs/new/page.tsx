'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { MatchResult } from '@jobwork/contracts';
import {
  ButtonLink,
  Callout,
  Card,
  Checkbox,
  CommandButton,
  DataTable,
  ErrorState,
  Inline,
  LoadingState,
  Page,
  Select,
  Stack,
  StatusChip,
  TextArea,
  TextInput,
  type Column,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * The matcher and round builder (F-06.2). Three things happen here in order: see who the
 * hard filter passes *and why it failed everyone else*, build a shortlist, and release.
 *
 * The excluded suppliers are shown deliberately. A matcher that only lists winners
 * teaches sourcing nothing about why the network is thin for this job, and it hides the
 * one case worth arguing with — a supplier excluded for a reason that no longer holds.
 */
export default function NewRfqPage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <Page title="Source this enquiry" width="wide">
          <Card>
            <LoadingState label="Matching suppliers" />
          </Card>
        </Page>
      }
    >
      <RoundBuilder />
    </Suspense>
  );
}

function RoundBuilder(): React.JSX.Element {
  const router = useRouter();
  const enquiryId = useSearchParams().get('enquiryId') ?? '';
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [deadline, setDeadline] = useState(
    new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
  );
  const [latePolicy, setLatePolicy] = useState<'reject' | 'accept_flagged'>('reject');
  const [instructions, setInstructions] = useState('');

  const load = useCallback(async () => {
    if (!enquiryId) return;
    setError(null);
    try {
      setMatch(await api<MatchResult>(`/rfqs/match?enquiryId=${enquiryId}`));
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [enquiryId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <Page title="Source this enquiry" breadcrumb={<Link href="/intake">← Intake</Link>}>
        <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
      </Page>
    );
  }

  if (!match) {
    return (
      <Page title="Source this enquiry" breadcrumb={<Link href="/intake">← Intake</Link>}>
        <Card>
          <LoadingState label="Matching suppliers" />
        </Card>
      </Page>
    );
  }

  const chosen = match.candidates.filter((candidate) => selected[candidate.supplierProfileId]);
  const overriddenWithoutReason = chosen.filter(
    (candidate) => !candidate.eligible && (overrides[candidate.supplierProfileId] ?? '').trim().length < 3,
  );

  const columns: Array<Column<MatchResult['candidates'][number]>> = [
    {
      key: 'pick',
      header: 'Invite',
      render: (candidate) => (
        <Checkbox
          label={`Invite ${candidate.displayName}`}
          checked={Boolean(selected[candidate.supplierProfileId])}
          onChange={(event) =>
            setSelected({ ...selected, [candidate.supplierProfileId]: event.target.checked })
          }
        />
      ),
    },
    { key: 'name', header: 'Supplier', render: (candidate) => candidate.displayName },
    {
      key: 'region',
      header: 'Region',
      render: (candidate) => candidate.regionClass.replace(/_/g, ' '),
    },
    {
      key: 'verdict',
      header: 'Hard filter',
      render: (candidate) =>
        candidate.eligible ? (
          <StatusChip tone="positive">passes</StatusChip>
        ) : (
          <StatusChip tone="blocked">{candidate.exclusions.join(', ').replace(/_/g, ' ')}</StatusChip>
        ),
    },
    {
      key: 'override',
      header: 'Override reason',
      render: (candidate) =>
        !candidate.eligible && selected[candidate.supplierProfileId] ? (
          <TextInput
            label={`Why invite ${candidate.displayName} anyway`}
            value={overrides[candidate.supplierProfileId] ?? ''}
            onChange={(event) =>
              setOverrides({ ...overrides, [candidate.supplierProfileId]: event.target.value })
            }
          />
        ) : (
          <span style={{ color: 'var(--color-text-muted)' }}>—</span>
        ),
    },
  ];

  return (
    <Page
      title="Source this enquiry"
      breadcrumb={<Link href={`/intake/${enquiryId}`}>← Enquiry</Link>}
      description={`Hard filter ${match.configVersion}. ${match.eligibleCount} of ${match.candidates.length} suppliers pass for ${match.requiredCapabilityCodes.join(', ') || 'this work'}.`}
      width="wide"
    >
      <Stack gap={4}>
        {match.eligibleCount === 0 ? (
          <Callout tone="attention" title="Nobody passes the filter for this job">
            Every supplier is listed below with the reason. Either fix the reason — usually
            lapsed evidence — or invite somebody with a recorded override.
          </Callout>
        ) : null}

        <Card title="Suppliers" description="Everyone considered, and why each was or was not." flush>
          <DataTable
            caption="Match candidates with their hard-filter verdict"
            columns={columns}
            rows={match.candidates}
            rowKey={(candidate) => candidate.supplierProfileId}
            stackTitle={(candidate) => candidate.displayName}
          />
        </Card>

        <Card title="The round">
          <TextInput
            label="Bids close on"
            type="date"
            required
            value={deadline}
            onChange={(event) => setDeadline(event.target.value)}
          />
          <Select
            label="Late bids"
            hint="Decided now, in writing, rather than argued about on the day."
            value={latePolicy}
            options={[
              { value: 'reject', label: 'Refuse anything after the deadline' },
              { value: 'accept_flagged', label: 'Accept but flag as late' },
            ]}
            onChange={(event) => setLatePolicy(event.target.value as 'reject' | 'accept_flagged')}
          />
          <TextArea
            label="Instructions to suppliers"
            hint="Seen by every invited supplier. Never name the customer here."
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />

          {overriddenWithoutReason.length > 0 ? (
            <Callout tone="blocked" title="An override needs a reason">
              {overriddenWithoutReason.map((candidate) => candidate.displayName).join(', ')} did not
              pass the filter. Say why they are being invited anyway.
            </Callout>
          ) : null}

          <Inline gap={2}>
            <CommandButton
              receiptLabel="Released"
              disabled={chosen.length === 0 || overriddenWithoutReason.length > 0}
              onCommand={async () => {
                setError(null);
                try {
                  const created = await api<{ rfqId: string }>('/rfqs', {
                    method: 'POST',
                    body: {
                      enquiryId,
                      deadlineAt: new Date(`${deadline}T17:00:00`).toISOString(),
                      lateBidPolicy: latePolicy,
                      instructions,
                    },
                    idempotencyKey: crypto.randomUUID(),
                  });
                  for (const candidate of chosen) {
                    await api(`/rfqs/${created.rfqId}/invitations`, {
                      method: 'POST',
                      body: {
                        supplierProfileId: candidate.supplierProfileId,
                        ...(candidate.eligible
                          ? {}
                          : { overrideReason: overrides[candidate.supplierProfileId] }),
                      },
                      idempotencyKey: crypto.randomUUID(),
                    });
                  }
                  const detail = await api<{ rfq: { aggregateVersion: number } }>(
                    `/rfqs/${created.rfqId}`,
                  );
                  await api(`/rfqs/${created.rfqId}/release`, {
                    method: 'POST',
                    body: { expectedVersion: detail.rfq.aggregateVersion },
                    idempotencyKey: crypto.randomUUID(),
                  });
                  router.push(`/rfqs/${created.rfqId}`);
                } catch (err) {
                  if (err instanceof ApiError) setError(err);
                  throw err;
                }
              }}
            >
              Release to {chosen.length} supplier{chosen.length === 1 ? '' : 's'}
            </CommandButton>
            <ButtonLink href={`/intake/${enquiryId}`} variant="secondary">Cancel</ButtonLink>
          </Inline>
        </Card>
      </Stack>
    </Page>
  );
}
