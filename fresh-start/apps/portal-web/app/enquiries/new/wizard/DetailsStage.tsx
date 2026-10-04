'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CustomerEnquiry, EnquiryItemInput, JobType, OrganizationSite } from '@jobwork/contracts';
import {
  Button,
  Card,
  Checkbox,
  ChoiceCards,
  CommandButton,
  Inline,
  Select,
  Stack,
  TextArea,
  TextInput,
} from '@jobwork/ui';
import { api } from '../../../../lib/api';
import type { DraftApi } from './useDraft';
import { emptyItem, type Taxonomy } from './types';

/**
 * Stage 1 — Details (prototype tile 5): what kind of work, what part, which process,
 * which material, how many, where to. The job type comes first because it changes the
 * questions that follow (`FR-307`): a correction asks for its ECN and the enquiry it
 * corrects; job work asks who supplies the material.
 */

const JOB_TYPES: Array<{ value: JobType; label: string; description: string; icon: 'settings' | 'bolt' | 'edit' }> = [
  {
    value: 'job_work',
    label: 'Job work',
    description: 'Machining, finishing or processing on material you own and send us.',
    icon: 'settings',
  },
  {
    value: 'new_model',
    label: 'New model',
    description: 'A new part made from your drawing; we source the material.',
    icon: 'bolt',
  },
  {
    value: 'correction_ecn',
    label: 'Correction / ECN',
    description: 'A change to a part we have made or quoted before. Carries your ECN reference.',
    icon: 'edit',
  },
];

export interface DetailsStageProps {
  api: DraftApi;
  taxonomy: Taxonomy;
  sites: OrganizationSite[];
  onSiteAdded: (site: OrganizationSite) => void;
  relatedEnquiries: CustomerEnquiry[];
  /** From `?category=` on the home screen's category tiles; applied once to the first part. */
  initialFamilyCode: string | null;
  issueFor: (prefix: string) => string | undefined;
}

