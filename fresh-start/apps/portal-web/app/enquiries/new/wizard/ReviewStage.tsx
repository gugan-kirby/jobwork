'use client';

import type { DocumentSummary, OrganizationSite } from '@jobwork/contracts';
import { JOB_TYPE_LABELS } from '@jobwork/contracts/constants';
import { Callout, Card, CommandButton, DescriptionList, formatMoney, Icon, Stack } from '@jobwork/ui';

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
}

export function ReviewStage({ api: draftApi, taxonomy, sites, documents, submit, canSubmit }: ReviewStageProps): React.JSX.Element {
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
      <Card title="Enquiry details">
        <DescriptionList
          columns={1}
          items={[
            { label: 'Job type', value: JOB_TYPE_LABELS[draft.jobType] },
            ...(draft.jobType === 'correction_ecn'
              ? [
                  { label: 'Change reference', value: draft.changeReference || <em>not set</em>, mono: true },
                  { label: 'What changed', value: draft.changeDescription || <em>not set</em> },
                ]
              : []),
            { label: 'Part name', value: draft.title || <em>not set</em> },
            {
              label: 'Material supplied by',
              value: draft.materialSupply === 'customer_supplied' ? 'Us (customer)' : 'JobWork',
            },
            ...draft.items.flatMap((item) => {
              const process = taxonomy.processes.find((p) => p.capabilityId === item.processCapabilityId);
              const family = taxonomy.families.find((f) => f.capabilityId === process?.parentId);
              const prefix = draft.items.length > 1 ? `Part ${item.lineNo} · ` : '';
              return [
                { label: `${prefix}Category`, value: family?.label ?? (draft.assistedIntake ? 'Assisted intake' : '—') },
                { label: `${prefix}Sub category`, value: process?.label ?? '—' },
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
                  label: `${prefix}Your target price`,
                  value: item.targetUnitPriceMinor !== undefined ? `${formatMoney({ amountMinor: item.targetUnitPriceMinor, currency: 'INR' })} per unit` : <em>not given</em>,
                  numeric: item.targetUnitPriceMinor !== undefined,
                },
              ];
            }),
            { label: 'Delivery location', value: site ? `${site.city}, ${site.state}` : <em>not set</em> },
            { label: 'Required by', value: draft.requiredByDate || <em>not set</em> },
            { label: 'Confidentiality', value: draft.confidentiality.replace(/_/g, ' ') },
          ]}
        />
      </Card>

      <Card title="Files">
        {attached.length === 0 ? (
          <p style={{ color: 'var(--color-text-muted)' }}>No file attached yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', display: 'grid', gap: 'var(--space-2)' }}>
            {attached.map((entry) => (
              <li key={entry.documentVersionId} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                <span style={{ color: 'var(--status-blocked-fg)', display: 'inline-flex' }}>
                  <Icon name="document" />
                </span>
                <span>{entry.doc?.title ?? 'Attached file'}</span>
                <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                  {entry.role.replace(/_/g, ' ')}
                </span>
              </li>
            ))}
          </ul>
        )}
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

      <CommandButton
        onCommand={submit}
        receiptLabel="Submitted"
        fullWidth
        disabled={!canSubmit}
        disabledReason="The draft is still saving — one moment"
      >
        Submit enquiry
      </CommandButton>
    </Stack>
  );
}
