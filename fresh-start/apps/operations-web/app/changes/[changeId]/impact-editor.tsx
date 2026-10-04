'use client';

import { useState } from 'react';
import type { ChangeRequest, ProductionView } from '@jobwork/contracts';
import { CHANGE_IMPACT_AREAS } from '@jobwork/contracts/constants';
import { Callout, Card, Checkbox, CommandButton, Inline, Select, Stack, TextArea, TextInput } from '@jobwork/ui';

type AreaState = { applicable: boolean; text: string };
type Wip = { purchaseOrderId: string; quantity: string; disposition: 'reuse' | 'rework' | 'scrap'; cost: string; note: string };

const rupees = (minor: number): string => (minor / 100).toFixed(2);
const minor = (value: string): number => Math.round(Number(value || '0') * 100);

/**
 * The doc 09 §8 impact matrix (IN-13): every area answered, or marked not applicable with a
 * reason; the structured deltas the amendments are cut from; the draft baseline the change
 * will release. Each save is a new immutable impact version.
 */
export function ImpactEditor({
  change,
  production,
  onSave,
  onComplete,
}: {
  change: ChangeRequest;
  production: ProductionView;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onComplete: () => Promise<void>;
}): React.JSX.Element {
  const impact = change.impact;
  const [areas, setAreas] = useState<Record<string, AreaState>>(() =>
    Object.fromEntries(
      CHANGE_IMPACT_AREAS.map((a) => {
        const saved = impact?.areas[a.key];
        return [a.key, saved ? (saved.applicable ? { applicable: true, text: saved.answer } : { applicable: false, text: saved.reason }) : { applicable: true, text: '' }];
      }),
    ),
  );
  const [price, setPrice] = useState(impact ? rupees(impact.customerPriceDeltaMinor) : '0');
  const [days, setDays] = useState(String(impact?.deliveryDateDeltaDays ?? 0));
  const [poDeltas, setPoDeltas] = useState<Record<string, { cost: string; lead: string }>>(() =>
    Object.fromEntries(production.purchaseOrders.map((po) => {
      const saved = impact?.purchaseOrders.find((p) => p.purchaseOrderId === po.purchaseOrderId);
      return [po.purchaseOrderId, { cost: saved ? rupees(saved.costDeltaMinor) : '0', lead: String(saved?.leadTimeDeltaDays ?? 0) }];
    })),
  );
  const [wip, setWip] = useState<Wip[]>(() => (impact?.wip ?? []).map((w) => ({ purchaseOrderId: w.purchaseOrderId, quantity: String(w.quantity), disposition: w.disposition, cost: rupees(w.costMinor), note: w.note })));
  const drafts = production.baselines.filter((b) => b.status === 'draft');
  const [candidate, setCandidate] = useState(change.candidateBaselineId ?? drafts[0]?.baselineId ?? '');

  const body = (): Record<string, unknown> => ({
    expectedVersion: change.aggregateVersion,
    areas: Object.fromEntries(
      Object.entries(areas)
        .filter(([, a]) => a.text.trim().length >= 3)
        .map(([key, a]) => [key, a.applicable ? { applicable: true, answer: a.text.trim() } : { applicable: false, reason: a.text.trim() }]),
    ),
    customerPriceDeltaMinor: minor(price),
    deliveryDateDeltaDays: Number(days || '0'),
    purchaseOrders: Object.entries(poDeltas).map(([purchaseOrderId, d]) => ({ purchaseOrderId, costDeltaMinor: minor(d.cost), leadTimeDeltaDays: Number(d.lead || '0') })),
    wip: wip.filter((w) => Number(w.quantity) > 0).map((w) => ({ purchaseOrderId: w.purchaseOrderId, quantity: Number(w.quantity), disposition: w.disposition, costMinor: minor(w.cost), note: w.note })),
    ...(candidate ? { candidateBaselineId: candidate } : {}),
  });

  return (
    <Card title="Impact" description="Doc 09 §8. Answer each area, or untick it and say why it does not apply. Saving keeps every earlier version.">
      <Stack gap={4}>
        {change.missingAreas.length > 0 && impact ? <Callout tone="attention" title="Still unanswered">{change.missingAreas.join(', ')}</Callout> : null}
        {CHANGE_IMPACT_AREAS.map((a) => (
          <div key={a.key}>
            <Checkbox
              label={`${a.label} applies`}
              checked={areas[a.key]!.applicable}
              onChange={(event) => setAreas({ ...areas, [a.key]: { ...areas[a.key]!, applicable: event.target.checked } })}
            />
            <TextArea
              label={areas[a.key]!.applicable ? `${a.label}: ${a.question}` : `${a.label}: why it does not apply`}
              rows={2}
              value={areas[a.key]!.text}
              onChange={(event) => setAreas({ ...areas, [a.key]: { ...areas[a.key]!, text: event.target.value } })}
            />
          </div>
        ))}
        <Inline gap={3}>
          <TextInput label="Customer price change (₹, tax included; negative is a credit)" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
          <TextInput label="Delivery date change (days)" inputMode="numeric" value={days} onChange={(event) => setDays(event.target.value)} />
        </Inline>
        {production.purchaseOrders.map((po) => (
          <Inline key={po.purchaseOrderId} gap={3}>
            <TextInput label={`${po.number} (${po.supplierDisplayName}): supplier cost change (₹)`} inputMode="decimal" value={poDeltas[po.purchaseOrderId]!.cost} onChange={(event) => setPoDeltas({ ...poDeltas, [po.purchaseOrderId]: { ...poDeltas[po.purchaseOrderId]!, cost: event.target.value } })} />
            <TextInput label={`${po.number}: lead time change (days)`} inputMode="numeric" value={poDeltas[po.purchaseOrderId]!.lead} onChange={(event) => setPoDeltas({ ...poDeltas, [po.purchaseOrderId]: { ...poDeltas[po.purchaseOrderId]!, lead: event.target.value } })} />
          </Inline>
        ))}
        <div>
          <h3 style={{ font: 'var(--text-body-strong)', marginBottom: 'var(--space-2)' }}>Work in progress</h3>
          <Stack gap={2}>
            {wip.map((w, i) => (
              <Inline key={i} gap={2}>
                <Select label="Purchase order" value={w.purchaseOrderId} options={production.purchaseOrders.map((po) => ({ value: po.purchaseOrderId, label: po.number }))} onChange={(event) => setWip(wip.map((x, j) => (j === i ? { ...x, purchaseOrderId: event.target.value } : x)))} />
                <TextInput label="Quantity" inputMode="decimal" value={w.quantity} onChange={(event) => setWip(wip.map((x, j) => (j === i ? { ...x, quantity: event.target.value } : x)))} />
                <Select label="Disposition" value={w.disposition} options={[{ value: 'reuse', label: 'Reuse' }, { value: 'rework', label: 'Rework' }, { value: 'scrap', label: 'Scrap' }]} onChange={(event) => setWip(wip.map((x, j) => (j === i ? { ...x, disposition: event.target.value as Wip['disposition'] } : x)))} />
                <TextInput label="Cost (₹)" inputMode="decimal" value={w.cost} onChange={(event) => setWip(wip.map((x, j) => (j === i ? { ...x, cost: event.target.value } : x)))} />
              </Inline>
            ))}
            <div>
              <CommandButton variant="secondary" size="sm" receiptLabel="Added" onCommand={async () => setWip([...wip, { purchaseOrderId: production.purchaseOrders[0]?.purchaseOrderId ?? '', quantity: '', disposition: 'scrap', cost: '0', note: '' }])}>
                Add work-in-progress line
              </CommandButton>
            </div>
          </Stack>
        </div>
        <Select
          label="Baseline this change will release"
          hint="Assemble it on the order's production page first; it supersedes the released baseline only when the change is released."
          value={candidate}
          placeholder={drafts.length === 0 ? 'No draft baseline yet' : 'Choose a draft'}
          options={drafts.map((b) => ({ value: b.baselineId, label: `${b.number} — ${b.items.map((i) => `${i.title} v${i.versionNo}`).join(', ')}` }))}
          onChange={(event) => setCandidate(event.target.value)}
        />
        <Inline gap={2}>
          <CommandButton receiptLabel="Saved" onCommand={() => onSave(body())}>
            Save impact version
          </CommandButton>
          <CommandButton variant="secondary" receiptLabel="Sent for approval" disabled={!change.impactComplete || !change.candidateBaselineId} disabledReason="Answer every area and name the baseline first, then save" onCommand={onComplete}>
            Complete impact and request approval
          </CommandButton>
        </Inline>
      </Stack>
    </Card>
  );
}
