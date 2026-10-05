'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CarrierMode, MaterialLot, Shipment } from '@jobwork/contracts';
import { Card, CommandButton, DataTable, Inline, Select, Stack, TextInput } from '@jobwork/ui';
import { api } from '../../../lib/api';
import { CARRIER_MODE } from '../../logistics/labels';

interface OrderPurchaseOrder {
  purchaseOrderId: string;
  number: string;
  supplierDisplayName: string;
  status: string;
}

const QUANTITY = /^\d{1,12}(\.\d{1,4})?$/;

/**
 * Customer-supplied material on the order (IN-16 F-16.5; D-15). Record what the customer sends,
 * receive it at the dock like any inbound shipment, and issue it to the supplier on JobWork's
 * challan. Hidden from roles that cannot read logistics.
 */
export function MaterialCard({ salesOrderId, purchaseOrders }: { salesOrderId: string; purchaseOrders: readonly OrderPurchaseOrder[] }): React.JSX.Element | null {
  const router = useRouter();
  const [lots, setLots] = useState<MaterialLot[] | null>(null);
  const [arriving, setArriving] = useState({ challan: '', carrierMode: '' as CarrierMode | '', carrierName: '', tracking: '', lotCode: '', quantity: '', unit: 'kg', description: '' });
  const [issue, setIssue] = useState({ purchaseOrderId: '', lotId: '', quantity: '', challan: '' });

  const load = useCallback(async () => {
    setLots(await api<MaterialLot[]>(`/logistics/sales-orders/${salesOrderId}/material`).catch(() => null));
  }, [salesOrderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (lots === null) return null;
  const acknowledged = purchaseOrders.filter((po) => po.status === 'acknowledged');
  const inStock = lots.filter((l) => Number(l.inStock) > 0);
  const chosen = lots.find((l) => l.lotId === issue.lotId);

  return (
    <Card title="Customer material" description="Material the customer supplies for the job: received onto lots the customer owns, issued to the supplier on JobWork’s challan. The supplier never sees whose it is.">
      <Stack gap={4}>
        <DataTable
          caption="Customer material lots"
          rows={lots}
          rowKey={(l) => l.lotId}
          columns={[
            { key: 'lot', header: 'Lot or heat', sticky: true, render: (l) => <span className="mono">{l.lotCode || '—'}</span> },
            { key: 'from', header: 'Received on', render: (l) => <span className="mono">{l.sourceShipmentNumber}</span> },
            { key: 'received', header: 'Received', numeric: true, render: (l) => `${l.receivedQuantity} ${l.unit}` },
            { key: 'stock', header: 'In stock', numeric: true, render: (l) => l.inStock },
            { key: 'quarantine', header: 'Quarantined', numeric: true, render: (l) => l.quarantined },
            { key: 'issued', header: 'Issued', numeric: true, render: (l) => l.issued },
          ]}
          empty={{ title: 'None received', detail: 'Record the customer’s material below when it is on its way; receive it from the logistics board.' }}
        />

        <Stack gap={2}>
          <strong>Material arriving from the customer</strong>
          <Inline gap={2} wrap>
            <TextInput label="Customer’s challan no." value={arriving.challan} onChange={(e) => setArriving({ ...arriving, challan: e.target.value })} />
            <Select label="Brought by" placeholder="Choose" value={arriving.carrierMode} options={(Object.keys(CARRIER_MODE) as CarrierMode[]).map((m) => ({ value: m, label: m === 'supplier_vehicle' ? 'Customer vehicle' : CARRIER_MODE[m] }))} onChange={(e) => setArriving({ ...arriving, carrierMode: e.target.value as CarrierMode })} />
            <TextInput label="Carrier" value={arriving.carrierName} onChange={(e) => setArriving({ ...arriving, carrierName: e.target.value })} />
            <TextInput label="LR or vehicle no." value={arriving.tracking} onChange={(e) => setArriving({ ...arriving, tracking: e.target.value })} />
          </Inline>
          <Inline gap={2} wrap>
            <TextInput label="Lot or heat no." value={arriving.lotCode} onChange={(e) => setArriving({ ...arriving, lotCode: e.target.value })} />
            <TextInput label="Quantity" numeric inputMode="decimal" value={arriving.quantity} onChange={(e) => setArriving({ ...arriving, quantity: e.target.value })} />
            <Select label="Unit" value={arriving.unit} options={['kg', 'm', 'sheet', 'piece'].map((u) => ({ value: u, label: u }))} onChange={(e) => setArriving({ ...arriving, unit: e.target.value })} />
            <TextInput label="What it is" value={arriving.description} onChange={(e) => setArriving({ ...arriving, description: e.target.value })} />
          </Inline>
          <div>
            <CommandButton
              variant="secondary"
              receiptLabel="Recorded"
              disabled={!arriving.challan.trim() || !arriving.carrierMode || !QUANTITY.test(arriving.quantity.trim())}
              disabledReason="Give the customer’s challan, how it comes, and the quantity"
              onCommand={async () => {
                const s = await api<Shipment>('/logistics/customer-material', {
                  method: 'POST',
                  idempotencyKey: crypto.randomUUID(),
                  body: {
                    salesOrderId,
                    documents: { challanNumber: arriving.challan.trim() },
                    carrierMode: arriving.carrierMode,
                    carrierName: arriving.carrierName.trim(),
                    trackingReference: arriving.tracking.trim(),
                    packages: [{ packageNo: 1, items: [{ lotCode: arriving.lotCode.trim(), quantity: arriving.quantity.trim(), unit: arriving.unit, description: arriving.description.trim() }] }],
                  },
                });
                router.push(`/logistics/shipments/${s.shipmentId}`);
              }}
            >
              Record and receive it
            </CommandButton>
          </div>
        </Stack>

        {inStock.length > 0 && acknowledged.length > 0 ? (
          <Stack gap={2}>
            <strong>Issue to the supplier</strong>
            <Inline gap={2} wrap>
              <Select label="Purchase order" placeholder="Choose" value={issue.purchaseOrderId} options={acknowledged.map((po) => ({ value: po.purchaseOrderId, label: `${po.number} — ${po.supplierDisplayName}` }))} onChange={(e) => setIssue({ ...issue, purchaseOrderId: e.target.value })} />
              <Select label="Lot" placeholder="Choose" value={issue.lotId} options={inStock.map((l) => ({ value: l.lotId, label: `${l.lotCode || '—'} — ${l.inStock} ${l.unit} in stock` }))} onChange={(e) => setIssue({ ...issue, lotId: e.target.value })} />
              <TextInput label={chosen ? `Quantity (${chosen.unit})` : 'Quantity'} numeric inputMode="decimal" value={issue.quantity} onChange={(e) => setIssue({ ...issue, quantity: e.target.value })} />
              <TextInput label="JobWork challan no." value={issue.challan} onChange={(e) => setIssue({ ...issue, challan: e.target.value })} />
            </Inline>
            <div>
              <CommandButton
                variant="secondary"
                receiptLabel="Issued"
                disabled={!issue.purchaseOrderId || !issue.lotId || !QUANTITY.test(issue.quantity.trim()) || !issue.challan.trim()}
                disabledReason="Choose the purchase order and lot, and give the quantity and JobWork’s challan"
                onCommand={async () => {
                  const s = await api<Shipment>('/logistics/material-issues', {
                    method: 'POST',
                    idempotencyKey: crypto.randomUUID(),
                    body: { purchaseOrderId: issue.purchaseOrderId, documents: { challanNumber: issue.challan.trim() }, lots: [{ lotId: issue.lotId, quantity: issue.quantity.trim() }] },
                  });
                  router.push(`/logistics/shipments/${s.shipmentId}`);
                }}
              >
                Issue material
              </CommandButton>
            </div>
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}
