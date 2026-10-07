'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { CarrierMode, CarrierStatus, DiscrepancyResolution, ReceivingDiscrepancy, Shipment, SiteSnapshot } from '@jobwork/contracts';
import { Callout, Card, CommandButton, DataTable, DescriptionList, ErrorState, GateMatrix, LoadingState, Page, Select, Stack, StatusChip, TextInput } from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';
import { CARRIER_MODE, DISCREPANCY, QUALITY_RESOLUTIONS, RECEIVABLE, RESOLUTION, RESOLUTIONS, statusOf, when } from '../../labels';
import { DeliveryDocumentsPanel, DeliveryFactsPanel, DispatchGatePanel, PodPanel, RefusalPanel } from './delivery-panels';
import { ReceivingForm } from './receiving-form';

const pieces = (q: string): string => `${q} ${q === '1' ? 'piece' : 'pieces'}`;
/** Made parts count in pieces; customer material may be in kg, m or sheets. */
const amount = (s: Shipment): string => {
  const units = [...new Set(s.packages.flatMap((p) => p.items.map((i) => i.unit)))];
  return units.length === 1 && units[0] !== 'piece' ? `${s.totalQuantity} ${units[0]}` : pieces(s.totalQuantity);
};
const LEG: Record<Shipment['leg'], string> = {
  supplier_to_jobwork: '',
  customer_to_jobwork: 'Customer material',
  jobwork_to_supplier: 'Material issued to the supplier',
  jobwork_to_customer: 'To the customer',
};
const address = (s: SiteSnapshot | null): string => (s ? `${s.label}, ${s.addressLine1}, ${s.city} ${s.postalCode}` : '—');
const CARRIER_STATUSES: Array<{ value: CarrierStatus; label: string }> = [
  { value: 'in_transit', label: 'In transit' },
  { value: 'out_for_delivery', label: 'Out for delivery' },
  { value: 'delivered', label: 'Delivered (carrier says)' },
  { value: 'exception', label: 'Exception' },
];

/** One open discrepancy, resolved once by whoever owns that resolution (BR-LOG-04). */
function Resolve({ d, onResolved }: { d: ReceivingDiscrepancy; onResolved: (s: Shipment) => void }): React.JSX.Element {
  const [resolution, setResolution] = useState<DiscrepancyResolution | ''>('');
  const [note, setNote] = useState('');
  const [caseReference, setCaseReference] = useState('');
  return (
    <Stack gap={1}>
      <Select
        label="Resolution"
        placeholder="Choose"
        value={resolution}
        options={RESOLUTIONS[d.kind].map((r) => ({ value: r, label: `${RESOLUTION[r]}${QUALITY_RESOLUTIONS.includes(r) ? ' — quality' : ''}` }))}
        onChange={(e) => setResolution(e.target.value as DiscrepancyResolution)}
      />
      <TextInput label="Why" value={note} onChange={(e) => setNote(e.target.value)} />
      <TextInput label="Carrier claim or supplier case (optional)" value={caseReference} onChange={(e) => setCaseReference(e.target.value)} />
      <CommandButton
        size="sm"
        receiptLabel="Resolved"
        disabled={!resolution || note.trim().length < 3}
        disabledReason="Choose a resolution and say why"
        onCommand={async () => onResolved(await api<Shipment>(`/receiving-discrepancies/${d.discrepancyId}/resolve`, { method: 'POST', body: { resolution, note: note.trim(), caseReference: caseReference.trim() }, idempotencyKey: crypto.randomUUID() }))}
      >
        Resolve {d.number}
      </CommandButton>
    </Stack>
  );
}

/**
 * One shipment, JobWork's side (IN-16 F-16.4; doc 10 §§11–13): release it once the guards are
 * green, follow the carrier, receive it at the dock, and resolve what receiving found.
 */
