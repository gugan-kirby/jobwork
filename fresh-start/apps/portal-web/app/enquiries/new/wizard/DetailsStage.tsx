'use client';

import { useEffect, useState } from 'react';
import type { OrganizationSite } from '@jobwork/contracts';
import { Button, CommandButton, Inline, Select, Stack, TextInput } from '@jobwork/ui';
import { api } from '../../../../lib/api';
import type { DraftApi } from './useDraft';
import { emptyItem, type Taxonomy } from './types';

/**
 * Stage 1 — Details (VF-17, reference screen 05): part or job name, category and sub
 * category, material, quantity and unit, delivery location. Nothing else. A customer
 * with no saved address adds one from the location list; the form stays as drawn until
 * they ask for it.
 */

const ADD_LOCATION = '__add_location';

export interface DetailsStageProps {
  api: DraftApi;
  taxonomy: Taxonomy;
  sites: OrganizationSite[];
  onSiteAdded: (site: OrganizationSite) => void;
  /** From `?category=` on the home screen's category tiles; applied once. */
  initialFamilyCode: string | null;
  issueFor: (prefix: string) => string | undefined;
}

export function DetailsStage({
  api: draftApi,
  taxonomy,
  sites,
  onSiteAdded,
  initialFamilyCode,
  issueFor,
}: DetailsStageProps): React.JSX.Element {
  const { draft, edit, editItem, update } = draftApi;
  const [chosenFamily, setChosenFamily] = useState('');
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

  const item = draft.items[0] ?? emptyItem(1);
  const at = `items[${item.lineNo}]`;
  const breakpoint = item.quantityBreakpoints[0] ?? emptyItem(1).quantityBreakpoints[0]!;

  // A tile on the home screen chose the category; honour it once, while nothing is chosen.
  useEffect(() => {
    if (!initialFamilyCode || taxonomy.families.length === 0) return;
    const family = taxonomy.families.find((f) => f.code === initialFamilyCode);
    if (family) setChosenFamily((current) => current || family.capabilityId);
  }, [initialFamilyCode, taxonomy.families]);

  const familyId =
    chosenFamily || (taxonomy.processes.find((p) => p.capabilityId === item.processCapabilityId)?.parentId ?? '');

  function setTitle(value: string): void {
    update((current) => ({
      ...current,
      title: value,
      // The job is the part: the first item carries the same name.
      items: current.items.map((row, index) => (index === 0 ? { ...row, partName: value } : row)),
    }));
  }

  function setBreakpoint(patch: Partial<typeof breakpoint>): void {
    editItem(item.lineNo, {
      quantityBreakpoints: [{ ...breakpoint, ...patch }, ...item.quantityBreakpoints.slice(1)],
    });
  }

  return (
    <Stack gap={1}>
      <TextInput
        label="Part / Job Name"
        placeholder="Enter part or job name"
        required
        value={draft.title}
        error={issueFor('title')}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Select
        label="Category"
        placeholder="Select category"
        value={familyId}
        error={!familyId ? issueFor(`${at}.processCapabilityId`) : undefined}
        options={taxonomy.families.map((family) => ({ value: family.capabilityId, label: family.label }))}
        onChange={(event) => {
          setChosenFamily(event.target.value);
          editItem(item.lineNo, { processCapabilityId: undefined });
        }}
      />
      <Select
        label="Sub Category"
        placeholder="Select sub category"
        value={item.processCapabilityId ?? ''}
        error={familyId ? issueFor(`${at}.processCapabilityId`) : undefined}
        options={taxonomy.processes
          .filter((process) => process.parentId === familyId)
          .map((process) => ({ value: process.capabilityId, label: process.label }))}
        onChange={(event) => editItem(item.lineNo, { processCapabilityId: event.target.value || undefined })}
      />
      <Select
        label="Material"
        placeholder="Select material"
        value={item.materialCapabilityId ?? ''}
        error={issueFor(`${at}.materialCapabilityId`)}
        options={taxonomy.materials.map((material) => ({ value: material.capabilityId, label: material.label }))}
        onChange={(event) => editItem(item.lineNo, { materialCapabilityId: event.target.value || undefined })}
      />
      <div className="jw-quantity-row">
        <TextInput
          label="Quantity"
          type="number"
          inputMode="numeric"
          min={1}
          placeholder="Enter quantity"
          required
          value={breakpoint.quantity > 0 ? breakpoint.quantity : ''}
          error={issueFor(`${at}.quantityBreakpoints`)}
          onChange={(event) => setBreakpoint({ quantity: Math.max(0, Math.floor(Number(event.target.value)) || 0) })}
        />
        <Select
          label="Unit"
          labelHidden
          value={breakpoint.unit}
          options={[
            { value: 'piece', label: 'Nos' },
            { value: 'set', label: 'Sets' },
            { value: 'kg', label: 'kg' },
            { value: 'metre', label: 'Metres' },
          ]}
          onChange={(event) => setBreakpoint({ unit: event.target.value as typeof breakpoint.unit })}
        />
      </div>
      <Select
        label="Delivery Location"
        placeholder="Select location"
        value={draft.deliverySiteId}
        error={issueFor('deliverySiteId')}
        options={[
          ...sites.map((site) => ({ value: site.siteId, label: `${site.city}, ${site.state} — ${site.label}` })),
          { value: ADD_LOCATION, label: '+ Add new location' },
        ]}
        onChange={(event) => {
          if (event.target.value === ADD_LOCATION) setAddingSite(true);
          else edit({ deliverySiteId: event.target.value });
        }}
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
      ) : null}
    </Stack>
  );
}
