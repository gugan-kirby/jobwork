'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { CarrierMode, Shipment, SiteSnapshot } from '@jobwork/contracts';
import { Button, Callout, Card, CommandButton, DataTable, DescriptionList, ErrorState, GateMatrix, LoadingState, Page, Select, Stack, StatusChip, TextArea, TextInput } from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';
import { amount, CARRIER_MODE, day, DISCREPANCY, RESOLUTION, statusOf } from '../labels';
import { ShipmentEditor } from '../shipment-editor';

const address = (s: SiteSnapshot | null): string => (s ? `${s.label}, ${s.addressLine1}, ${s.city} ${s.postalCode}` : '—');

/**
 * One shipment to JobWork (IN-16 F-16.4; doc 10 §§11–13). The supplier plans and submits it, sees
 * every guard JobWork checks before release, hands it to the carrier once released, and sees what
 * JobWork counted and any discrepancy. Where JobWork put the pieces stays JobWork's.
 */
export default function SupplierShipmentPage(): React.JSX.Element {
  const shipmentId = useParams<{ shipmentId: string }>().shipmentId;
  const [s, setS] = useState<Shipment | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState(false);
  const [pickup, setPickup] = useState<{ carrierMode: CarrierMode | ''; carrierName: string; trackingReference: string }>({ carrierMode: '', carrierName: '', trackingReference: '' });
  const [cancelReason, setCancelReason] = useState('');
  const [receiptNote, setReceiptNote] = useState('');

  const load = useCallback(async () => {
    try {
      setS(await api<Shipment>(`/supplier/shipments/${shipmentId}`));
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
      <Page title="Shipment" breadcrumb={<Link href="/supplier/shipments">← Shipments</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the shipment" /></Card>}
      </Page>
    );
  }

  const post = async (path: string, body: Record<string, unknown>): Promise<void> => {
    setS(await api<Shipment>(`/supplier/shipments/${s.shipmentId}${path}`, { method: 'POST', body, idempotencyKey: crypto.randomUUID() }));
  };
  const issued = s.leg === 'jobwork_to_supplier';
  const preparing = !issued && (s.status === 'planned' || s.status === 'ready_for_release');
  const green = s.guards.every((g) => g.pass);
  const lines = s.packages.flatMap((p) => p.items.map((i) => ({ ...i, packageNo: p.packageNo })));
  const carrierNeedsReference = pickup.carrierMode === 'carrier' || pickup.carrierMode === 'courier';

  return (
    <Page
      title={issued ? `${s.number} — material from JobWork` : `${s.number} — ${s.purchaseOrderNumber}`}
      breadcrumb={<Link href={s.purchaseOrderId ? `/supplier/orders/${s.purchaseOrderId}` : '/supplier/shipments'}>← {s.purchaseOrderNumber || 'Shipments'}</Link>}
      meta={<StatusChip tone={statusOf(s).tone}>{statusOf(s).label}</StatusChip>}
    >
      <Stack gap={4}>
        {s.status === 'discrepancy_hold' ? <Callout tone="blocked" title="JobWork found a discrepancy at receiving">The shipment is on hold until each one below is resolved. JobWork will contact you about anything to replace or take back.</Callout> : null}
        {s.status === 'ready_for_release' ? <Callout tone="neutral" title="With JobWork">JobWork logistics checks the guards again and releases the shipment; you will be told when to hand it over.</Callout> : null}

        {preparing && editing && s.purchaseOrderId ? (
          <ShipmentEditor
            purchaseOrderId={s.purchaseOrderId}
            shipment={s}
            saveLabel="Save changes"
            onSave={async (body) => {
              await post('/replan', { expectedVersion: s.aggregateVersion, ...body });
              setEditing(false);
            }}
          />
        ) : null}

        {preparing && !editing ? (
          <Card title="Before JobWork releases it" description="Every guard must be green to submit. JobWork checks them again at release.">
            <Stack gap={3}>
              <GateMatrix gates={s.guards} label={`Release guards for ${s.number}`} />
              <Stack gap={2}>
                {s.status === 'planned' ? (
                  <CommandButton receiptLabel="Submitted" disabled={!green} disabledReason="Fix the red guards first" onCommand={() => post('/submit', { expectedVersion: s.aggregateVersion })}>
                    Submit for release
                  </CommandButton>
                ) : null}
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  Change packages or documents
                </Button>
              </Stack>
            </Stack>
          </Card>
        ) : null}

        {issued && ['picked_up', 'in_transit', 'delivered_to_destination'].includes(s.status) ? (
          <Card title="Confirm the material arrived" description={`Material for ${s.purchaseOrderNumber}, sent on JobWork’s challan ${s.documents.challanNumber}. Confirm once it is with you; tell JobWork at once if anything is short or damaged.`}>
            <Stack gap={2}>
              <TextInput label="Note (optional)" value={receiptNote} onChange={(e) => setReceiptNote(e.target.value)} />
              <CommandButton receiptLabel="Confirmed" onCommand={() => post('/acknowledge-receipt', { expectedVersion: s.aggregateVersion, note: receiptNote.trim() })}>
                Material received
              </CommandButton>
            </Stack>
          </Card>
        ) : null}

        {!issued && s.status === 'released' ? (
          <Card title="Hand it to the carrier" description="Record who took it and their tracking or LR number; JobWork follows it from there.">
            <Stack gap={2}>
              <Select label="How it travels" placeholder="Choose" value={pickup.carrierMode} onChange={(e) => setPickup({ ...pickup, carrierMode: e.target.value as CarrierMode })} options={(['carrier', 'courier', 'supplier_vehicle'] as const).map((m) => ({ value: m, label: CARRIER_MODE[m] }))} />
              <TextInput label={pickup.carrierMode === 'supplier_vehicle' ? 'Driver or vehicle (optional)' : 'Carrier'} value={pickup.carrierName} onChange={(e) => setPickup({ ...pickup, carrierName: e.target.value })} />
              <TextInput label={pickup.carrierMode === 'supplier_vehicle' ? 'Vehicle number (optional)' : 'Tracking or LR number'} value={pickup.trackingReference} onChange={(e) => setPickup({ ...pickup, trackingReference: e.target.value })} />
              <CommandButton
                receiptLabel="Recorded"
                disabled={!pickup.carrierMode || (carrierNeedsReference && (!pickup.carrierName.trim() || !pickup.trackingReference.trim()))}
                disabledReason="Say how it travels, and name the carrier with its reference"
                onCommand={() => post('/pickup', { expectedVersion: s.aggregateVersion, carrierMode: pickup.carrierMode, carrierName: pickup.carrierName.trim(), trackingReference: pickup.trackingReference.trim() })}
              >
                Picked up
              </CommandButton>
            </Stack>
          </Card>
        ) : null}

        <Card title="Shipment">
          <DescriptionList
            columns={2}
            items={[
              { label: 'From', value: address(s.origin) },
              { label: 'To', value: address(s.destination) },
              { label: 'Documents', value: [s.documents.challanNumber && `Challan ${s.documents.challanNumber}`, s.documents.invoiceNumber && `Invoice ${s.documents.invoiceNumber}`, s.documents.eWaybillNumber && `E-way bill ${s.documents.eWaybillNumber}`].filter(Boolean).join(' · ') || '—' },
              { label: 'Carrier', value: s.carrier.mode ? `${CARRIER_MODE[s.carrier.mode]}${s.carrier.name ? ` · ${s.carrier.name}` : ''}${s.carrier.trackingReference ? ` · ${s.carrier.trackingReference}` : ''}` : 'Not yet picked up' },
              { label: 'Released', value: s.releasedAt ? day(s.releasedAt) : '—' },
              { label: 'Picked up', value: s.pickedUpAt ? day(s.pickedUpAt) : '—' },
            ]}
          />
        </Card>

        <Card title={`Contents — ${amount(s)}`}>
          <DataTable
            caption="Packages and lots"
            rows={lines}
            rowKey={(l) => l.itemId}
            columns={[
              { key: 'package', header: 'Package', render: (l) => l.packageNo },
              { key: 'lot', header: 'Lot', render: (l) => <span className="mono">{l.lotCode || '—'}</span> },
              { key: 'pieces', header: 'Quantity', numeric: true, render: (l) => `${l.quantity}${l.unit === 'piece' ? '' : ` ${l.unit}`}` },
              ...(issued
                ? []
                : [
                    {
                      key: 'counted',
                      header: 'Counted by JobWork',
                      numeric: true,
                      render: (l: (typeof lines)[number]) => s.receiving?.lines.find((r) => r.itemId === l.itemId)?.countedQuantity ?? '—',
                    },
                  ]),
            ]}
          />
        </Card>

        {s.carrierEvents.length > 0 ? (
          <Card title="Carrier updates">
            <ul>
              {s.carrierEvents.map((e, i) => (
                <li key={i}>
                  {day(e.occurredAt)} · {e.normalizedStatus.replace(/_/g, ' ')}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {s.discrepancies.length > 0 ? (
          <Card title="Discrepancies at receiving">
            <Stack gap={2}>
              {s.discrepancies.map((d) => (
                <div key={d.discrepancyId}>
                  <p>
                    <span className="mono">{d.number}</span> · {DISCREPANCY[d.kind]}
                    {Number(d.quantity) > 0 ? ` · ${d.quantity} ${d.quantity === '1' ? 'piece' : 'pieces'}` : ''} — {d.description}
                  </p>
                  <p style={{ font: 'var(--text-caption)' }}>{d.status === 'open' ? 'Open: JobWork is deciding' : `Resolved ${d.resolvedAt ? day(d.resolvedAt) : ''}: ${d.resolution ? RESOLUTION[d.resolution] : ''}`}</p>
                </div>
              ))}
            </Stack>
          </Card>
        ) : null}

        {preparing ? (
          <Card title="Cancel this shipment">
            <Stack gap={2}>
              <TextArea label="Why" rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
              <CommandButton variant="danger" receiptLabel="Cancelled" disabled={cancelReason.trim().length < 3} disabledReason="Say why" onCommand={() => post('/cancel', { expectedVersion: s.aggregateVersion, reason: cancelReason.trim() })}>
                Cancel shipment
              </CommandButton>
            </Stack>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}
