'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { QualityRelease, ReleaseChecklist, ReleaseFactsView } from '@jobwork/contracts';
import { Callout, Card, CommandButton, CopyableId, DescriptionList, GateMatrix, Inline, Page, Stack, StatusChip, TextInput } from '@jobwork/ui';
import { api } from '../../../../lib/api';

const qty = (q: string): string => String(Number(q));
const when = (iso: string): string => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) + ' IST';

/**
 * Quality release of one work package (IN-15 F-15.5; doc 09 §14; FR-706): the checklist computed
 * for the quantity and lots proposed, the independent decision once every item is green, and
 * every release so far with the hash of its frozen snapshot. Nothing on this page ticks a box.
 */
export default function ReleasePage(): React.JSX.Element {
  const workPackageId = useParams<{ workPackageId: string }>().workPackageId;
  const [facts, setFacts] = useState<ReleaseFactsView | null>(null);
  const [history, setHistory] = useState<QualityRelease[]>([]);
  const [checklist, setChecklist] = useState<ReleaseChecklist | null>(null);
  const [scope, setScope] = useState({ quantity: '', lots: '' });

  const load = useCallback(async () => {
    setFacts(await api<ReleaseFactsView>(`/work-packages/${workPackageId}/release-facts`).catch(() => null));
    setHistory(await api<QualityRelease[]>(`/quality-releases?workPackageId=${workPackageId}`).catch(() => []));
  }, [workPackageId]);

  useEffect(() => {
    void load();
  }, [load]);

  const body = () => ({ workPackageId, quantity: scope.quantity, lots: scope.lots.split(',').map((x) => x.trim()).filter(Boolean), serials: [] });
  const remaining = facts ? Number(facts.orderedQuantity) - Number(facts.releasedQuantity) : null;

  return (
    <Page title="Quality release" breadcrumb={<Link href="/quality">← Quality</Link>} description="An independent decision over a computed checklist (doc 09 §14). A release is frozen with its evidence; a later defect holds parts without rewriting it." width="wide">
      <Stack gap={4}>
        {facts ? (
          <Card>
            <DescriptionList
              columns={2}
              items={[
                { label: 'Ordered', value: qty(facts.orderedQuantity) },
                { label: 'Released', value: qty(facts.releasedQuantity) },
                { label: 'Open NCRs', value: facts.openNcrs.length === 0 ? 'none' : facts.openNcrs.map((n) => `${n.number}${n.lots.length ? ` (${n.lots.join(', ')})` : ''}`).join('; ') },
                ...(facts.activeDeviations.length ? [{ label: 'Active deviations', value: facts.activeDeviations.map((d) => `${d.number}: ${qty(d.quantity)} parts${d.lots.length ? ` in ${d.lots.join(', ')}` : ''}`).join('; ') }] : []),
                ...(facts.ncrsSinceLastRelease.length ? [{ label: 'Opened since the last release', value: facts.ncrsSinceLastRelease.map((n) => n.number).join(', ') }] : []),
              ]}
            />
          </Card>
        ) : null}

        <Card title="Release scope">
          <Stack gap={3}>
            <Inline gap={2}>
              <TextInput label={`Parts${remaining !== null ? ` (up to ${remaining})` : ''}`} inputMode="decimal" value={scope.quantity} onChange={(e) => setScope({ ...scope, quantity: e.target.value.trim() })} />
              <TextInput label="Lots (comma separated)" value={scope.lots} onChange={(e) => setScope({ ...scope, lots: e.target.value })} />
              <CommandButton variant="secondary" receiptLabel="Checked" disabled={!scope.quantity} disabledReason="Give the quantity" onCommand={async () => setChecklist(await api<ReleaseChecklist>('/quality-releases/checklist', { method: 'POST', body: body(), idempotencyKey: crypto.randomUUID() }))}>
                Check
              </CommandButton>
            </Inline>
            {checklist ? (
              <>
                <GateMatrix gates={checklist.items.map((i) => ({ key: i.key, label: i.label, pass: i.pass, reasons: i.reasons }))} label="Quality release checklist" />
                {checklist.deviationsReliedOn.length > 0 ? <Callout tone="neutral" title="Relies on deviations">{checklist.deviationsReliedOn.join(', ')}</Callout> : null}
                <CommandButton
                  receiptLabel="Released"
                  disabled={!checklist.allGreen}
                  disabledReason="Every item must be green"
                  onCommand={async () => {
                    await api<QualityRelease>('/quality-releases', { method: 'POST', body: body(), idempotencyKey: crypto.randomUUID() });
                    setChecklist(null);
                    setScope({ quantity: '', lots: '' });
                    await load();
                  }}
                >
                  Authorize release
                </CommandButton>
              </>
            ) : null}
          </Stack>
        </Card>

        <Card title="Releases">
          <Stack gap={2}>
            {history.length === 0 ? <p style={{ color: 'var(--color-text-muted)' }}>Nothing released yet.</p> : null}
            {history.map((r) => (
              <Inline key={r.releaseId} gap={3}>
                <strong className="mono">{r.number}</strong>
                <StatusChip tone="positive">{qty(r.quantity)} parts</StatusChip>
                <span>{r.lots.join(', ') || 'no lots named'}</span>
                <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>{when(r.releasedAt)}</span>
                <CopyableId label="Snapshot hash" value={r.snapshotSha256} />
              </Inline>
            ))}
          </Stack>
        </Card>
      </Stack>
    </Page>
  );
}
