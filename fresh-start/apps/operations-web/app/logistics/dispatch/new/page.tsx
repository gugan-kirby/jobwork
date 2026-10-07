'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { DispatchContext, PackingCheck, Shipment } from '@jobwork/contracts';
import { Callout, Card, Checkbox, CommandButton, DataTable, ErrorState, LoadingState, Page, Select, Stack, TextInput } from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';
import { PACKING_LABEL } from '../../labels';

type Row = { stockLotId: string; quantity: string; packageNo: string };

/**
 * The leg-2 planner (IN-17 F-17.5; UC-33): JobWork packs an order's stock lots — under JobWork's own
 * markings — into packages for one of the customer's addresses, with the tax invoice that travels
 * with them and the packer's check. Opened with `salesOrderId` to plan, or `shipmentId` to edit a
 * delivery not yet released.
 */
function Planner(): React.JSX.Element {
  const params = useSearchParams();
  const router = useRouter();
  const editing = params.get('shipmentId');
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [context, setContext] = useState<DispatchContext | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [destination, setDestination] = useState('');
  const [documents, setDocuments] = useState({ invoiceNumber: '', eWaybillNumber: '', challanNumber: '' });
  const [check, setCheck] = useState<PackingCheck>({ neutralCartons: false, supplierMarksRemoved: false, jobworkLabelsApplied: false, packagingNoteFollowed: false });

  useEffect(() => {
    void (async () => {
      try {
        const existing = editing ? await api<Shipment>(`/shipments/${editing}`) : null;
        const orderId = existing?.salesOrderId ?? params.get('salesOrderId');
        if (!orderId) throw new ApiError({ title: 'Open the planner from an order', status: 400, code: 'NO_ORDER' });
        const ctx = await api<DispatchContext>(`/logistics/sales-orders/${orderId}/dispatch-context`);
        setContext(ctx);
        setShipment(existing);
        const picked = new Map((existing?.packages ?? []).flatMap((p) => p.items.map((i) => [i.stockLotId ?? '', { quantity: i.quantity, packageNo: String(p.packageNo) }] as const)));
        setRows(ctx.lots.map((l, n) => ({ stockLotId: l.stockLotId, quantity: picked.get(l.stockLotId)?.quantity ?? (existing ? '' : l.available === '0' ? '' : l.available), packageNo: picked.get(l.stockLotId)?.packageNo ?? String(n + 1) })));
        setWeights(Object.fromEntries((existing?.packages ?? []).filter((p) => p.weightG).map((p) => [String(p.packageNo), String((p.weightG ?? 0) / 1000)])));
        setDestination(existing?.destination ? (ctx.sites.find((x) => x.label === existing.destination!.label)?.siteId ?? '') : (ctx.deliverySiteId ?? ctx.sites[0]?.siteId ?? ''));
        setDocuments({
          invoiceNumber: existing?.documents.invoiceNumber || (ctx.invoices.find((i) => i.kind === 'balance')?.number ?? ''),
          eWaybillNumber: existing?.documents.eWaybillNumber ?? '',
          challanNumber: existing?.documents.challanNumber ?? '',
        });
        if (existing?.delivery) setCheck(existing.delivery.packingCheck);
      } catch (err) {
        if (err instanceof ApiError) setError(err);
      }
    })();
  }, [editing, params]);

  const packages = useMemo(() => {
    const byNo = new Map<number, Array<{ stockLotId: string; quantity: string }>>();
    for (const r of rows) {
      if (!r.quantity.trim() || Number(r.quantity) <= 0) continue;
      const no = Number(r.packageNo) || 1;
      byNo.set(no, [...(byNo.get(no) ?? []), { stockLotId: r.stockLotId, quantity: r.quantity.trim() }]);
    }
    return [...byNo.entries()].sort(([a], [b]) => a - b).map(([packageNo, items]) => ({ packageNo, weightG: weights[String(packageNo)] ? Math.round(Number(weights[String(packageNo)]) * 1000) : null, items }));
  }, [rows, weights]);

  if (!context) {
    return (
      <Page title="Plan a delivery" breadcrumb={<Link href="/logistics">← Logistics</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the order’s stock" /></Card>}
      </Page>
    );
  }

  const set = (i: number, patch: Partial<Row>): void => setRows((list) => list.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const total = packages.reduce((t, p) => t + p.items.reduce((u, x) => u + Number(x.quantity), 0), 0);

  return (
    <Page
      title={shipment ? `Edit ${shipment.number}` : 'Plan a delivery'}
      breadcrumb={<Link href={shipment ? `/logistics/shipments/${shipment.shipmentId}` : '/logistics'}>← {shipment ? shipment.number : 'Logistics'}</Link>}
      description={`${context.orderNumber} for ${context.customerDisplayName} · ${context.ordered} ordered, ${context.dispatched} already delivered or on the way · ${context.partialDelivery === 'allowed' ? 'partial deliveries allowed' : 'one complete delivery asked for'}`}
    >
      <Stack gap={4}>
        <Card title="From JobWork stock" description="Each lot leaves under JobWork’s marking; the released lot code stays with JobWork.">
          <DataTable
            caption="Stock lots of this order"
            rows={context.lots}
            rowKey={(l) => l.stockLotId}
            empty={{ title: 'Nothing in stock', detail: 'Receive the supplier’s shipment first.' }}
            columns={[
              { key: 'marking', header: 'Marking', sticky: true, render: (l) => <span className="mono">{l.marking}</span> },
              { key: 'lot', header: 'Released lot', render: (l) => `${l.lotCode} · ${l.workPackageNumber}` },
              { key: 'available', header: 'Available', numeric: true, render: (l) => `${l.available} of ${l.inStock}` },
              { key: 'state', header: 'Holds', hideOnStack: true, render: (l) => [l.released ? '' : 'not released', l.receiptOpen ? `receipt ${l.sourceShipmentNumber} open` : '', ...l.heldBy].filter(Boolean).join(', ') || '—' },
              { key: 'qty', header: 'Ship', render: (l) => { const i = context.lots.indexOf(l); return <TextInput label="Pieces" inputMode="decimal" value={rows[i]?.quantity ?? ''} onChange={(e) => set(i, { quantity: e.target.value })} />; } },
              { key: 'pkg', header: 'Package', render: (l) => { const i = context.lots.indexOf(l); return <TextInput label="Package" inputMode="numeric" value={rows[i]?.packageNo ?? ''} onChange={(e) => set(i, { packageNo: e.target.value })} />; } },
            ]}
          />
          <Stack gap={1}>
            {packages.map((p) => (
              <TextInput key={p.packageNo} label={`Package ${p.packageNo} weight (kg, optional)`} inputMode="decimal" value={weights[String(p.packageNo)] ?? ''} onChange={(e) => setWeights({ ...weights, [String(p.packageNo)]: e.target.value })} />
            ))}
          </Stack>
        </Card>

        <Card title="Where and with what" description="The customer confirms the address and receiving contact before it can leave.">
          <Stack gap={2}>
            <Select label="Deliver to" value={destination} onChange={(e) => setDestination(e.target.value)} options={context.sites.map((x) => ({ value: x.siteId, label: `${x.label}, ${x.city}${x.contactName ? ` · ${x.contactName}` : ''}` }))} />
            <Select label="Tax invoice that travels with it" placeholder="Choose" value={documents.invoiceNumber} onChange={(e) => setDocuments({ ...documents, invoiceNumber: e.target.value })} options={context.invoices.map((i) => ({ value: i.number, label: `${i.number} · ${i.kind}` }))} />
            <TextInput label="E-way bill (12 digits, above ₹50,000)" value={documents.eWaybillNumber} onChange={(e) => setDocuments({ ...documents, eWaybillNumber: e.target.value })} />
            <TextInput label="Delivery challan (optional)" value={documents.challanNumber} onChange={(e) => setDocuments({ ...documents, challanNumber: e.target.value })} />
          </Stack>
        </Card>

        <Card title="Packing check" description="Nothing of the workshop may reach the customer.">
          <Stack gap={1}>
            {context.packagingNote ? <Callout tone="neutral" title="The customer asked">{context.packagingNote}</Callout> : null}
            {(Object.keys(PACKING_LABEL) as Array<keyof PackingCheck>).map((k) => (
              <Checkbox key={k} label={PACKING_LABEL[k]} checked={check[k]} onChange={(e) => setCheck({ ...check, [k]: e.target.checked })} />
            ))}
          </Stack>
        </Card>

        <CommandButton
          receiptLabel={shipment ? 'Saved' : 'Planned'}
          disabled={packages.length === 0 || !destination}
          disabledReason="Pick at least one lot and the address"
          onCommand={async () => {
            const body = { destinationSiteId: destination, packages, documents, packingCheck: check };
            const saved = shipment
              ? await api<Shipment>(`/customer-dispatches/${shipment.shipmentId}/replan`, { method: 'POST', body: { ...body, expectedVersion: shipment.aggregateVersion }, idempotencyKey: crypto.randomUUID() })
              : await api<Shipment>('/customer-dispatches', { method: 'POST', body: { ...body, salesOrderId: context.salesOrderId }, idempotencyKey: crypto.randomUUID() });
            router.push(`/logistics/shipments/${saved.shipmentId}`);
          }}
        >
          {shipment ? `Save ${total} pieces` : `Plan the delivery of ${total} pieces`}
        </CommandButton>
      </Stack>
    </Page>
  );
}

export default function PlanDeliveryPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <Planner />
    </Suspense>
  );
}
