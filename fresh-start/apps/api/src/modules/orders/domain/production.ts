import { createHash } from 'node:crypto';
import type { GateKey, MilestoneInput, ReleaseGate } from '@jobwork/contracts';
import { canonicalJson } from '../../../platform/commands/canonical';

/**
 * The IN-09 rules that need no database: the baseline hash (doc 07 §13), governing
 * conflicts (`BR-ENG-06`), the production release gate matrix (doc 06 §7, `FR-504`)
 * and the default milestone plan.
 */

// ------------------------------------------------------------------ baseline

export interface ManifestItem {
  documentId: string;
  documentVersionId: string;
  fileSha256: string;
  purpose: 'governing' | 'reference' | 'inspection';
  governingPriority: number;
  logicalType?: string;
  title?: string;
}

/** Stable order: governing first by priority, then by document and version id. */
export function orderManifest<T extends ManifestItem>(items: readonly T[]): T[] {
  const rank = { governing: 0, inspection: 1, reference: 2 } as const;
  return [...items].sort(
    (a, b) =>
      rank[a.purpose] - rank[b.purpose] ||
      a.governingPriority - b.governingPriority ||
      a.documentId.localeCompare(b.documentId) ||
      a.documentVersionId.localeCompare(b.documentVersionId),
  );
}

