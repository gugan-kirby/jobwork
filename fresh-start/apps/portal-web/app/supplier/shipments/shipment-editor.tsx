'use client';

import { useEffect, useState } from 'react';
import type { OrganizationSite, Shipment, ShippableLot } from '@jobwork/contracts';
import { Button, Callout, Card, CommandButton, DataTable, Inline, Select, Stack, TextInput } from '@jobwork/ui';
import { api } from '../../../lib/api';

interface DraftItem {
  lotCode: string;
  quantity: string;
  serials: string;
}
interface DraftPackage {
  lengthMm: string;
  widthMm: string;
  heightMm: string;
  weightKg: string;
  items: DraftItem[];
}
interface Draft {
  originSiteId: string;
  challanNumber: string;
  invoiceNumber: string;
  eWaybillNumber: string;
  packages: DraftPackage[];
}

const emptyItem = (lotCode = ''): DraftItem => ({ lotCode, quantity: '', serials: '' });
const emptyPackage = (lotCode = ''): DraftPackage => ({ lengthMm: '', widthMm: '', heightMm: '', weightKg: '', items: [emptyItem(lotCode)] });
const mm = (v: string): number | null => (v.trim() === '' ? null : Math.round(Number(v)));

function fromShipment(s: Shipment): Draft {
  return {
    originSiteId: '',
    challanNumber: s.documents.challanNumber,
    invoiceNumber: s.documents.invoiceNumber,
    eWaybillNumber: s.documents.eWaybillNumber,
    packages: s.packages.map((p) => ({
      lengthMm: p.lengthMm?.toString() ?? '',
      widthMm: p.widthMm?.toString() ?? '',
      heightMm: p.heightMm?.toString() ?? '',
      weightKg: p.weightG ? String(p.weightG / 1000) : '',
      items: p.items.map((i) => ({ lotCode: i.lotCode, quantity: i.quantity, serials: i.serials.join(', ') })),
    })),
  };
}

/** The request body both `plan` and `replan` take, from what the supplier typed. */
function toBody(d: Draft): Record<string, unknown> {
  return {
    originSiteId: d.originSiteId,
    documents: { challanNumber: d.challanNumber.trim(), invoiceNumber: d.invoiceNumber.trim(), eWaybillNumber: d.eWaybillNumber.trim() },
    packages: d.packages.map((p, n) => ({
      packageNo: n + 1,
      lengthMm: mm(p.lengthMm),
      widthMm: mm(p.widthMm),
      heightMm: mm(p.heightMm),
      weightG: p.weightKg.trim() === '' ? null : Math.round(Number(p.weightKg) * 1000),
      items: p.items.map((i) => ({ lotCode: i.lotCode, quantity: i.quantity.trim(), serials: i.serials.split(',').map((x) => x.trim()).filter(Boolean) })),
    })),
  };
}

/**
 * Packages, lots and documents for one shipment (IN-16 F-16.4). The lots on offer are the ones
 * JobWork quality released on this purchase order, with what is still available of each; the
 * server's guards decide the rest and are shown once the plan is saved.
 */