export function DetailsStage({
  api: draftApi,
  taxonomy,
  sites,
  onSiteAdded,
  relatedEnquiries,
  initialFamilyCode,
  issueFor,
}: DetailsStageProps): React.JSX.Element {
  const { draft, edit, editItem, update } = draftApi;
  const [familyByLine, setFamilyByLine] = useState<Record<number, string>>({});
  const [addingSite, setAddingSite] = useState(false);
  const [newSite, setNewSite] = useState({
    label: '',
    addressLine1: '',
    city: '',
    state: '',
    postalCode: '',
    contactName: '',
    contactPhone: '',
  });

  // A tile on the home screen chose the category; honour it once, for the first part,
  // and only while nothing has been chosen yet.
  useEffect(() => {
    if (!initialFamilyCode || taxonomy.families.length === 0) return;
    const family = taxonomy.families.find((f) => f.code === initialFamilyCode);
    if (!family) return;
    setFamilyByLine((current) =>
      current[1] || draft.items[0]?.processCapabilityId ? current : { ...current, 1: family.capabilityId },
    );
  }, [initialFamilyCode, taxonomy.families, draft.items]);

  const familyOf = (item: EnquiryItemInput): string =>
    familyByLine[item.lineNo] ??
    taxonomy.processes.find((p) => p.capabilityId === item.processCapabilityId)?.parentId ??
    '';

  const subProcesses = useMemo(
    () => (familyId: string) => taxonomy.processes.filter((p) => p.parentId === familyId),
    [taxonomy.processes],
  );

  function setTitle(value: string): void {
    update((current) => {
      const first = current.items[0];
      // The first part is usually the job: keep its name in step with the title until
      // the customer names it separately.
      const mirror = first && (first.partName === '' || first.partName === current.title);
      return {
        ...current,
        title: value,
        items: mirror
          ? current.items.map((item, index) => (index === 0 ? { ...item, partName: value } : item))
          : current.items,
      };
    });
  }

  function setJobType(jobType: JobType): void {
    edit({
      jobType,
      materialSupply: jobType === 'job_work' ? 'customer_supplied' : 'to_be_sourced',
      ...(jobType === 'new_model'
        ? {
            // First-article inspection is the sensible default for a part we have not
            // made before; the customer can turn it down on the next stage.
            items: draft.items.map((item) =>
              item.inspectionLevel === 'standard' ? { ...item, inspectionLevel: 'first_article' as const } : item,
            ),
          }
        : {}),
    });
  }

  const multi = draft.items.length > 1;

  return (
    <Stack gap={4}>
      <Card>
        <ChoiceCards
          legend="What kind of work is this?"
          hint="You can change it until you submit."
          name="jobType"
          value={draft.jobType}
          options={JOB_TYPES}
          onChange={setJobType}
          error={issueFor('jobType')}
        />
      </Card>

      {draft.jobType === 'correction_ecn' ? (
        <Card title="The change" description="What are we correcting, and against which previous job?">
          <TextInput
            label="Change reference"
            hint="Your ECN or revision number — it goes on everything we send back."
            placeholder="e.g. ECN-0042 or Rev C"
            required
            value={draft.changeReference}
            error={issueFor('changeReference')}
            onChange={(event) => edit({ changeReference: event.target.value })}
          />
          <TextArea
            label="What changed"
            hint="Dimensions, material, finish — what is different from the previous version."
            required
            value={draft.changeDescription}
            error={issueFor('changeDescription')}
            onChange={(event) => edit({ changeDescription: event.target.value })}
          />
          <Select
            label="Which enquiry does this correct?"
            hint="Optional. Pick it if the original was raised here; otherwise quote it in the description."
            placeholder={relatedEnquiries.length === 0 ? 'No earlier enquiries on file' : 'Choose an enquiry'}
            value={draft.relatedEnquiryId}
            error={issueFor('relatedEnquiryId')}
            options={relatedEnquiries.map((enquiry) => ({
              value: enquiry.enquiryId,
              label: `${enquiry.reference ?? 'Draft'} — ${enquiry.title || 'untitled'}`,
            }))}
            onChange={(event) => edit({ relatedEnquiryId: event.target.value })}
          />
        </Card>
      ) : null}

      <Card title={multi ? 'The job' : undefined}>
        <TextInput
          label="Part / job name"
          placeholder="e.g. Bracket support"
          required
          value={draft.title}
          error={issueFor('title')}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Select
          label="Material supplied by"
          hint={
            draft.materialSupply === 'customer_supplied'
              ? 'You send the material under a delivery challan; it stays yours throughout.'
              : 'JobWork sources the material and it is included in the quotation.'
          }
          value={draft.materialSupply}
          options={[
            { value: 'customer_supplied', label: 'Us — we send the material' },
            { value: 'to_be_sourced', label: 'JobWork — source it for us' },
          ]}
          onChange={(event) => edit({ materialSupply: event.target.value as typeof draft.materialSupply })}
        />
        <Checkbox
          label="I only have a photo or a rough description — please help me specify this"
          hint="With assisted intake you can submit without choosing a process or material. A JobWork engineer completes the technical details with you before sourcing starts."
          checked={draft.assistedIntake}
          onChange={(event) => edit({ assistedIntake: event.target.checked })}
        />
      </Card>

      {draft.items.map((item, index) => {
        const familyId = familyOf(item);
        const at = `items[${item.lineNo}]`;
        return (
          <Card
            key={item.lineNo}
            title={multi ? `Part ${item.lineNo}` : undefined}
            actions={
              multi ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    update((current) => ({
                      ...current,
                      items: current.items
                        .filter((i) => i.lineNo !== item.lineNo)
                        .map((i, n) => ({ ...i, lineNo: n + 1 })),
                    }))
                  }
                >
                  Remove
                </Button>
              ) : undefined
            }
          >
            {multi || index > 0 ? (
              <TextInput
                label="Part name"
                required
                value={item.partName}
                error={issueFor(`${at}.partName`)}
                onChange={(event) => editItem(item.lineNo, { partName: event.target.value })}
              />
            ) : null}

            <Select
              label="Category"
              placeholder={draft.assistedIntake ? 'Not sure — assisted intake' : 'Select category'}
              value={familyId}
              error={!familyId ? issueFor(`${at}.processCapabilityId`) : undefined}
              options={taxonomy.families.map((family) => ({ value: family.capabilityId, label: family.label }))}
              onChange={(event) => {
                setFamilyByLine((current) => ({ ...current, [item.lineNo]: event.target.value }));
                editItem(item.lineNo, { processCapabilityId: undefined });
              }}
            />
            <Select
              label="Sub category"
              placeholder={familyId ? 'Select sub category' : 'Choose a category first'}
              value={item.processCapabilityId ?? ''}
              error={familyId ? issueFor(`${at}.processCapabilityId`) : undefined}
              options={subProcesses(familyId).map((process) => ({
                value: process.capabilityId,
                label: process.label,
              }))}
              onChange={(event) =>
                editItem(item.lineNo, {
                  processCapabilityId: event.target.value || undefined,
                })
              }
            />

            <Select
              label="Material"
              placeholder={draft.assistedIntake ? 'Not sure — assisted intake' : 'Select material'}
              value={item.materialCapabilityId ?? ''}
              error={issueFor(`${at}.materialCapabilityId`)}
              options={taxonomy.materials.map((material) => ({
                value: material.capabilityId,
                label: material.label,
              }))}
              onChange={(event) =>
                editItem(item.lineNo, { materialCapabilityId: event.target.value || undefined })
              }
            />
            <TextInput
              label="Grade or standard"
              placeholder="e.g. 6061-T6, IS 2062 E250"
              value={item.materialGrade ?? ''}
              onChange={(event) => editItem(item.lineNo, { materialGrade: event.target.value })}
            />

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
                gap: 'var(--space-3)',
                alignItems: 'end',
              }}
            >
              <TextInput
                label="Quantity"
                type="number"
                min={1}
                numeric
                required
                value={item.quantityBreakpoints[0]?.quantity ?? ''}
                error={issueFor(`${at}.quantityBreakpoints`)}
                onChange={(event) => {
                  const first = item.quantityBreakpoints[0] ?? { quantity: 0, unit: 'piece' as const, kind: 'production' as const };
                  editItem(item.lineNo, {
                    quantityBreakpoints: [
                      { ...first, quantity: Number(event.target.value) || 0 },
                      ...item.quantityBreakpoints.slice(1),
                    ],
                  });
                }}
              />
              <Select
                label="Unit"
                value={item.quantityBreakpoints[0]?.unit ?? 'piece'}
                options={[
                  { value: 'piece', label: 'Nos' },
                  { value: 'set', label: 'Sets' },
                  { value: 'kg', label: 'kg' },
                  { value: 'metre', label: 'Metres' },
                ]}
                onChange={(event) => {
                  const first = item.quantityBreakpoints[0] ?? { quantity: 1, unit: 'piece' as const, kind: 'production' as const };
                  editItem(item.lineNo, {
                    quantityBreakpoints: [
                      { ...first, unit: event.target.value as typeof first.unit },
                      ...item.quantityBreakpoints.slice(1),
                    ],
                  });
                }}
              />
            </div>

            <details>
              <summary style={{ cursor: 'pointer', font: 'var(--text-caption)', color: 'var(--color-action)' }}>
                Prototype and production quantities
              </summary>
              <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)', margin: 'var(--space-2) 0' }}>
                Ask for a prototype batch and a production volume together and we price both.
              </p>
              {item.quantityBreakpoints.map((bp, bpIndex) => (
                <Inline key={bpIndex} gap={2} style={{ marginBottom: 'var(--space-2)' }}>
                  <TextInput
                    label={`Quantity ${bpIndex + 1}`}
                    type="number"
                    min={1}
                    numeric
                    value={bp.quantity}
                    onChange={(event) => {
                      const next = [...item.quantityBreakpoints];
                      next[bpIndex] = { ...bp, quantity: Number(event.target.value) || 0 };
                      editItem(item.lineNo, { quantityBreakpoints: next });
                    }}
                  />
                  <Select
                    label="Kind"
                    value={bp.kind}
                    options={[
                      { value: 'prototype', label: 'prototype' },
                      { value: 'production', label: 'production' },
                    ]}
                    onChange={(event) => {
                      const next = [...item.quantityBreakpoints];
                      next[bpIndex] = { ...bp, kind: event.target.value as typeof bp.kind };
                      editItem(item.lineNo, { quantityBreakpoints: next });
                    }}
                  />
                </Inline>
              ))}
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  editItem(item.lineNo, {
                    quantityBreakpoints: [
                      ...item.quantityBreakpoints,
                      { quantity: 100, unit: item.quantityBreakpoints[0]?.unit ?? 'piece', kind: 'production' },
                    ],
                  })
                }
              >
                Add a quantity
              </Button>
            </details>
          </Card>
        );
      })}

      <div>
        <Button
          variant="secondary"
          onClick={() =>
            update((current) => ({ ...current, items: [...current.items, emptyItem(current.items.length + 1)] }))
          }
        >
          Add another part
        </Button>
      </div>

      <Card title="Delivery location">
        <Select
          label="Deliver to"
          hint="Where the finished parts go. Only your organization sees this."
          placeholder={sites.length === 0 ? 'No addresses saved yet' : 'Select location'}
          value={draft.deliverySiteId}
          error={issueFor('deliverySiteId')}
          options={sites.map((site) => ({
            value: site.siteId,
            label: `${site.label} — ${site.city} ${site.postalCode}`,
          }))}
          onChange={(event) => edit({ deliverySiteId: event.target.value })}
        />
        {addingSite ? (
          <Stack gap={2}>
            <TextInput label="Name for this address" required value={newSite.label} onChange={(e) => setNewSite({ ...newSite, label: e.target.value })} />
            <TextInput label="Address" required value={newSite.addressLine1} onChange={(e) => setNewSite({ ...newSite, addressLine1: e.target.value })} />
            <TextInput label="City" required value={newSite.city} onChange={(e) => setNewSite({ ...newSite, city: e.target.value })} />
            <TextInput label="State" required value={newSite.state} onChange={(e) => setNewSite({ ...newSite, state: e.target.value })} />
            <TextInput label="PIN code" required value={newSite.postalCode} onChange={(e) => setNewSite({ ...newSite, postalCode: e.target.value })} />
            <TextInput label="Who receives it" value={newSite.contactName} onChange={(e) => setNewSite({ ...newSite, contactName: e.target.value })} />
            <TextInput label="Their phone" value={newSite.contactPhone} onChange={(e) => setNewSite({ ...newSite, contactPhone: e.target.value })} />
            <Inline gap={2}>
              <CommandButton
                receiptLabel="Saved"
                onCommand={async () => {
                  const saved = await api<OrganizationSite>('/organizations/me/sites', {
                    method: 'POST',
                    body: { ...newSite, kind: 'delivery' },
                    idempotencyKey: crypto.randomUUID(),
                  });
                  // Saved, selected and attached to the draft without leaving the stage.
                  onSiteAdded(saved);
                  edit({ deliverySiteId: saved.siteId });
                  setAddingSite(false);
                }}
              >
                Save address
              </CommandButton>
              <Button variant="secondary" onClick={() => setAddingSite(false)}>
                Cancel
              </Button>
            </Inline>
          </Stack>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setAddingSite(true)}>
            Add a delivery address
          </Button>
        )}
      </Card>

      <Card title="Application notes">
        <TextArea
          label="What is this for?"
          hint="Where the part is used and what matters about it. This is what our engineers read first."
          value={draft.applicationNote}
          onChange={(event) => edit({ applicationNote: event.target.value })}
        />
      </Card>
    </Stack>
  );
}
