'use client';

import type { DocumentSummary, OrganizationSite } from '@jobwork/contracts';
import { JOB_TYPE_LABELS } from '@jobwork/contracts/constants';
import { Button, Callout, Card, CommandButton, DescriptionList, formatMoney, Stack } from '@jobwork/ui';

const INSPECTION_LABELS: Record<string, string> = {
  standard: 'Standard checks',
  dimensional_report: 'Dimensional report',
  first_article: 'First-article inspection',
  third_party: 'Third-party inspection',
};
import type { DraftApi } from './useDraft';
import type { Taxonomy } from './types';

/**
 * Stage 3 — Review (prototype tile 7): what will be frozen, read back in plain words.
 * Submitting freezes this requirement as revision 1; later changes are made by
 * answering our questions, which adds a new revision — what was submitted stays
 * readable exactly as it is now.
 */

export interface ReviewStageProps {
  api: DraftApi;
  taxonomy: Taxonomy;
  sites: OrganizationSite[];
  documents: DocumentSummary[];
  submit: () => Promise<void>;
  canSubmit: boolean;
  /** Returns to Requirements; drawn beside Submit, as in the reference. */
  onBack: () => void;
}

/** The extension, upper-cased, from a document title ("Bracket Drawing.pdf" → "PDF"). */
function extensionOf(title: string | undefined): string {
  const match = title?.match(/\.([a-z0-9]{2,5})$/i);
  return match ? match[1]!.toUpperCase() : 'FILE';
}

export function ReviewStage({ api: draftApi, taxonomy, sites, documents, submit, canSubmit, onBack }: ReviewStageProps): React.JSX.Element {
  const { draft } = draftApi;
  const label = (id: string | undefined, list: Taxonomy['processes']): string =>
    list.find((c) => c.capabilityId === id)?.label ?? '—';
  const site = sites.find((s) => s.siteId === draft.deliverySiteId);
  const attached = draft.documents.map((d) => ({
    ...d,
    doc: documents.find((doc) => doc.currentVersionId === d.documentVersionId),
  }));

  return (
    <Stack gap={4}>
      <Card title="Enquiry Details">
        <DescriptionList
          layout="split"
          items={[
            { label: 'Job Type', value: JOB_TYPE_LABELS[draft.jobType] },
            ...(draft.jobType === 'correction_ecn'
              ? [
                  { label: 'Change reference', value: draft.changeReference || <em>not set</em>, mono: true },
                  { label: 'What changed', value: draft.changeDescription || <em>not set</em> },
                ]
              : []),
            { label: 'Part Name', value: draft.title || <em>not set</em> },
            {
              label: 'Material Supplied By',
              value: draft.materialSupply === 'customer_supplied' ? 'Us (customer)' : 'JobWork',
            },
            ...draft.items.flatMap((item) => {
              const process = taxonomy.processes.find((p) => p.capabilityId === item.processCapabilityId);
              const family = taxonomy.families.find((f) => f.capabilityId === process?.parentId);
              const prefix = draft.items.length > 1 ? `Part ${item.lineNo} · ` : '';
              return [
                { label: `${prefix}Category`, value: family?.label ?? (draft.assistedIntake ? 'Assisted intake' : '—') },
                { label: `${prefix}Sub Category`, value: process?.label ?? '—' },
                {
                  label: `${prefix}Material`,
                  value: [label(item.materialCapabilityId, taxonomy.materials), item.materialGrade].filter((v) => v && v !== '—').join(' · ') || '—',
                },
                {
                  label: `${prefix}Quantity`,
                  value: item.quantityBreakpoints
                    .map((bp) => `${bp.quantity} ${bp.unit === 'piece' ? 'Nos' : bp.unit}${bp.kind === 'prototype' ? ' (prototype)' : ''}`)
                    .join(' · '),
                  numeric: true,
                },
                {
                  label: `${prefix}Target Price`,
                  value: item.targetUnitPriceMinor !== undefined ? `${formatMoney({ amountMinor: item.targetUnitPriceMinor, currency: 'INR' })} per unit` : <em>not given</em>,
                  numeric: item.targetUnitPriceMinor !== undefined,
                },
              ];
            }),
            { label: 'Delivery Location', value: site ? `${site.city}, ${site.state}` : <em>not set</em> },
            { label: 'Required By', value: draft.requiredByDate || <em>not set</em> },
            { label: 'Confidentiality', value: draft.confidentiality.replace(/_/g, ' ') },
            {
              label: attached.length > 1 ? 'Files' : 'File',
              value:
                attached.length === 0 ? (
                  <em>No file attached yet</em>
                ) : (
                  <span style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'end' }}>
                    {attached.map((entry) => (
                      <span key={entry.documentVersionId} className="jw-file-row">
                        <span className="jw-file-badge" aria-hidden="true">
                          <span>{extensionOf(entry.doc?.title)}</span>
                        </span>
                        <span>
                          {entry.doc?.title ?? 'Attached file'}
                          <span className="jw-visually-hidden"> ({entry.role.replace(/_/g, ' ')})</span>
                        </span>
                      </span>
                    ))}
                  </span>
                ),
            },
          ]}
        />
      </Card>

      <Card title="Specifications">
        {draft.items.map((item) => (
          <p key={item.lineNo} style={{ marginBottom: 'var(--space-2)' }}>
            {draft.items.length > 1 ? <strong>Part {item.lineNo}: </strong> : null}
            {[
              item.description,
              item.surfaceFinish ? `Finish: ${item.surfaceFinish}` : '',
              item.toleranceClass ? `Tolerance: ${item.toleranceClass}` : '',
              `Inspection: ${INSPECTION_LABELS[item.inspectionLevel] ?? item.inspectionLevel}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        ))}
      </Card>

      <Callout tone="neutral" title="What happens when you submit">
        This requirement is frozen as revision 1 and given a reference. A JobWork engineer reviews
        it and either asks structured questions or starts sourcing. Nothing is shared with any
        workshop before that review.
      </Callout>

      <div className="jw-action-pair">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <CommandButton
          onCommand={submit}
          receiptLabel="Submitted"
          fullWidth
          disabled={!canSubmit}
          disabledReason="The draft is still saving — one moment"
        >
          Submit Enquiry
        </CommandButton>
      </div>
    </Stack>
  );
}
