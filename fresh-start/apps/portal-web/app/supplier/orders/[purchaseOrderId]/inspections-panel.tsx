'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Inspection } from '@jobwork/contracts';
import { Card, Inline, Stack, StatusChip, useCommandTick } from '@jobwork/ui';
import { api } from '../../../../lib/api';
import { STAGE } from '../../inspection-labels';

/** Inspections JobWork planned on this purchase order (IN-14 F-14.4), each a link to record or read it. */
export function InspectionsPanel({ purchaseOrderId }: { purchaseOrderId: string }): React.JSX.Element | null {
  const [rows, setRows] = useState<Inspection[]>([]);
  const tick = useCommandTick();

  const load = useCallback(async () => {
    const all = await api<Inspection[]>('/supplier/inspections').catch(() => []);
    setRows(all.filter((i) => i.purchaseOrderId === purchaseOrderId));
  }, [purchaseOrderId]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  if (rows.length === 0) return null;
  return (
    <Card title="Inspections" description="Measure each characteristic on each piece and submit; JobWork quality reviews the results.">
      <Stack gap={2}>
        {rows.map((i) => (
          <Inline key={i.inspectionId} gap={3}>
            <Link href={`/supplier/inspections/${i.inspectionId}`} className="mono">
              {i.number}
            </Link>
            <span>
              {STAGE[i.stage]} · {i.sampleSize} piece{i.sampleSize === 1 ? '' : 's'}
            </span>
            <StatusChip tone={i.status === 'passed' ? 'positive' : i.status === 'failed' ? 'blocked' : i.status === 'planned' || i.status === 'in_progress' ? 'attention' : 'progress'}>{i.status.replace(/_/g, ' ')}</StatusChip>
          </Inline>
        ))}
      </Stack>
    </Card>
  );
}
