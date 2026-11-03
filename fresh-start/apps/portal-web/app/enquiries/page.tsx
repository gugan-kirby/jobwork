'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CustomerEnquiry } from '@jobwork/contracts';
import {
  ActionNeededCard,
  Button,
  ButtonLink,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  FilterChips,
  Icon,
  IconTextInput,
  LoadingState,
  Page,
  RecordCard,
  RecordList,
  Stack,
  Select,
  StatusChip,
  type IconName,
  type RecordTint,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * The customer's enquiry list (prototype tile 8, doc 14 §4): a chip row to filter by
 * curated status and one card per enquiry. Everything rendered here comes from the
 * curated projection, so there is no internal state, no supplier and no cost on this
 * page — not even in a payload someone opens the network tab to read.
 */

const TONE: Record<CustomerEnquiry['status'], Tone> = {
  draft: 'neutral',
  requirement_review: 'progress',
  information_needed: 'attention',
  sourcing_in_progress: 'progress',
  closed: 'neutral',
  cancelled: 'neutral',
};

type Filter = 'all' | 'draft' | 'requirement_review' | 'information_needed' | 'sourcing_in_progress' | 'closed';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'information_needed', label: 'Needs you' },
  { value: 'requirement_review', label: 'In review' },
  { value: 'sourcing_in_progress', label: 'Sourcing' },
  { value: 'draft', label: 'Drafts' },
  { value: 'closed', label: 'Closed' },
];

/** VF-08: each job type gets the reference's tinted tile. */
const JOB_TILE: Record<CustomerEnquiry['jobType'], { name: IconName; tint: RecordTint }> = {
  job_work: { name: 'settings', tint: 'blue' },
  new_model: { name: 'layers', tint: 'violet' },
  correction_ecn: { name: 'hexagon', tint: 'orange' },
};

type Sort = 'newest' | 'oldest' | 'name';

const SORTS: Array<{ value: Sort; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Part name, A to Z' },
];

const stamp = (e: CustomerEnquiry): number => Date.parse(e.submittedAt ?? e.updatedAt);

/** A draft is unfinished work: it opens where the work happens. */
function enquiryHref(enquiry: CustomerEnquiry): string {
  return enquiry.status === 'draft' ? `/enquiries/new?draft=${enquiry.enquiryId}` : `/enquiries/${enquiry.enquiryId}`;
}

function when(enquiry: CustomerEnquiry): string {
  const iso = enquiry.submittedAt ?? enquiry.updatedAt;
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

export default function EnquiriesPage() {
  const [enquiries, setEnquiries] = useState<CustomerEnquiry[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [showOptions, setShowOptions] = useState(false);

  useEffect(() => {
    api<{ enquiries: CustomerEnquiry[] }>(`/enquiries${includeCancelled ? '?includeCancelled=true' : ''}`)
      .then((res) => setEnquiries(res.enquiries))
      // Deliberately leaves `enquiries` null: a failed request is not an empty list,
      // and the page must not claim "no enquiries yet" about data it never received.
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, [includeCancelled]);

  const all = enquiries ?? [];
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of all) map.set(e.status, (map.get(e.status) ?? 0) + 1);
    return map;
  }, [all]);

  const needle = search.trim().toLowerCase();
  const visible = all.filter((e) => {
    if (filter !== 'all' && e.status !== filter && !(filter === 'closed' && e.status === 'cancelled')) return false;
    if (!needle) return true;
    return `${e.reference ?? ''} ${e.title} ${e.jobTypeLabel}`.toLowerCase().includes(needle);
  });
  visible.sort((a, b) =>
    sort === 'name'
      ? (a.title || '').localeCompare(b.title || '')
      : sort === 'oldest'
        ? stamp(a) - stamp(b)
        : stamp(b) - stamp(a),
  );
  const needingAction = all.filter((e) => e.actionNeeded?.kind === 'answer_questions');
  const drafts = all.filter((e) => e.status === 'draft');

  return (
    <Page
      title="My Enquiries"
      description="Track and manage all your enquiries"
      actions={
        <span className="jw-desktop-only">
          <ButtonLink href="/enquiries/new" size="sm">New enquiry</ButtonLink>
        </span>
      }
    >
      <Stack gap={4}>
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : null}

        <div className="jw-search-row">
          <IconTextInput
            icon="search"
            label="Search enquiries…"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className="jw-square-button"
            aria-label="Sort enquiries"
            aria-expanded={showOptions}
            aria-controls="enquiry-sort"
            onClick={() => setShowOptions((open) => !open)}
          >
            <Icon name="sliders" size={1.5} />
          </button>
        </div>

        {showOptions ? (
          <div id="enquiry-sort">
            <Select
              label="Sort by"
              value={sort}
              options={SORTS}
              onChange={(event) => setSort(event.target.value as Sort)}
            />
          </div>
        ) : null}

        <FilterChips
          label="Filter enquiries by status"
          value={filter}
          options={FILTERS.map((f) => ({
            ...f,
            count: f.value === 'all' ? all.length : f.value === 'closed' ? (counts.get('closed') ?? 0) + (counts.get('cancelled') ?? 0) : counts.get(f.value) ?? 0,
          }))}
          onChange={setFilter}
        />

        {filter === 'all' && drafts.length > 0 ? (
          <Callout tone="attention" title={`${drafts.length} unfinished ${drafts.length === 1 ? 'enquiry' : 'enquiries'}`}>
            You started {drafts.length === 1 ? 'one' : `${drafts.length}`} and did not send{' '}
            {drafts.length === 1 ? 'it' : 'them'}. Continue where you left off, or open one and discard it.
          </Callout>
        ) : null}

        {filter === 'all' || filter === 'information_needed'
          ? needingAction.map((enquiry) => (
              <ActionNeededCard
                key={enquiry.enquiryId}
                title={enquiry.actionNeeded!.label}
                detail={enquiry.actionNeeded!.detail}
                action={
                  <ButtonLink href={`/enquiries/${enquiry.enquiryId}`} size="sm">
                    Answer questions
                  </ButtonLink>
                }
              />
            ))
          : null}

        {error ? null : enquiries === null ? (
          <Card>
            <LoadingState label="Loading your enquiries" />
          </Card>
        ) : visible.length === 0 ? (
          <Card>
            <EmptyState
              title={all.length === 0 ? 'No enquiries yet' : 'Nothing matches'}
              detail={
                all.length === 0
                  ? 'An enquiry is how you tell us what you need made. Start one and we will come back with questions or a quotation.'
                  : 'Try another filter or clear the search.'
              }
              action={
                all.length === 0 ? (
                  <ButtonLink href="/enquiries/new">Create your first enquiry</ButtonLink>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <RecordList>
            {visible.map((enquiry) => (
              <RecordCard
                key={enquiry.enquiryId}
                href={enquiryHref(enquiry)}
                reference={enquiry.reference ?? ''}
                title={enquiry.title || 'Untitled enquiry'}
                caption={`${enquiry.jobTypeLabel} • ${enquiry.itemCount} ${enquiry.itemCount === 1 ? 'part' : 'parts'}`}
                status={<StatusChip tone={TONE[enquiry.status]}>{enquiry.statusLabel}</StatusChip>}
                icon={JOB_TILE[enquiry.jobType]}
                date={when(enquiry)}
              />
            ))}
          </RecordList>
        )}

        <p style={{ textAlign: 'center' }}>
          <Button variant="ghost" size="sm" onClick={() => setIncludeCancelled((show) => !show)}>
            {includeCancelled ? 'Hide withdrawn' : 'Show withdrawn'}
          </Button>
        </p>
      </Stack>
    </Page>
  );
}
