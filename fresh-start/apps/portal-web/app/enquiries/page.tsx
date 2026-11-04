'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CapabilityRef, CustomerEnquiry, CustomerQuoteListItem } from '@jobwork/contracts';
import {
  ButtonLink,
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
  Select,
  Stack,
  StatusChip,
  type IconName,
  type RecordTint,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * My Enquiries (VF-08, VF-18, reference screen 08): search, All · In Progress · Quoted ·
 * Closed, and one card per enquiry. Quoted means JobWork has sent a quotation for it. An
 * enquiry waiting on the customer keeps its own status on the card, because that is the
 * one thing they have to act on.
 */

type Filter = 'all' | 'in_progress' | 'quoted' | 'closed';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'quoted', label: 'Quoted' },
  { value: 'closed', label: 'Closed' },
];

const TILES: Array<{ name: IconName; tint: RecordTint }> = [
  { name: 'settings', tint: 'blue' },
  { name: 'layers', tint: 'violet' },
  { name: 'hexagon', tint: 'orange' },
  { name: 'capabilities', tint: 'sky' },
];

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

function bucket(enquiry: CustomerEnquiry, quoted: Set<string>): Exclude<Filter, 'all'> {
  if (enquiry.status === 'closed' || enquiry.status === 'cancelled') return 'closed';
  return enquiry.reference && quoted.has(enquiry.reference) ? 'quoted' : 'in_progress';
}

function chip(enquiry: CustomerEnquiry, state: Exclude<Filter, 'all'>): { tone: Tone; label: string } {
  if (enquiry.status === 'draft') return { tone: 'neutral', label: 'Draft' };
  if (enquiry.status === 'information_needed') return { tone: 'attention', label: enquiry.statusLabel };
  if (state === 'quoted') return { tone: 'positive', label: 'Quoted' };
  if (state === 'closed') return { tone: 'neutral', label: 'Closed' };
  return { tone: 'progress', label: 'In Progress' };
}

export default function EnquiriesPage() {
  const [enquiries, setEnquiries] = useState<CustomerEnquiry[] | null>(null);
  const [quoted, setQuoted] = useState<Set<string>>(new Set());
  const [capabilities, setCapabilities] = useState<CapabilityRef[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [showOptions, setShowOptions] = useState(false);

  useEffect(() => {
    api<{ enquiries: CustomerEnquiry[] }>('/enquiries?includeCancelled=true')
      .then((res) => setEnquiries(res.enquiries))
      // Deliberately leaves `enquiries` null: a failed request is not an empty list,
      // and the page must not claim "no enquiries yet" about data it never received.
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
    api<{ quotations: CustomerQuoteListItem[] }>('/quotations')
      .then((res) => setQuoted(new Set(res.quotations.flatMap((q) => (q.enquiryReference ? [q.enquiryReference] : [])))))
      .catch(() => setQuoted(new Set()));
    api<{ capabilities: CapabilityRef[] }>('/suppliers/me/taxonomy')
      .then((res) => setCapabilities(res.capabilities))
      .catch(() => setCapabilities([]));
  }, []);

  const label = useMemo(() => {
    const byId = new Map(capabilities.map((c) => [c.capabilityId, c]));
    return (enquiry: CustomerEnquiry): string | undefined => {
      const process = enquiry.processCapabilityId ? byId.get(enquiry.processCapabilityId) : undefined;
      const family = process?.parentId ? byId.get(process.parentId) : undefined;
      const material = enquiry.materialCapabilityId ? byId.get(enquiry.materialCapabilityId) : undefined;
      return [family?.label ?? process?.label, material?.label].filter(Boolean).join(' • ') || undefined;
    };
  }, [capabilities]);

  const all = enquiries ?? [];
  const count = (value: Filter): number => (value === 'all' ? all.length : all.filter((e) => bucket(e, quoted) === value).length);

  const needle = search.trim().toLowerCase();
  const visible = all
    .filter((e) => filter === 'all' || bucket(e, quoted) === filter)
    .filter((e) => !needle || `${e.reference ?? ''} ${e.title} ${label(e) ?? ''}`.toLowerCase().includes(needle))
    .sort((a, b) =>
      sort === 'name' ? (a.title || '').localeCompare(b.title || '') : sort === 'oldest' ? stamp(a) - stamp(b) : stamp(b) - stamp(a),
    );

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
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}

        <div className="jw-search-row">
          <IconTextInput icon="search" label="Search enquiries..." type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
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
            <Select label="Sort by" value={sort} options={SORTS} onChange={(event) => setSort(event.target.value as Sort)} />
          </div>
        ) : null}

        <FilterChips
          label="Filter enquiries by status"
          value={filter}
          options={FILTERS.map((f) => ({ ...f, count: count(f.value) }))}
          onChange={setFilter}
        />

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
              action={all.length === 0 ? <ButtonLink href="/enquiries/new">Create your first enquiry</ButtonLink> : undefined}
            />
          </Card>
        ) : (
          <RecordList>
            {visible.map((enquiry, index) => {
              const state = chip(enquiry, bucket(enquiry, quoted));
              return (
                <RecordCard
                  key={enquiry.enquiryId}
                  href={enquiryHref(enquiry)}
                  reference=""
                  title={enquiry.title || 'Untitled enquiry'}
                  caption={label(enquiry) ?? enquiry.reference ?? 'Draft'}
                  status={<StatusChip tone={state.tone}>{state.label}</StatusChip>}
                  icon={TILES[index % TILES.length]}
                  date={when(enquiry)}
                />
              );
            })}
          </RecordList>
        )}
      </Stack>
    </Page>
  );
}
