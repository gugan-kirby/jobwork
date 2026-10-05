'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Shipment } from '@jobwork/contracts';
import { Callout, LoadingState, Page } from '@jobwork/ui';
import { api } from '../../../../lib/api';
import { ShipmentEditor } from '../shipment-editor';

/** Plan a shipment on one purchase order (IN-16 F-16.4). */
export default function NewShipmentPage(): React.JSX.Element {
  // useSearchParams needs a boundary, or the whole route opts out of static rendering.
  return (
    <Suspense fallback={<Page title="Plan a shipment"><LoadingState label="Loading" /></Page>}>
      <NewShipment />
    </Suspense>
  );
}

function NewShipment(): React.JSX.Element {
  const purchaseOrderId = useSearchParams().get('purchaseOrderId') ?? '';
  const router = useRouter();
  return (
    <Page title="Plan a shipment" breadcrumb={<Link href={purchaseOrderId ? `/supplier/orders/${purchaseOrderId}` : '/supplier/shipments'}>← Back</Link>} description="Pack released lots into numbered packages. Save, check the guards, then submit it for JobWork to release.">
      {purchaseOrderId ? (
        <ShipmentEditor
          purchaseOrderId={purchaseOrderId}
          saveLabel="Save the plan"
          onSave={async (body) => {
            const s = await api<Shipment>('/supplier/shipments', { method: 'POST', body: { purchaseOrderId, ...body }, idempotencyKey: crypto.randomUUID() });
            router.push(`/supplier/shipments/${s.shipmentId}`);
          }}
        />
      ) : (
        <Callout tone="attention" title="Start from a purchase order">Open the purchase order you are shipping against and plan the shipment from there.</Callout>
      )}
    </Page>
  );
}
