'use client';

import { useMemo, useState } from 'react';
import type { ItemIdentity, PackageCondition, Shipment } from '@jobwork/contracts';
import { Callout, Card, Checkbox, CommandButton, FileUpload, Inline, Select, Stack, TextInput, type VersionState } from '@jobwork/ui';
import { createUploadApi } from '../../../../lib/upload-api';
import { DISCREPANCY } from '../../labels';

interface Count {
  counted: string;
  accepted: string;
  quarantined: string;
  refused: string;
  identity: ItemIdentity;
  damaged: boolean;
  note: string;
  /** The receiver changed the split by hand: stop following the count. */
  split: boolean;
}

const n = (v: string): number => (v.trim() === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
const CONDITIONS: Array<{ value: PackageCondition; label: string }> = [
  { value: 'ok', label: 'Sound' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'missing', label: 'Missing' },
];
const IDENTITY: Array<{ value: ItemIdentity; label: string }> = [
  { value: 'ok', label: 'Matches' },
  { value: 'mismatch', label: 'Marking or lot does not match' },
  { value: 'wrong_item', label: 'Not the ordered part' },
];

/**
 * The receiving workstation (IN-16 F-16.4; doc 10 §13; doc 14 §12 mobile-first). Count each
 * package and lot, put every counted piece somewhere, and see the discrepancies the receipt will
 * open before recording it. The server derives the same discrepancies and is the authority.
 */
export function ReceivingForm({ shipment, onReceive }: { shipment: Shipment; onReceive: (body: Record<string, unknown>) => Promise<void> }): React.JSX.Element {
  const items = shipment.packages.flatMap((p) => p.items.map((i) => ({ ...i, packageNo: p.packageNo })));
  const [sealIntact, setSealIntact] = useState(true);
  const [documentsMatch, setDocumentsMatch] = useState(true);
  const [conditions, setConditions] = useState<Record<number, { condition: PackageCondition; note: string }>>(() => Object.fromEntries(shipment.packages.map((p) => [p.packageNo, { condition: 'ok' as PackageCondition, note: '' }])));
  const [counts, setCounts] = useState<Record<string, Count>>(() =>
    Object.fromEntries(items.map((i) => [i.itemId, { counted: i.quantity, accepted: i.quantity, quarantined: '0', refused: '0', identity: 'ok' as ItemIdentity, damaged: false, note: '', split: false }])),
  );
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploadKey, setUploadKey] = useState(0);
  const [note, setNote] = useState('');
  const uploadApi = useMemo(() => createUploadApi(), []);

  const setCount = (itemId: string, patch: Partial<Count>): void =>
    setCounts((c) => {
      const next = { ...c[itemId]!, ...patch };
      // Until the receiver splits by hand, everything counted is accepted.
      if (!next.split && 'counted' in patch) next.accepted = next.counted;
      return { ...c, [itemId]: next };
    });
  const setCondition = (packageNo: number, condition: PackageCondition): void => {
    setConditions((c) => ({ ...c, [packageNo]: { ...c[packageNo]!, condition } }));
    if (condition === 'missing') for (const i of items.filter((x) => x.packageNo === packageNo)) setCount(i.itemId, { counted: '0', accepted: '0', quarantined: '0', refused: '0', split: true });
  };

  const problems: string[] = [];
  const preview: string[] = [];
  for (const i of items) {
    const c = counts[i.itemId]!;
    const name = i.lotCode || `package ${i.packageNo}`;
    const [shipped, counted, accepted, quarantined, refused] = [n(i.quantity), n(c.counted), n(c.accepted), n(c.quarantined), n(c.refused)];
    if (accepted + quarantined + refused !== counted) problems.push(`${name}: accepted, quarantined and refused must add up to ${counted}.`);
    if (accepted > shipped) problems.push(`${name}: no more than the ${shipped} shipped goes to stock.`);
    if (c.identity !== 'ok' && accepted > 0) problems.push(`${name}: doubtful pieces are not accepted.`);
    if (c.damaged && quarantined + refused === 0) problems.push(`${name}: quarantine or refuse the damaged pieces.`);
    if (counted < shipped) preview.push(`${DISCREPANCY.shortage} of ${shipped - counted} on ${name}`);
    if (counted > shipped) preview.push(`${DISCREPANCY.overage} of ${counted - shipped} on ${name}`);
    if (c.damaged) preview.push(`${DISCREPANCY.damage} on ${name}`);
    if (c.identity !== 'ok') preview.push(`${c.identity === 'wrong_item' ? DISCREPANCY.wrong_item : DISCREPANCY.identity} on ${name}`);
  }
  if (!documentsMatch) preview.push(DISCREPANCY.document_mismatch);

  return (
    <Card title="Receive" description="Count every package and lot. Each counted piece is accepted to stock, quarantined for quality, or refused at the dock.">
      <Stack gap={3}>
        <Stack gap={1}>
          <Checkbox label="Seal intact" checked={sealIntact} onChange={(e) => setSealIntact(e.target.checked)} />
          <Checkbox label="Challan or invoice in the box matches" checked={documentsMatch} onChange={(e) => setDocumentsMatch(e.target.checked)} />
        </Stack>
        {shipment.packages.map((p) => (
          <Stack key={p.packageNo} gap={2} style={{ borderTop: 'var(--hairline) solid var(--color-border)', paddingTop: 'var(--space-3)' }}>
            <Inline gap={2} align="end">
              <Select label={`Package ${p.packageNo}`} value={conditions[p.packageNo]!.condition} options={CONDITIONS} onChange={(e) => setCondition(p.packageNo, e.target.value as PackageCondition)} />
              {conditions[p.packageNo]!.condition !== 'ok' ? <TextInput label="What you saw" value={conditions[p.packageNo]!.note} onChange={(e) => setConditions((c) => ({ ...c, [p.packageNo]: { ...c[p.packageNo]!, note: e.target.value } }))} /> : null}
            </Inline>
            {p.items.map((i) => {
              const c = counts[i.itemId]!;
              return (
                <Stack key={i.itemId} gap={1}>
                  <p>
                    <span className="mono">{i.lotCode || '—'}</span> · shipped <span className="numeric">{i.quantity}</span>
                  </p>
                  <Inline gap={2} wrap>
                    <TextInput label="Counted" numeric inputMode="decimal" value={c.counted} onChange={(e) => setCount(i.itemId, { counted: e.target.value })} />
                    <TextInput label="Accepted" numeric inputMode="decimal" value={c.accepted} onChange={(e) => setCount(i.itemId, { accepted: e.target.value, split: true })} />
                    <TextInput label="Quarantined" numeric inputMode="decimal" value={c.quarantined} onChange={(e) => setCount(i.itemId, { quarantined: e.target.value, split: true })} />
                    <TextInput label="Refused" numeric inputMode="decimal" value={c.refused} onChange={(e) => setCount(i.itemId, { refused: e.target.value, split: true })} />
                  </Inline>
                  <Inline gap={2} wrap align="end">
                    <Select label="Identity" value={c.identity} options={IDENTITY} onChange={(e) => setCount(i.itemId, { identity: e.target.value as ItemIdentity })} />
                    <Checkbox label="Damaged pieces" checked={c.damaged} onChange={(e) => setCount(i.itemId, { damaged: e.target.checked })} />
                  </Inline>
                  {c.damaged || c.identity !== 'ok' ? <TextInput label="Note" value={c.note} onChange={(e) => setCount(i.itemId, { note: e.target.value })} /> : null}
                </Stack>
              );
            })}
          </Stack>
        ))}
        <Stack gap={1}>
          <FileUpload
            key={uploadKey}
            purpose="image"
            api={uploadApi}
            resumeKey={`jobwork-receiving-${shipment.shipmentId}`}
            onSettled={(v: VersionState) => {
              if (v.status === 'available') {
                setPhotos((list) => [...list, v.documentVersionId]);
                setUploadKey((k) => k + 1);
              }
            }}
          />
          {photos.length > 0 ? <p style={{ font: 'var(--text-caption)' }}>{photos.length} photo{photos.length === 1 ? '' : 's'} attached</p> : null}
        </Stack>
        <TextInput label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        {problems.length > 0 ? (
          <Callout tone="attention" title="Before recording">
            <ul>{problems.map((x) => <li key={x}>{x}</li>)}</ul>
          </Callout>
        ) : preview.length > 0 ? (
          <Callout tone="blocked" title="This receipt opens a discrepancy and holds the shipment">
            <ul>{preview.map((x) => <li key={x}>{x}</li>)}</ul>
          </Callout>
        ) : (
          <Callout tone="positive" title="Everything as shipped">Recording it accepts the shipment into stock.</Callout>
        )}
        <CommandButton
          receiptLabel="Recorded"
          disabled={problems.length > 0}
          disabledReason="Fix the counts first"
          onCommand={() =>
            onReceive({
              expectedVersion: shipment.aggregateVersion,
              sealIntact,
              documentsMatch,
              packages: shipment.packages.map((p) => ({ packageNo: p.packageNo, condition: conditions[p.packageNo]!.condition, note: conditions[p.packageNo]!.note.trim() })),
              lines: items.map((i) => {
                const c = counts[i.itemId]!;
                return { itemId: i.itemId, countedQuantity: c.counted.trim() || '0', acceptedQuantity: c.accepted.trim() || '0', quarantinedQuantity: c.quarantined.trim() || '0', refusedQuantity: c.refused.trim() || '0', identity: c.identity, damaged: c.damaged, note: c.note.trim() };
              }),
              photoDocumentVersionIds: photos,
              note: note.trim(),
            })
          }
        >
          Record receipt
        </CommandButton>
      </Stack>
    </Card>
  );
}
