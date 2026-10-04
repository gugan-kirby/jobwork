'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  CapabilityRef,
  CustomerEnquiry,
  DocumentSummary,
  Enquiry,
  OrganizationSite,
} from '@jobwork/contracts';
import {
  Button,
  Callout,
  Card,
  ErrorSummary,
  Inline,
  LiveRegion,
  LoadingState,
  Page,
  Stack,
  Stepper,
  type Step,
  type StepState,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';
import { DetailsStage } from './wizard/DetailsStage';
import { RequirementsStage } from './wizard/RequirementsStage';
import { ReviewStage } from './wizard/ReviewStage';
import { STAGES, splitTaxonomy, stageForPath } from './wizard/types';
import { useDraft } from './wizard/useDraft';

/**
 * The enquiry wizard (F-MX.6): the prototype's three stages — Details, Requirements,
 * Review — over the doc 14 §4 intake. The draft's lifecycle (autosave under version,
 * conflict handling, resume from the URL) lives in `useDraft`; this page wires the
 * stages, the stepper and the submit.
 */
export default function NewEnquiryPage(): React.JSX.Element {
  // `useSearchParams` reads the draft this wizard is editing, so the tree that uses it
  // sits behind a boundary rather than opting the whole route out of prerendering.
  return (
    <Suspense
      fallback={
        <Page title="New enquiry" width="narrow">
          <LoadingState label="Opening your enquiry" />
        </Page>
      }
    >
      <NewEnquiryWizard />
    </Suspense>
  );
}

function NewEnquiryWizard(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Read once: the wizard owns the URL from here on, and re-reading it would fight
  // its own replaceState.
  const openedWithDraftId = useRef(searchParams.get('draft'));
  const openedAtStage = useRef(Number(searchParams.get('step') ?? 0));
  const initialFamilyCode = useRef(searchParams.get('category'));
  const [stage, setStage] = useState(
    Number.isInteger(openedAtStage.current) && openedAtStage.current >= 0 && openedAtStage.current < STAGES.length
      ? openedAtStage.current
      : 0,
  );
  const draftApi = useDraft(openedWithDraftId.current);
  const { enquiryId, version, saveState, saveMessage, conflictDetail, resuming, save, reloadFromServer } = draftApi;

  const [taxonomyRows, setTaxonomyRows] = useState<CapabilityRef[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [sites, setSites] = useState<OrganizationSite[]>([]);
  const [related, setRelated] = useState<CustomerEnquiry[]>([]);
  const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);

  const loadDocuments = useCallback(async (): Promise<DocumentSummary[]> => {
    try {
      // Everything the organization owns, including versions still scanning: a file
      // that is on its way is more useful to see than to hide.
      const res = await api<{ documents: DocumentSummary[] }>('/documents');
      setDocuments(res.documents);
      return res.documents;
    } catch {
      setDocuments([]);
      return [];
    }
  }, []);

  useEffect(() => {
    // Every read degrades to an empty list: failing to list processes must not stop
    // someone raising an enquiry.
    api<{ sites: OrganizationSite[] }>('/organizations/me/sites')
      .then((res) => setSites(res.sites))
      .catch(() => setSites([]));
    api<{ capabilities: CapabilityRef[] }>('/suppliers/me/taxonomy')
      .then((res) => setTaxonomyRows(res.capabilities))
      .catch(() => setTaxonomyRows([]));
    api<{ enquiries: CustomerEnquiry[] }>('/enquiries')
      .then((res) => setRelated(res.enquiries.filter((e) => e.reference !== null)))
      .catch(() => setRelated([]));
    void loadDocuments();
  }, [loadDocuments]);

  const taxonomy = useMemo(() => splitTaxonomy(taxonomyRows), [taxonomyRows]);

  // The address bar is the wizard's memory: which draft, and where inside it. Written
  // with the history API rather than router.replace, so keeping the URL honest never
  // re-navigates the route somebody is typing into.
  useEffect(() => {
    const params = new URLSearchParams();
    if (enquiryId) params.set('draft', enquiryId);
    if (stage > 0) params.set('step', String(stage));
    const query = params.toString();
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  }, [enquiryId, stage]);

  async function submit(): Promise<void> {
    setIssues([]);
    const saved = await save();
    if (!saved) throw new Error('The draft could not be saved, so it was not submitted.');
    try {
      const submitted = await api<Enquiry>(`/enquiries/${saved.enquiryId}/submit`, {
        method: 'POST',
        body: { expectedVersion: saved.aggregateVersion },
        idempotencyKey: `submit-${saved.enquiryId}-${saved.aggregateVersion}`,
      });
      router.push(`/enquiries/${submitted.enquiryId}`);
    } catch (err) {
      if (err instanceof ApiError && err.problem.errors) {
        setIssues(err.problem.errors);
        setStage(stageForPath(err.problem.errors[0]!.path));
      }
      throw err;
    }
  }

  const issueFor = (prefix: string): string | undefined =>
    issues.find((issue) => issue.path.startsWith(prefix))?.message;

  // Leaving for the library is a detour, not an exit: it is told where to come back to.
  const libraryHref = `/documents?returnTo=${encodeURIComponent(
    `/enquiries/new?${enquiryId ? `draft=${enquiryId}&` : ''}step=1`,
  )}`;

  const steps: Step[] = STAGES.map((label, index): Step => {
    const hasError = issues.some((issue) => stageForPath(issue.path) === index);
    const state: StepState = hasError ? 'error' : index < stage ? 'complete' : 'incomplete';
    return { label, state };
  });

  if (resuming) {
    return (
      <Page title="New enquiry" back={{ href: '/enquiries', label: 'Back to enquiries' }}>
        <Card>
          <LoadingState label="Opening the draft you were working on" />
        </Card>
      </Page>
    );
  }

  const last = stage === STAGES.length - 1;

  return (
    <Page
      title={last ? 'Review enquiry' : 'New enquiry'}
      back={{ href: stage === 0 ? '/enquiries' : `?${enquiryId ? `draft=${enquiryId}&` : ''}step=${stage - 1}`, label: stage === 0 ? 'Back to enquiries' : 'Previous step' }}
      width="narrow"
    >
      <Stack gap={4}>
        <Stepper steps={steps} current={stage} onSelect={setStage} ariaLabel="Enquiry steps" />

        <Inline gap={3} justify="space-between">
          <LiveRegion message={saveMessage} />
          {saveState === 'conflict' ? (
            <Button variant="secondary" size="sm" onClick={() => void reloadFromServer()}>
              Reload their version
            </Button>
          ) : null}
        </Inline>

        {conflictDetail ? (
          <Callout tone="attention" assertive>
            {conflictDetail}
          </Callout>
        ) : null}

        <ErrorSummary issues={issues} onNavigate={(path) => setStage(stageForPath(path))} />

        {stage === 0 ? (
          <DetailsStage
            api={draftApi}
            taxonomy={taxonomy}
            sites={sites}
            onSiteAdded={(site) => setSites((current) => [...current, site])}
            relatedEnquiries={related.filter((e) => e.enquiryId !== enquiryId)}
            initialFamilyCode={initialFamilyCode.current}
            issueFor={issueFor}
          />
        ) : null}

        {stage === 1 ? (
          <RequirementsStage
            api={draftApi}
            documents={documents}
            reloadDocuments={loadDocuments}
            libraryHref={libraryHref}
            issueFor={issueFor}
          />
        ) : null}

        {stage === 2 ? (
          <ReviewStage
            api={draftApi}
            taxonomy={taxonomy}
            sites={sites}
            documents={documents}
            submit={submit}
            canSubmit={saveState !== 'saving'}
          />
        ) : null}

        {last ? (
          <div>
            <Button variant="secondary" fullWidth onClick={() => setStage((s) => Math.max(0, s - 1))}>
              Back
            </Button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: stage === 0 ? '1fr' : '1fr 1fr', gap: 'var(--space-3)' }}>
            {stage > 0 ? (
              <Button variant="secondary" onClick={() => setStage((s) => Math.max(0, s - 1))}>
                Back
              </Button>
            ) : null}
            <Button
              onClick={() => {
                void save();
                setStage((s) => Math.min(STAGES.length - 1, s + 1));
              }}
            >
              Next
            </Button>
          </div>
        )}
        <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)', textAlign: 'center' }}>
          You can leave and come back — everything is saved as you go
          {version !== null ? ` (version ${version})` : ''}.
        </p>
      </Stack>
    </Page>
  );
}
