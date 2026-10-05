'use client';

import { useEffect, useState } from 'react';
import type { Shipment } from '@jobwork/contracts';
import { ButtonLink, Card, EmptyState, ErrorState, LoadingState, Page, RecordCard, RecordList, Stack, StatusChip } from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';
import { amount, day, statusOf } from './labels';

/** The supplier's shipments to JobWork (IN-16 F-16.4; doc 10 §11), newest first. */
export default function SupplierShipmentsPage(): React.JSX.Element {
  const [rows, setRows] = useState<Shipment[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<Shipment[]>('/supplier/shipments')
      .then(setRows)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  return (
    <Page title="Shipments" back={{ href: '/supplier', label: 'Back to home' }} description="What you send to JobWork: plan it from your released lots, JobWork releases it, you hand it to the carrier.">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {error ? null : rows === null ? (
          <Card>
            <LoadingState label="Loading your shipments" />
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState
              title="No shipments yet"
              detail="Once JobWork quality releases a lot on one of your purchase orders, plan its shipment from the purchase order."
              action={<ButtonLink href="/supplier/orders" variant="secondary">See purchase orders</ButtonLink>}
            />
          </Card>
        ) : (
          <RecordList>
            {rows.map((s) => (
              <RecordCard
                key={s.shipmentId}
                href={`/supplier/shipments/${s.shipmentId}`}
                reference={s.number}
                title={s.leg === 'jobwork_to_supplier' ? `${s.purchaseOrderNumber} · material from JobWork` : `${s.purchaseOrderNumber} · ${s.packages.length} package${s.packages.length === 1 ? '' : 's'}`}
                caption={s.carrier.trackingReference ? `${s.carrier.name} ${s.carrier.trackingReference}` : `planned ${day(s.createdAt)}`}
                figure={<span className="numeric">{amount(s)}</span>}
                status={<StatusChip tone={statusOf(s).tone}>{statusOf(s).label}</StatusChip>}
              />
            ))}
          </RecordList>
        )}
      </Stack>
    </Page>
  );
}
