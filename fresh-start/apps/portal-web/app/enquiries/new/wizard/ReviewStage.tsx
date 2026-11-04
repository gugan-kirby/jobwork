'use client';

import type { DocumentSummary, OrganizationSite } from '@jobwork/contracts';
import { Button, Card, CommandButton, DescriptionList, Icon, Stack } from '@jobwork/ui';
import type { DraftApi } from './useDraft';
import { extensionOf, fileName, type Taxonomy } from './types';

/**
 * Stage 3 — Review (VF-17, reference screen 07): what will be frozen, read back. Part,
 * category, material, quantity, delivery location, the file, the specifications, then
 * Back and Submit Enquiry. Submitting freezes this as revision 1.
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

export function ReviewStage({ api: draftApi, taxonomy, sites, documents, submit, canSubmit, onBack }: ReviewStageProps): React.JSX.Element {
  const { draft } = draftApi;
  const site = sites.find((s) => s.siteId === draft.deliverySiteId);
  const attached = draft.documents.map((d) => ({
    ...d,
    doc: documents.find((doc) => doc.currentVersionId === d.documentVersionId),
  }));
  const specifications = draft.items
    .map((item) => [item.description, item.surfaceFinish, item.toleranceClass ? `Tolerance ${item.toleranceClass}` : ''].filter(Boolean).join(', '))
    .filter(Boolean);

  return (
    <Stack gap={5}>
      <Card title="Enquiry Details">
        <DescriptionList
          layout="split"
          items={[
            { label: 'Part Name', value: draft.title || '—' },
            ...draft.items.flatMap((item) => {
              const process = taxonomy.processes.find((p) => p.capabilityId === item.processCapabilityId);
              const family = taxonomy.families.find((f) => f.capabilityId === process?.parentId);
              const material = taxonomy.materials.find((m) => m.capabilityId === item.materialCapabilityId);
              const prefix = draft.items.length > 1 ? `Part ${item.lineNo} · ` : '';
              return [
                { label: `${prefix}Category`, value: family?.label ?? '—' },
                { label: `${prefix}Material`, value: [material?.label, item.materialGrade].filter(Boolean).join(' ') || '—' },
                {
                  label: `${prefix}Quantity`,
                  value: item.quantityBreakpoints
                    .filter((bp) => bp.quantity > 0)
                    .map((bp) => `${bp.quantity} ${bp.unit === 'piece' ? 'Nos' : bp.unit}`)
                    .join(', '),
                  numeric: true,
                },
              ];
            }),
            { label: 'Delivery Location', value: site ? `${site.city}, ${site.state}` : '—' },
          ]}
        />
        <div className="jw-review-file">
          <p className="jw-review-file-label">File</p>
          {attached.length === 0 ? (
            <p className="jw-review-file-row">No file attached</p>
          ) : (
            attached.map((entry) => (
              <p key={entry.documentVersionId} className="jw-review-file-row">
                <Icon name="document" size={1.3} />
                <span className="jw-file-row">
                  <span className="jw-file-badge" aria-hidden="true">
                    <span>{extensionOf(fileName(entry.doc))}</span>
                  </span>
                  {fileName(entry.doc)}
                </span>
              </p>
            ))
          )}
        </div>
      </Card>

      <Card title="Specifications">
        {specifications.length === 0 ? <p>None added</p> : specifications.map((line) => <p key={line}>{line}</p>)}
      </Card>

      <div className="jw-action-pair jw-action-pair-wide">
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
