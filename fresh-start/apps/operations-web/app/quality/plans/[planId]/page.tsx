'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { Characteristic, Inspection, QualityPlan, QualityUnit } from '@jobwork/contracts';
import { INSPECTION_STAGES } from '@jobwork/contracts/constants';
import { ButtonLink, Callout, Card, Checkbox, CommandButton, DescriptionList, ErrorState, Inline, LoadingState, Page, Select, Stack, StatusChip, TextInput, describeLimits } from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';
import { STAGE } from '../../labels';

type Row = {
  kind: 'variable' | 'attribute';
  drawingReference: string;
  name: string;
  criticality: 'critical' | 'major' | 'minor';
  mandatory: boolean;
  unit: string;
  nominal: string;
  lower: string;
  lowerInclusive: boolean;
  upper: string;
  upperInclusive: boolean;
  acceptedValues: string;
  stages: string[];
  method: string;
};

const fromCharacteristic = (c: Characteristic): Row => ({
  kind: c.kind,
  drawingReference: c.drawingReference,
  name: c.name,
  criticality: c.criticality,
  mandatory: c.mandatory,
  unit: c.unit ?? 'mm',
  nominal: c.nominal ?? '',
  lower: c.lower?.value ?? '',
  lowerInclusive: c.lower?.inclusive ?? true,
  upper: c.upper?.value ?? '',
  upperInclusive: c.upper?.inclusive ?? true,
  acceptedValues: c.acceptedValues.join(', '),
  stages: c.stages,
  method: c.method,
});

const toInput = (r: Row): Record<string, unknown> =>
  r.kind === 'attribute'
    ? { kind: 'attribute', drawingReference: r.drawingReference, name: r.name, criticality: r.criticality, mandatory: r.mandatory, acceptedValues: r.acceptedValues.split(',').map((v) => v.trim()).filter(Boolean), stages: r.stages, method: r.method }
    : {
        kind: 'variable',
        drawingReference: r.drawingReference,
        name: r.name,
        criticality: r.criticality,
        mandatory: r.mandatory,
        unit: r.unit,
        nominal: r.nominal || null,
        lower: r.lower ? { value: r.lower, inclusive: r.lowerInclusive } : null,
        upper: r.upper ? { value: r.upper, inclusive: r.upperInclusive } : null,
        stages: r.stages,
        method: r.method,
      };

/**
 * One quality plan (IN-14 F-14.4; doc 09 §9; FR-701): the characteristics from the drawing and
 * the template, each with its limits and the stages it is checked at, and the sample size per
 * stage. A draft is edited and approved; an approved plan is frozen and revised into a new
 * draft. Inspections are planned from the approved plan.
 */