export default function LogisticsShipmentPage(): React.JSX.Element {
  const shipmentId = useParams<{ shipmentId: string }>().shipmentId;
  const [s, setS] = useState<Shipment | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pickup, setPickup] = useState<{ carrierMode: CarrierMode | ''; carrierName: string; trackingReference: string }>({ carrierMode: '', carrierName: '', trackingReference: '' });
  const [event, setEvent] = useState<{ normalizedStatus: CarrierStatus | ''; rawStatus: string; occurredAt: string }>({ normalizedStatus: '', rawStatus: '', occurredAt: '' });

  const load = useCallback(async () => {
    try {
      setS(await api<Shipment>(`/shipments/${shipmentId}`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [shipmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!s) {
    return (
      <Page title="Shipment" breadcrumb={<Link href="/logistics">← Logistics</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the shipment" /></Card>}
      </Page>
    );
  }

  const post = async (path: string, body: Record<string, unknown>): Promise<void> => {
    setS(await api<Shipment>(`/shipments/${s.shipmentId}${path}`, { method: 'POST', body, idempotencyKey: crypto.randomUUID() }));
  };
  const lines = s.packages.flatMap((p) => p.items.map((i) => ({ ...i, packageNo: p.packageNo, received: s.receiving?.lines.find((r) => r.itemId === i.itemId) })));
  const toCustomer = s.leg === 'jobwork_to_customer';
  const onTheWay = ['picked_up', 'in_transit', 'delivered_to_destination'].includes(s.status);

  return (
    <Page
      title={toCustomer ? `${s.number} — to ${s.delivery?.customerDisplayName ?? 'the customer'}` : `${s.number} — ${s.supplierDisplayName}`}
      breadcrumb={<Link href="/logistics">← Logistics</Link>}
      meta={<StatusChip tone={statusOf(s).tone}>{statusOf(s).label}</StatusChip>}
      description={[LEG[s.leg], toCustomer ? s.delivery?.orderNumber : s.purchaseOrderNumber, `${amount(s)} in ${s.packages.length} package${s.packages.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
    >
      <Stack gap={4}>
        {toCustomer && (s.status === 'ready_for_release' || s.status === 'planned') ? <DispatchGatePanel s={s} onChange={setS} /> : null}
        {toCustomer && s.delivery?.packagingNote ? <Callout tone="neutral" title="The customer’s packaging instructions">{s.delivery.packagingNote}</Callout> : null}
        {!toCustomer && (s.status === 'ready_for_release' || s.status === 'planned') ? (
          <Card title="Release guards" description="doc 10 §12. Release checks them again inside the transaction and freezes the addresses.">
            <Stack gap={3}>
              <GateMatrix gates={s.guards} label={`Release guards for ${s.number}`} />
              {s.status === 'ready_for_release' ? (
                <CommandButton receiptLabel="Released" disabled={!s.guards.every((g) => g.pass)} disabledReason="A guard is red" onCommand={() => post('/release', { expectedVersion: s.aggregateVersion })}>
                  Release for pickup
                </CommandButton>
              ) : (
                <p style={{ font: 'var(--text-caption)' }}>The supplier has not submitted it yet.</p>
              )}
            </Stack>
          </Card>
        ) : null}

        {!toCustomer && s.status === 'delivered_to_destination' ? <Callout tone="attention" title="The carrier says it is delivered">That ends the carrier’s custody; nothing is received until it is counted below.</Callout> : null}
        {!toCustomer && RECEIVABLE.includes(s.status) ? <ReceivingForm shipment={s} onReceive={(body) => post('/receive', body)} /> : null}
        {toCustomer ? <DeliveryFactsPanel s={s} onChange={setS} /> : null}
        {toCustomer && !s.delivery?.pod && (onTheWay || s.status === 'discrepancy_hold') ? <PodPanel s={s} onChange={setS} /> : null}
        {toCustomer && !s.delivery?.pod && onTheWay ? <RefusalPanel s={s} onChange={setS} /> : null}
        {toCustomer ? <DeliveryDocumentsPanel s={s} /> : null}

        {s.status === 'released' ? (
          <Card title={s.leg === 'jobwork_to_supplier' ? 'Hand over the material' : 'Record the pickup'} description="When the supplier has not, or JobWork arranged the vehicle.">
            <Stack gap={2}>
              <Select
                label="How it travels"
                placeholder="Choose"
                value={pickup.carrierMode}
                onChange={(e) => setPickup({ ...pickup, carrierMode: e.target.value as CarrierMode })}
                options={(Object.keys(CARRIER_MODE) as CarrierMode[]).filter((m) => !toCustomer || m !== 'supplier_vehicle').map((m) => ({ value: m, label: CARRIER_MODE[m] }))}
              />
              <TextInput label="Carrier" value={pickup.carrierName} onChange={(e) => setPickup({ ...pickup, carrierName: e.target.value })} />
              <TextInput label="Tracking or LR number" value={pickup.trackingReference} onChange={(e) => setPickup({ ...pickup, trackingReference: e.target.value })} />
              <CommandButton receiptLabel="Recorded" disabled={!pickup.carrierMode} disabledReason="Say how it travels" onCommand={() => post('/pickup', { expectedVersion: s.aggregateVersion, carrierMode: pickup.carrierMode, carrierName: pickup.carrierName.trim(), trackingReference: pickup.trackingReference.trim() })}>
                Picked up
              </CommandButton>
            </Stack>
          </Card>
        ) : null}

        {s.status === 'picked_up' || s.status === 'in_transit' ? (
          <Card title="Carrier update" description="What the carrier reported, when no carrier feed is connected.">
            <Stack gap={2}>
              <Select label="Status" placeholder="Choose" value={event.normalizedStatus} options={CARRIER_STATUSES} onChange={(e) => setEvent({ ...event, normalizedStatus: e.target.value as CarrierStatus })} />
              <TextInput label="As the carrier put it" value={event.rawStatus} onChange={(e) => setEvent({ ...event, rawStatus: e.target.value })} />
              <TextInput label="When" type="datetime-local" value={event.occurredAt} onChange={(e) => setEvent({ ...event, occurredAt: e.target.value })} />
              <CommandButton
                receiptLabel="Recorded"
                disabled={!event.normalizedStatus || !event.occurredAt}
                disabledReason="Choose the status and when"
                onCommand={async () => {
                  await post('/carrier-events', { providerEventId: crypto.randomUUID(), rawStatus: event.rawStatus.trim() || event.normalizedStatus, normalizedStatus: event.normalizedStatus, occurredAt: new Date(`${event.occurredAt}:00+05:30`).toISOString() });
                  setEvent({ normalizedStatus: '', rawStatus: '', occurredAt: '' });
                }}
              >
                Record update
              </CommandButton>
            </Stack>
          </Card>
        ) : null}

        {s.discrepancies.length > 0 ? (
          <Card title="Discrepancies" description="Each is resolved once. Quality decides what leaves quarantine for stock or scrap.">
            <Stack gap={3}>
              {s.discrepancies.map((d, i) => (
                <Stack key={d.discrepancyId} gap={1} style={i > 0 ? { borderTop: 'var(--hairline) solid var(--color-border)', paddingTop: 'var(--space-3)' } : undefined}>
                  <p>
                    <span className="mono">{d.number}</span> · <strong>{DISCREPANCY[d.kind]}</strong>
                    {Number(d.quantity) > 0 ? ` · ${pieces(d.quantity)}` : ''} — {d.description}
                  </p>
                  {d.status === 'open' ? (
                    <Resolve d={d} onResolved={setS} />
                  ) : (
                    <p style={{ font: 'var(--text-caption)' }}>
                      {d.resolution ? RESOLUTION[d.resolution] : ''} · {d.resolutionNote}
                      {d.caseReference ? ` · ${d.caseReference}` : ''} · {d.resolvedAt ? when(d.resolvedAt) : ''}
                    </p>
                  )}
                </Stack>
              ))}
            </Stack>
          </Card>
        ) : null}

        <Card title="Contents">
          <DataTable
            caption="Packages and lots"
            rows={lines}
            rowKey={(l) => l.itemId}
            columns={[
              { key: 'package', header: 'Pkg', render: (l) => l.packageNo },
              { key: 'lot', header: toCustomer ? 'Marking' : 'Lot', sticky: true, render: (l) => <span className="mono">{l.lotCode || '—'}</span> },
              ...(toCustomer ? [{ key: 'source', header: 'Released lot', render: (l: (typeof lines)[number]) => <span className="mono">{l.sourceLotCode || '—'}</span> }] : []),
              { key: 'shipped', header: 'Shipped', numeric: true, render: (l) => l.quantity },
              { key: 'counted', header: 'Counted', numeric: true, render: (l) => l.received?.countedQuantity ?? '—' },
              { key: 'accepted', header: 'Accepted', numeric: true, render: (l) => l.received?.split?.accepted ?? '—' },
              { key: 'quarantined', header: 'Quarantined', numeric: true, render: (l) => l.received?.split?.quarantined ?? '—' },
              { key: 'refused', header: 'Refused', numeric: true, render: (l) => l.received?.split?.refused ?? '—' },
            ]}
          />
        </Card>

        <Card title="Shipment">
          <DescriptionList
            columns={2}
            items={[
              { label: 'From', value: address(s.origin) },
              { label: 'To', value: address(s.destination) },
              { label: 'Documents', value: [s.documents.challanNumber && `Challan ${s.documents.challanNumber}`, s.documents.invoiceNumber && `Invoice ${s.documents.invoiceNumber}`, s.documents.eWaybillNumber && `E-way bill ${s.documents.eWaybillNumber}`].filter(Boolean).join(' · ') || '—' },
              { label: 'Carrier', value: s.carrier.mode ? `${CARRIER_MODE[s.carrier.mode]}${s.carrier.name ? ` · ${s.carrier.name}` : ''}${s.carrier.trackingReference ? ` · ${s.carrier.trackingReference}` : ''}` : '—' },
              { label: 'Released', value: s.releasedAt ? when(s.releasedAt) : '—' },
              { label: 'Received', value: s.receiving ? `${when(s.receiving.receivedAt)} · seal ${s.receiving.sealIntact ? 'intact' : 'broken'} · ${s.receiving.packages.filter((p) => p.condition !== 'ok').map((p) => `package ${p.packageNo} ${p.condition}`).join(', ') || 'packages sound'}` : '—' },
              { label: 'Work package', value: s.workPackageId ? <Link href={`/logistics/work-packages/${s.workPackageId}`}>Quantities and stock</Link> : '—' },
              { label: 'Order', value: <Link href={`/sales-orders/${s.salesOrderId}`}>Open the order</Link> },
            ]}
          />
        </Card>

        {s.carrierEvents.length > 0 ? (
          <Card title="Carrier history">
            <ul>
              {s.carrierEvents.map((e, i) => (
                <li key={i}>
                  {when(e.occurredAt)} · {e.normalizedStatus.replace(/_/g, ' ')} <span style={{ font: 'var(--text-caption)' }}>({e.provider}: {e.rawStatus})</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}
