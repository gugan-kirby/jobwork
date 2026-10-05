import { createHash } from 'node:crypto';
import { Rational } from './rational';

/**
 * The quality release checklist (IN-15 F-15.4; doc 09 §14; FR-706; BR-QLT-01, BR-QLT-03).
 * Computed from records, never ticked: each item passes or fails with the reasons and the
 * evidence it read. A release is the independent decision over a checklist with every item
 * green, frozen as a snapshot whose SHA-256 anyone can recompute.
 */

export type ChecklistKey = 'baseline' | 'milestones' | 'certificates' | 'inspections' | 'calibrations' | 'ncrs' | 'quantity' | 'packaging' | 'releaser';

export interface ChecklistItem {
  key: ChecklistKey;
  label: string;
  pass: boolean;
  reasons: string[];
  evidence: Record<string, string | number | boolean | null | string[]>;
}

export interface CountedInspection {
  id: string;
  number: string;
  stage: string;
  status: string;
  submittedBy: string | null;
  /** Failing standing results, with whether an active deviation covers each. */
  failing: Array<{ characteristic: string; sampleNo: number; covered: boolean }>;
  /** Standing results taken past calibration, with whether JobWork accepted them. */
  calibrationFlags: Array<{ characteristic: string; sampleNo: number; accepted: boolean }>;
  attachments: Array<{ filename: string; clean: boolean }>;
}

export interface ReleaseFacts {
  releasedBaseline: { id: string; number: string } | null;
  acknowledgedBaselineId: string | null;
  milestones: Array<{ title: string; status: string }>;
  planStages: string[];
  /** The latest inspection of each stage that was not invalidated. */
  latestByStage: Map<string, CountedInspection>;
  ncrs: Array<{ number: string; status: string; path: 'rework' | 'deviation' | 'rejected' | 'open'; lots: string[] }>;
  activeDeviations: Array<{ id: string; number: string; ncrNumber: string; lots: string[]; quantity: string; releasedUnder: string }>;
  orderedQuantity: string;
  releasedQuantity: string;
  scope: { quantity: string; lots: string[]; serials: string[] };
  releaser: { userId: string; isQuality: boolean };
}

const RESOLVED_UNDER_DEVIATION = ['accepted_under_deviation'];
const PACKING = /pack/i;