export default function QualityPlanPage(): React.JSX.Element {
  const planId = useParams<{ planId: string }>().planId;
  const router = useRouter();
  const [plan, setPlan] = useState<QualityPlan | null>(null);
  const [units, setUnits] = useState<QualityUnit[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [stages, setStages] = useState<Array<{ stage: string; sampleSize: number }>>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [inspectStage, setInspectStage] = useState('');

  const show = useCallback((p: QualityPlan) => {
    setPlan(p);
    setRows(p.characteristics.map(fromCharacteristic));
    setStages(p.stages);
    setInspectStage(p.stages[0]?.stage ?? '');
  }, []);

  const load = useCallback(async () => {
    try {
      show(await api<QualityPlan>(`/quality-plans/${planId}`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [planId, show]);

  useEffect(() => {
    void load();
    api<QualityUnit[]>('/quality-units').then(setUnits).catch(() => setUnits([]));
  }, [load]);

  if (!plan) {
    return (
      <Page title="Quality plan" breadcrumb={<Link href="/quality">← Quality</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the plan" /></Card>}
      </Page>
    );
  }

  const draft = plan.status === 'draft';
  const set = (i: number, patch: Partial<Row>): void => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const post = async (path: string): Promise<QualityPlan> => api<QualityPlan>(`/quality-plans/${plan.planId}${path}`, { method: 'POST', body: { expectedVersion: plan.aggregateVersion }, idempotencyKey: crypto.randomUUID() });

  return (
    <Page
      title={`Quality plan v${plan.versionNo} — ${plan.workPackageNumber}`}
      breadcrumb={<Link href={`/sales-orders/${plan.salesOrderId}/production`}>← {plan.salesOrderNumber} production</Link>}
      width="wide"
      meta={
        <>
          <StatusChip tone={plan.status === 'approved' ? 'positive' : plan.status === 'draft' ? 'attention' : 'neutral'}>{plan.status}</StatusChip>
          <span className="mono">{plan.purchaseOrderNumber}</span>
          <span>{plan.supplierDisplayName}</span>
        </>
      }
    >
      <Stack gap={4}>
        <Card>
          <DescriptionList
            columns={2}
            items={[
              { label: 'Template', value: `${plan.templateLabel} v${plan.templateVersionNo}` },
              { label: 'Written against', value: plan.baselineNumber },
            ]}
          />
        </Card>
        {!plan.baselineCurrent ? (
          <Callout tone="attention" title="A newer baseline governs this order">
            {draft ? 'Saving the draft binds it to the baseline in force; review the characteristics against the new drawings first.' : 'Revise this plan against the new baseline before the next inspection.'}
          </Callout>
        ) : null}

        <Card title="Stages and sample sizes">
          <Inline gap={3}>
            {stages.map((s, i) => (
              <TextInput
                key={s.stage}
                label={`${STAGE[s.stage as Inspection['stage']]}: pieces`}
                type="number"
                numeric
                disabled={!draft}
                value={String(s.sampleSize)}
                onChange={(e) => setStages(stages.map((x, j) => (j === i ? { ...x, sampleSize: Number(e.target.value || '1') } : x)))}
              />
            ))}
            {draft ? (
              <Select
                label="Add a stage"
                value=""
                placeholder="Choose…"
                options={INSPECTION_STAGES.filter((s) => s !== 'customer_receiving' && !stages.some((x) => x.stage === s)).map((s) => ({ value: s, label: STAGE[s] }))}
                onChange={(e) => setStages([...stages, { stage: e.target.value, sampleSize: 1 }])}
              />
            ) : null}
          </Inline>
        </Card>

        <Card title="Characteristics" description={plan.requiresDrawingCharacteristic ? 'The template requires at least one characteristic from the drawing (with its balloon number).' : undefined}>
          <Stack gap={3}>
            {rows.map((r, i) =>
              draft ? (
                <div key={i} style={{ borderTop: 'var(--hairline) solid var(--color-border)', paddingTop: 'var(--space-3)' }}>
                  <Inline gap={2}>
                    <TextInput label="Balloon" value={r.drawingReference} onChange={(e) => set(i, { drawingReference: e.target.value })} />
                    <TextInput label="Characteristic" value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
                    <Select label="Kind" value={r.kind} options={[{ value: 'variable', label: 'Measured value' }, { value: 'attribute', label: 'Accept / reject' }]} onChange={(e) => set(i, { kind: e.target.value as Row['kind'] })} />
                    <Select label="Criticality" value={r.criticality} options={[{ value: 'critical', label: 'Critical' }, { value: 'major', label: 'Major' }, { value: 'minor', label: 'Minor' }]} onChange={(e) => set(i, { criticality: e.target.value as Row['criticality'] })} />
                    <Checkbox label="Mandatory" checked={r.mandatory} onChange={(e) => set(i, { mandatory: e.target.checked })} />
                  </Inline>
                  {r.kind === 'variable' ? (
                    <Inline gap={2}>
                      <Select label="Unit" value={r.unit} options={units.map((u) => ({ value: u.code, label: `${u.code} — ${u.label}` }))} onChange={(e) => set(i, { unit: e.target.value })} />
                      <TextInput label="Lower limit" numeric value={r.lower} onChange={(e) => set(i, { lower: e.target.value.trim() })} />
                      <Checkbox label="Lower included" checked={r.lowerInclusive} onChange={(e) => set(i, { lowerInclusive: e.target.checked })} />
                      <TextInput label="Upper limit" numeric value={r.upper} onChange={(e) => set(i, { upper: e.target.value.trim() })} />
                      <Checkbox label="Upper included" checked={r.upperInclusive} onChange={(e) => set(i, { upperInclusive: e.target.checked })} />
                    </Inline>
                  ) : (
                    <TextInput label="Accepted values (comma separated)" value={r.acceptedValues} onChange={(e) => set(i, { acceptedValues: e.target.value })} />
                  )}
                  <Inline gap={2}>
                    {stages.map((s) => (
                      <Checkbox
                        key={s.stage}
                        label={`At ${STAGE[s.stage as Inspection['stage']]}`}
                        checked={r.stages.includes(s.stage)}
                        onChange={(e) => set(i, { stages: e.target.checked ? [...r.stages, s.stage] : r.stages.filter((x) => x !== s.stage) })}
                      />
                    ))}
                    <TextInput label="Method" value={r.method} onChange={(e) => set(i, { method: e.target.value })} />
                    <CommandButton size="sm" variant="secondary" receiptLabel="Removed" onCommand={async () => setRows(rows.filter((_, j) => j !== i))}>
                      Remove
                    </CommandButton>
                  </Inline>
                </div>
              ) : (
                <div key={i} style={{ borderTop: 'var(--hairline) solid var(--color-border)', paddingTop: 'var(--space-2)' }}>
                  <strong>
                    {i + 1}. {r.name}
                  </strong>{' '}
                  <span className="numeric">{describeLimits({ ...plan.characteristics[i]!, id: plan.characteristics[i]!.characteristicId })}</span>
                  <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                    {[r.drawingReference ? `balloon ${r.drawingReference}` : null, r.criticality, r.mandatory ? 'mandatory' : null, r.stages.map((s) => STAGE[s as Inspection['stage']]).join(', ')].filter(Boolean).join(' · ')}
                  </span>
                </div>
              ),
            )}
            {draft ? (
              <Inline gap={2}>
                <CommandButton
                  variant="secondary"
                  size="sm"
                  receiptLabel="Added"
                  onCommand={async () =>
                    setRows([...rows, { kind: 'variable', drawingReference: '', name: '', criticality: 'major', mandatory: true, unit: 'mm', nominal: '', lower: '', lowerInclusive: true, upper: '', upperInclusive: true, acceptedValues: '', stages: stages.map((s) => s.stage), method: '' }])
                  }
                >
                  Add characteristic
                </CommandButton>
                <CommandButton
                  receiptLabel="Saved"
                  onCommand={async () => show(await api<QualityPlan>(`/quality-plans/${plan.planId}/draft`, { method: 'POST', body: { expectedVersion: plan.aggregateVersion, stages, characteristics: rows.map(toInput) }, idempotencyKey: crypto.randomUUID() }))}
                >
                  Save draft
                </CommandButton>
                <CommandButton variant="secondary" receiptLabel="Approved" onCommand={async () => show(await post('/approve'))}>
                  Approve plan
                </CommandButton>
              </Inline>
            ) : null}
          </Stack>
        </Card>

        {plan.status === 'approved' ? (
          <Card title="Inspect" description="Plan an inspection of one stage; the inspecting organization records it, and someone other than the inspector decides.">
            <Inline gap={2}>
              <Select label="Stage" value={inspectStage} options={plan.stages.map((s) => ({ value: s.stage, label: `${STAGE[s.stage]} — ${s.sampleSize} piece${s.sampleSize === 1 ? '' : 's'}` }))} onChange={(e) => setInspectStage(e.target.value)} />
              <CommandButton
                receiptLabel="Planned"
                disabled={!plan.baselineCurrent}
                disabledReason="Revise the plan against the baseline in force first"
                onCommand={async () => {
                  const created = await api<Inspection>('/inspections', { method: 'POST', body: { workPackageId: plan.workPackageId, stage: inspectStage }, idempotencyKey: crypto.randomUUID() });
                  router.push(`/quality/inspections/${created.inspectionId}`);
                }}
              >
                Plan inspection
              </CommandButton>
              <CommandButton variant="secondary" receiptLabel="Revision opened" onCommand={async () => router.push(`/quality/plans/${(await post('/revise')).planId}`)}>
                Revise plan
              </CommandButton>
            </Inline>
          </Card>
        ) : null}
        {plan.status === 'superseded' ? (
          <ButtonLink href={`/sales-orders/${plan.salesOrderId}/production`} variant="secondary">
            A later version governs — back to production
          </ButtonLink>
        ) : null}
      </Stack>
    </Page>
  );
}