export function ShipmentEditor({ purchaseOrderId, shipment, onSave, saveLabel }: { purchaseOrderId: string; shipment?: Shipment | undefined; onSave: (body: Record<string, unknown>) => Promise<void>; saveLabel: string }): React.JSX.Element {
  const [lots, setLots] = useState<ShippableLot[]>([]);
  const [sites, setSites] = useState<OrganizationSite[]>([]);
  const [draft, setDraft] = useState<Draft>(() => (shipment ? fromShipment(shipment) : { originSiteId: '', challanNumber: '', invoiceNumber: '', eWaybillNumber: '', packages: [emptyPackage()] }));

  useEffect(() => {
    void api<ShippableLot[]>(`/supplier/shipments/shippable?purchaseOrderId=${purchaseOrderId}`)
      .then((l) => {
        setLots(l);
        if (!shipment && l.length === 1) setDraft((d) => ({ ...d, packages: [emptyPackage(l[0]!.lotCode)] }));
      })
      .catch(() => setLots([]));
    void api<{ sites: OrganizationSite[] }>('/organizations/me/sites')
      .then((r) => {
        const pickup = r.sites.filter((s) => s.kind === 'works' || s.kind === 'pickup');
        setSites(pickup);
        const current = shipment?.origin ? pickup.find((s) => s.label === shipment.origin!.label) : undefined;
        setDraft((d) => ({ ...d, originSiteId: current?.siteId ?? (pickup.length === 1 ? pickup[0]!.siteId : d.originSiteId) }));
      })
      .catch(() => setSites([]));
  }, [purchaseOrderId, shipment]);

  const setPackage = (n: number, patch: Partial<DraftPackage>): void => setDraft((d) => ({ ...d, packages: d.packages.map((p, i) => (i === n ? { ...p, ...patch } : p)) }));
  const setItem = (n: number, k: number, patch: Partial<DraftItem>): void => setPackage(n, { items: draft.packages[n]!.items.map((it, j) => (j === k ? { ...it, ...patch } : it)) });
  const lotOptions = lots.map((l) => ({ value: l.lotCode, label: `${l.lotCode || 'No lot'} — ${l.available} available${l.heldBy.length ? ` (held by ${l.heldBy.join(', ')})` : ''}` }));
  const incomplete = !draft.originSiteId || draft.packages.some((p) => p.items.some((i) => !/^\d+(\.\d+)?$/.test(i.quantity.trim()) || Number(i.quantity) <= 0));

  return (
    <Stack gap={4}>
      <Card title="Released lots" description="What JobWork quality released on this purchase order, less what earlier shipments took.">
        {lots.length === 0 ? (
          <Callout tone="attention" title="Nothing released yet">JobWork quality releases each lot after its final inspection. Plan the shipment once it has.</Callout>
        ) : (
          <DataTable
            caption="Released lots"
            rows={lots}
            rowKey={(l) => l.lotCode}
            columns={[
              { key: 'lot', header: 'Lot', render: (l) => <span className="mono">{l.lotCode || '—'}</span> },
              { key: 'released', header: 'Released', numeric: true, render: (l) => l.released },
              { key: 'shipped', header: 'Shipped', numeric: true, render: (l) => l.shipped },
              { key: 'available', header: 'Available', numeric: true, render: (l) => l.available },
              { key: 'held', header: 'Held', render: (l) => (l.heldBy.length ? l.heldBy.join(', ') : '') },
            ]}
          />
        )}
      </Card>

      <Card title="Pickup and documents" description="A delivery challan or your tax invoice always; an e-way bill above ₹50,000 of goods.">
        <Stack gap={2}>
          <Select label="Pickup address" placeholder="Choose a works or pickup address" value={draft.originSiteId} onChange={(e) => setDraft({ ...draft, originSiteId: e.target.value })} options={sites.map((s) => ({ value: s.siteId, label: `${s.label} — ${s.city}` }))} hint={sites.length === 0 ? 'Add a works or pickup address under Company first.' : undefined} />
          <Inline gap={2} wrap>
            <TextInput label="Delivery challan no." value={draft.challanNumber} onChange={(e) => setDraft({ ...draft, challanNumber: e.target.value })} />
            <TextInput label="Tax invoice no." value={draft.invoiceNumber} onChange={(e) => setDraft({ ...draft, invoiceNumber: e.target.value })} />
            <TextInput label="E-way bill no." value={draft.eWaybillNumber} onChange={(e) => setDraft({ ...draft, eWaybillNumber: e.target.value })} />
          </Inline>
        </Stack>
      </Card>

      {draft.packages.map((p, n) => (
        <Card key={n} title={`Package ${n + 1}`}>
          <Stack gap={2}>
            <Inline gap={2} wrap>
              <TextInput label="Length mm" numeric inputMode="numeric" value={p.lengthMm} onChange={(e) => setPackage(n, { lengthMm: e.target.value })} />
              <TextInput label="Width mm" numeric inputMode="numeric" value={p.widthMm} onChange={(e) => setPackage(n, { widthMm: e.target.value })} />
              <TextInput label="Height mm" numeric inputMode="numeric" value={p.heightMm} onChange={(e) => setPackage(n, { heightMm: e.target.value })} />
              <TextInput label="Weight kg" numeric inputMode="decimal" value={p.weightKg} onChange={(e) => setPackage(n, { weightKg: e.target.value })} />
            </Inline>
            {p.items.map((it, k) => (
              <Inline key={k} gap={2} wrap align="end">
                <Select label="Lot" value={it.lotCode} onChange={(e) => setItem(n, k, { lotCode: e.target.value })} options={lotOptions} placeholder="Choose a released lot" />
                <TextInput label="Pieces" numeric inputMode="decimal" value={it.quantity} onChange={(e) => setItem(n, k, { quantity: e.target.value })} />
                <TextInput label="Serials (optional, comma separated)" value={it.serials} onChange={(e) => setItem(n, k, { serials: e.target.value })} />
                {p.items.length > 1 ? (
                  <Button size="sm" variant="ghost" onClick={() => setPackage(n, { items: p.items.filter((_, j) => j !== k) })}>
                    Remove
                  </Button>
                ) : null}
              </Inline>
            ))}
            <Inline gap={2}>
              <Button size="sm" variant="secondary" onClick={() => setPackage(n, { items: [...p.items, emptyItem(lots[0]?.lotCode ?? '')] })}>
                Add a lot to this package
              </Button>
              {draft.packages.length > 1 ? (
                <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, packages: draft.packages.filter((_, i) => i !== n) })}>
                  Remove package
                </Button>
              ) : null}
            </Inline>
          </Stack>
        </Card>
      ))}
      <Inline gap={2}>
        <Button variant="secondary" onClick={() => setDraft({ ...draft, packages: [...draft.packages, emptyPackage(lots[0]?.lotCode ?? '')] })}>
          Add a package
        </Button>
        <CommandButton receiptLabel="Saved" disabled={incomplete} disabledReason="Choose the pickup address and give every lot its piece count" onCommand={() => onSave(toBody(draft))}>
          {saveLabel}
        </CommandButton>
      </Inline>
    </Stack>
  );
}