/** doc 07 §13: the hash proves the manifest — exact versions and bytes — not CAD semantics. */
export function baselineHash(items: readonly ManifestItem[]): string {
  const canonical = orderManifest(items).map((i) => ({
    document_id: i.documentId,
    version_id: i.documentVersionId,
    file_sha256: i.fileSha256,
    purpose: i.purpose,
    governing_priority: i.governingPriority,
  }));
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

/**
 * `BR-ENG-06` v1: two governing documents of the same kind at the same priority leave a
 * supplier to guess which one wins. That blocks release until someone decides.
 */
export function governingConflicts(items: readonly ManifestItem[]): string[] {
  const seen = new Map<string, ManifestItem[]>();
  for (const item of items) {
    if (item.purpose !== 'governing') continue;
    const key = `${item.logicalType ?? 'document'}#${item.governingPriority}`;
    seen.set(key, [...(seen.get(key) ?? []), item]);
  }
  const conflicts: string[] = [];
  for (const [key, group] of seen) {
    const documents = new Set(group.map((g) => g.documentId));
    if (documents.size > 1) {
      const [type, priority] = key.split('#');
      conflicts.push(
        `${group.map((g) => g.title ?? g.documentId.slice(0, 8)).join(' and ')} are both governing ${String(type).replace(/_/g, ' ')} at priority ${priority}. Make one a reference or give it a different priority.`,
      );
    }
    const versions = group.filter((g, i) => group.findIndex((o) => o.documentId === g.documentId) !== i);
    if (versions.length > 0) conflicts.push(`Two versions of ${versions[0]!.title ?? 'one document'} are both governing. Keep only the one to manufacture to.`);
  }
  if (items.length > 0 && !items.some((i) => i.purpose === 'governing')) {
    conflicts.push('No governing document. Mark the drawing or model the part is made to as governing.');
  }
  return conflicts;
}

// ------------------------------------------------------------------ release gates

export interface GateInput {
  order: { status: string; commercialReleasedAt: string | null };
  activeHolds: Array<{ reason: string }>;
  baseline: { baselineId: string; number: string; manifestHash: string } | null;
  transmittal: { transmittalId: string; number: string; status: string; manifestHash: string; acknowledgedAt: string | null } | null;
  purchaseOrder: { number: string; status: string; contentHash: string };
  plan: { plannedStart: string | null; plannedFinish: string | null; milestoneCount: number };
  supplier: { profileStatus: string | null; acceptingWork: boolean | null };
  qualityPlanPresent: boolean;
  /** An unexpired, unlifted interim stop on this purchase order (IN-13). */
  interimStop?: { changeNumber: string; reason: string; expiresAt: string } | null;
}

const GATE_LABEL: Record<GateKey, string> = {
  commercial: 'Commercial',
  technical: 'Technical',
  planning: 'Planning',
  compliance: 'Compliance',
};

/**
 * The four gates of `FR-504`, each with its reasons and the evidence it relied on. A gate
 * that cannot be computed from records is red, never assumed green (doc 10 §4).
 */
export function computeReleaseGates(input: GateInput): ReleaseGate[] {
  const commercial: string[] = [];
  if (!input.order.commercialReleasedAt || input.order.status === 'pending_commercial_release') {
    commercial.push('The order is not commercially released: the advance has not arrived and no approved credit covers it.');
  }
  if (input.order.status === 'cancelled') commercial.push('The order is cancelled.');
  for (const hold of input.activeHolds) commercial.push(`Credit hold: ${hold.reason}.`);

  const technical: string[] = [];
  if (!input.baseline) technical.push('No released production baseline for this order.');
  if (input.purchaseOrder.status !== 'acknowledged') technical.push(`Purchase order ${input.purchaseOrder.number} is not acknowledged by the supplier.`);
  if (!input.transmittal) {
    technical.push('The baseline has not been transmitted to this supplier.');
  } else {
    if (input.baseline && input.transmittal.manifestHash !== input.baseline.manifestHash) {
      technical.push(`Transmittal ${input.transmittal.number} delivered an older baseline; transmit the current one.`);
    }
    if (input.transmittal.status !== 'acknowledged') {
      technical.push(`The supplier has not acknowledged transmittal ${input.transmittal.number} (BR-ENG-07) — downloading the files is not acknowledgment.`);
    }
  }

  if (input.interimStop) {
    technical.push(`Interim stop under change ${input.interimStop.changeNumber} until ${input.interimStop.expiresAt.slice(0, 16).replace('T', ' ')} UTC: ${input.interimStop.reason}`);
  }

  const planning: string[] = [];
  if (!input.plan.plannedStart || !input.plan.plannedFinish) planning.push('Planned start and finish dates are missing.');
  if (input.plan.milestoneCount === 0) planning.push('No milestones are planned.');

  const compliance: string[] = [];
  if (input.supplier.profileStatus !== 'active') compliance.push(`The supplier is not active in the network (${input.supplier.profileStatus ?? 'no profile'}).`);
  if (input.supplier.acceptingWork === false) compliance.push('The supplier has paused new work.');
  if (!input.qualityPlanPresent) compliance.push('No approved quality plan for the current baseline. JobWork quality approves one under Quality.');

  const gate = (key: GateKey, reasons: string[], evidence: Record<string, string | null>): ReleaseGate => ({ key, label: GATE_LABEL[key], pass: reasons.length === 0, reasons, evidence });
  return [
    gate('commercial', commercial, { commercialReleasedAt: input.order.commercialReleasedAt, orderStatus: input.order.status }),
    gate('technical', technical, {
      baselineNumber: input.baseline?.number ?? null,
      manifestHash: input.baseline?.manifestHash ?? null,
      transmittalNumber: input.transmittal?.number ?? null,
      acknowledgedAt: input.transmittal?.acknowledgedAt ?? null,
      purchaseOrderHash: input.purchaseOrder.contentHash,
    }),
    gate('planning', planning, { plannedStart: input.plan.plannedStart, plannedFinish: input.plan.plannedFinish, milestones: String(input.plan.milestoneCount) }),
    gate('compliance', compliance, { supplierStatus: input.supplier.profileStatus, qualityPlan: input.qualityPlanPresent ? 'approved' : null }),
  ];
}

// ------------------------------------------------------------------ milestones

/**
 * The default checkpoint plan when planning does not supply one: evenly spread between
 * start and finish, with the customer seeing four of the five in curated words.
 */
export function defaultMilestones(plannedStart: string, plannedFinish: string): MilestoneInput[] {
  const start = new Date(`${plannedStart}T00:00:00Z`).getTime();
  const finish = new Date(`${plannedFinish}T00:00:00Z`).getTime();
  const span = Math.max(finish - start, 0);
  const at = (fraction: number): string => new Date(start + Math.round((span * fraction) / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
  return [
    { title: 'Material received and checked', customerLabel: 'Material received', plannedDate: at(0.15), evidencePolicy: 'photo', minEvidence: 1 },
    { title: 'First article inspected', customerLabel: 'First part approved', plannedDate: at(0.35), evidencePolicy: 'document', minEvidence: 1 },
    { title: 'Production complete', customerLabel: 'Production complete', plannedDate: at(0.75), evidencePolicy: 'photo', minEvidence: 1 },
    { title: 'Final inspection at supplier', plannedDate: at(0.9), evidencePolicy: 'document', minEvidence: 1 },
    { title: 'Packed and ready to dispatch', customerLabel: 'Packed for dispatch', plannedDate: at(1), evidencePolicy: 'photo', minEvidence: 1 },
  ];
}

/** Today in India (doc 10 §9), as the date a verifier means by "today". */
export function todayInIndia(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}
