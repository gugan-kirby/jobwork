'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Evaluation } from '@jobwork/contracts';
import { Card, CopyableId, DataTable, DescriptionList, ErrorState, LoadingState, Page, Stack, StatusChip, formatMoney, type Column } from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * A stored comparison (F-07.2, doc 21 comparison table): the original column is what
 * the supplier wrote, the normalized column is what the scenario makes of it, and the
 * two are visibly labelled so nobody mistakes one for the other.
 */
export default function EvaluationPage(): React.JSX.Element {
  const evaluationId = useParams<{ evaluationId: string }>().evaluationId;
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<Evaluation>(`/evaluations/${evaluationId}`)
      .then(setEvaluation)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, [evaluationId]);

  if (!evaluation) {
    return (
      <Page title="Comparison" breadcrumb={<Link href="/rfqs">← Control room</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the comparison" /></Card>}
      </Page>
    );
  }

  const money = (minor: number): string => formatMoney({ amountMinor: minor, currency: evaluation.currency });
  const columns: Array<Column<Evaluation['rows'][number]>> = [
    { key: 'rank', header: '#', numeric: true, render: (r) => r.rank },
    { key: 'supplier', header: 'Supplier', render: (r) => `${r.supplierDisplayName} v${r.versionNo}` },
    { key: 'original', header: 'Original (as bid)', numeric: true, render: (r) => money(r.originalTotalMinor) },
    { key: 'normalized', header: 'Normalized landed', numeric: true, render: (r) => <strong>{money(r.normalizedLandedMinor)}</strong> },
    { key: 'items', header: 'Items ex tax', numeric: true, render: (r) => money(r.components.itemCostExTaxMinor) },
    { key: 'nre', header: 'NRE', numeric: true, render: (r) => money(r.components.nreMinor) },
    { key: 'freight', header: 'Freight', numeric: true, render: (r) => money(r.components.freightMinor) },
    { key: 'extras', header: 'Insp./fin./tax', numeric: true, render: (r) => money(r.components.inspectionPackagingMinor + r.components.financingRiskMinor + r.components.nonRecoverableTaxMinor) },
    { key: 'lead', header: 'Lead', numeric: true, render: (r) => `${r.leadTimeDays} d` },
    { key: 'valid', header: 'Valid to', render: (r) => r.validityUntil },
    {
      key: 'flags',
      header: 'Flags',
      render: (r) => (
        <span style={{ display: 'inline-flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
          {r.flags.map((f) => (
            <StatusChip key={f} tone={f === 'not_feasible' ? 'blocked' : 'attention'} silent>{f.replace(/_/g, ' ')}</StatusChip>
          ))}
          {r.feasibility !== 'feasible' ? <StatusChip tone="special" silent>{r.feasibility.replace(/_/g, ' ')}</StatusChip> : null}
        </span>
      ),
    },
  ];

  return (
    <Page title="Bid comparison" breadcrumb={<Link href={`/rfqs/${evaluation.rfqId}`}>← Sourcing round</Link>} width="wide" description="Originals untouched; normalized under one scenario so the numbers mean the same thing.">
      <Stack gap={4}>
        <Card title="Scenario">
          <DescriptionList
            columns={2}
            items={[
              { label: 'Freight', value: evaluation.scenario.freightPolicy === 'estimate' ? `estimate ${money(evaluation.scenario.freightEstimateMinor)}` : 'as quoted' },
              { label: 'NRE allocation', value: evaluation.scenario.nreAllocation },
              { label: 'Inspection/packaging', value: money(evaluation.scenario.inspectionPackagingMinor), numeric: true },
              { label: 'Financing/risk', value: `${(evaluation.scenario.financingRiskBp / 100).toFixed(2)} %`, numeric: true },
              { label: 'GST', value: `${(evaluation.scenario.gstRateBp / 100).toFixed(0)} % · ${evaluation.scenario.taxAssumption.replace(/_/g, ' ')}` },
              { label: 'Config', value: evaluation.configVersion, mono: true },
            ]}
          />
          <div style={{ marginTop: 'var(--space-3)' }}>
            <CopyableId label="Scenario hash" value={evaluation.scenarioHash} />
          </div>
        </Card>
        <Card title="Rows" flush>
          <DataTable caption="Normalized comparison" columns={columns} rows={evaluation.rows} rowKey={(r) => r.bidVersionId} stackTitle={(r) => `#${r.rank} ${r.supplierDisplayName}`} />
        </Card>
      </Stack>
    </Page>
  );
}