export function computeChecklist(f: ReleaseFacts): { items: ChecklistItem[]; deviationsReliedOn: string[] } {
  const item = (key: ChecklistKey, label: string, reasons: string[], evidence: ChecklistItem['evidence']): ChecklistItem => ({ key, label, pass: reasons.length === 0, reasons, evidence });
  const counted = [...f.latestByStage.values()];

  // 1. The baseline in force, acknowledged by the supplier.
  const baseline: string[] = [];
  if (!f.releasedBaseline) baseline.push('No baseline is released.');
  else if (f.acknowledgedBaselineId !== f.releasedBaseline.id) baseline.push(`The supplier has not acknowledged ${f.releasedBaseline.number}, the baseline in force.`);

  // 2 and 8. Milestones, and the packing one in particular.
  const unverified = f.milestones.filter((m) => m.status !== 'verified' && m.status !== 'waived');
  const packing = f.milestones.filter((m) => PACKING.test(m.title));

  // 3. Certificates and other attachments on what counts.
  const dirty = counted.flatMap((i) => i.attachments.filter((a) => !a.clean).map((a) => `${a.filename} on ${i.number}`));

  // 4. Every plan stage inspected: passed, or failed with every failure under an active deviation.
  const inspections: string[] = [];
  for (const stage of f.planStages) {
    const i = f.latestByStage.get(stage);
    if (!i) inspections.push(`No ${stage.replace(/_/g, ' ')} inspection yet.`);
    else if (i.status === 'failed') {
      const open = i.failing.filter((x) => !x.covered);
      if (open.length > 0) inspections.push(`${i.number} (${stage.replace(/_/g, ' ')}) failed: ${open.map((x) => `${x.characteristic} on sample ${x.sampleNo}`).join(', ')} not covered by an active deviation.`);
    } else if (i.status !== 'passed') inspections.push(`${i.number} (${stage.replace(/_/g, ' ')}) is ${i.status.replace(/_/g, ' ')}.`);
  }

  // 5. Calibrations valid or accepted.
  const calibrations = counted.flatMap((i) => i.calibrationFlags.filter((c) => !c.accepted).map((c) => `${c.characteristic} on sample ${c.sampleNo} of ${i.number}`));

  // 6. NCRs closed, or resolved under an active deviation.
  const ncrs: string[] = [];
  for (const n of f.ncrs) {
    if (n.status === 'closed' || RESOLVED_UNDER_DEVIATION.includes(n.status)) {
      if (n.path === 'deviation' && !f.activeDeviations.some((d) => d.ncrNumber === n.number)) ncrs.push(`${n.number} rests on a deviation that is no longer active.`);
    } else ncrs.push(`${n.number} is ${n.status.replace(/_/g, ' ')}.`);
  }

  // 7. Quantity and identity: within what was ordered, never a held lot, a deviation's lots only on their own.
  const quantity: string[] = [];
  const want = Rational.parse(f.scope.quantity);
  const left = Rational.parse(f.orderedQuantity).sub(Rational.parse(f.releasedQuantity));
  if (want.compare(left) > 0) quantity.push(`Only ${left.toDisplay(4)} of ${f.orderedQuantity} remain to release.`);
  const held = new Set<string>();
  for (const n of f.ncrs) {
    if (n.path === 'rework' && (n.status === 'closed' || n.status === 'verified')) continue;
    const covered = n.path === 'deviation' ? f.activeDeviations.filter((d) => d.ncrNumber === n.number).flatMap((d) => d.lots) : [];
    for (const lot of n.lots) if (!covered.includes(lot)) held.add(lot);
  }
  const blockedLots = f.scope.lots.filter((l) => held.has(l));
  if (blockedLots.length > 0) quantity.push(`Held under an NCR: ${blockedLots.join(', ')}.`);
  const deviationsReliedOn = f.activeDeviations.filter((d) => d.lots.some((l) => f.scope.lots.includes(l)));
  for (const d of deviationsReliedOn) {
    const outside = f.scope.lots.filter((l) => !d.lots.includes(l));
    if (outside.length > 0) quantity.push(`Lots under ${d.number} release on their own, not with ${outside.join(', ')}.`);
    const remaining = Rational.parse(d.quantity).sub(Rational.parse(d.releasedUnder));
    if (want.compare(remaining) > 0) quantity.push(`${d.number} covers ${remaining.toDisplay(4)} more parts at most.`);
  }
  if (f.ncrs.some((n) => n.lots.length > 0) && f.scope.lots.length === 0) quantity.push('Name the lots released: an NCR on this work package is scoped by lot.');

  // 9. An independent releaser (BR-QLT-03; doc 03 §4).
  const releaser: string[] = [];
  if (!f.releaser.isQuality) releaser.push('Only JobWork quality releases.');
  const created = counted.filter((i) => i.submittedBy === f.releaser.userId).map((i) => i.number);
  if (created.length > 0) releaser.push(`You submitted results counted here (${created.join(', ')}); someone else releases.`);

  const items: ChecklistItem[] = [
    item('baseline', 'Baseline in force, acknowledged', baseline, { baseline: f.releasedBaseline?.number ?? null }),
    item('milestones', 'Operations and milestones verified', unverified.map((m) => `${m.title} is ${m.status.replace(/_/g, ' ')}.`), { milestones: f.milestones.length }),
    item('certificates', 'Certificates and attachments clean', dirty.map((d) => `${d} is not clean.`), { attachments: counted.reduce((n, i) => n + i.attachments.length, 0) }),
    item('inspections', 'First article and final inspections complete', inspections, { inspections: counted.map((i) => `${i.number} ${i.stage} ${i.status}`) }),
    item('calibrations', 'Calibrations valid or dispositioned', calibrations.map((c) => `${c} was measured past calibration without acceptance.`), { flagged: calibrations.length }),
    item('ncrs', 'NCRs closed or under an active deviation', ncrs, { ncrs: f.ncrs.map((n) => `${n.number} ${n.status}`) }),
    item('quantity', 'Quantity and lots match', quantity, { quantity: f.scope.quantity, lots: f.scope.lots, ordered: f.orderedQuantity, alreadyReleased: f.releasedQuantity }),
    item('packaging', 'Packing evidence verified', packing.filter((m) => m.status !== 'verified' && m.status !== 'waived').map((m) => `${m.title} is ${m.status.replace(/_/g, ' ')}.`), { packingMilestones: packing.length }),
    item('releaser', 'Releaser independent and authorized', releaser, { releaser: f.releaser.userId }),
  ];
  return { items, deviationsReliedOn: deviationsReliedOn.map((d) => d.id) };
}

/** JSON with keys in sorted order at every level, so the same snapshot always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const snapshotHash = (snapshot: unknown): string => createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
