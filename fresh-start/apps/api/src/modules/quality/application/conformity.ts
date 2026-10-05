import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { Rational } from '../domain/rational';
import { ConformityRepository } from '../infrastructure/conformity.repository';

/** A lot as the caller names it to the customer, and the lot code quality knows it by. */
export interface ConformityLot {
  workPackageId: string;
  lotCode: string;
  marking: string;
}

export interface ConformitySummary {
  /** Quality releases covering the lots, with JobWork's markings in place of lot codes. */
  releases: Array<{ number: string; releasedAt: string; quantity: string; markings: string[] }>;
  inspections: Array<{ number: string; stage: string; marking: string; samples: number; decidedAt: string | null }>;
  characteristics: Array<{
    reference: string;
    name: string;
    criticality: 'critical' | 'major' | 'minor';
    requirement: string;
    samples: number;
    measured: string;
    result: 'pass' | 'fail';
  }>;
  /** Deviations that accepted part of these lots as they are. */
  deviations: Array<{ number: string; markings: string[] }>;
}

const num = (s: string | null): string | null => (s === null ? null : Rational.parse(s).toDisplay(6));

/**
 * The curated, released quality record for a delivery (IN-17 F-17.4; doc 03 §3 "quality record:
 * curated/released"; the pre-ship inspection pattern of the README's references). It speaks in the
 * caller's lot markings and the drawing's own limits: who measured, with what, and the lot codes
 * a workshop gave never appear.
 */
@Injectable()
export class ConformityView {
  constructor(private readonly repo: ConformityRepository) {}

  async forLots(lots: readonly ConformityLot[], tx?: PoolClient): Promise<ConformitySummary> {
    const out: ConformitySummary = { releases: [], inspections: [], characteristics: [], deviations: [] };
    const byPackage = new Map<string, ConformityLot[]>();
    for (const l of lots) byPackage.set(l.workPackageId, [...(byPackage.get(l.workPackageId) ?? []), l]);
    for (const [workPackageId, group] of byPackage) {
      const codes = [...new Set(group.map((l) => l.lotCode))];
      const marking = (code: string): string => group.find((l) => l.lotCode === code)?.marking ?? '';
      const markings = (covered: readonly string[]): string[] => (covered.length === 0 ? group.map((l) => l.marking) : covered.filter((c) => codes.includes(c)).map(marking));
      for (const r of await this.repo.releases(workPackageId, codes, tx)) out.releases.push({ number: r.number, releasedAt: r.releasedAt.toISOString(), quantity: num(r.quantity)!, markings: [...new Set(markings(r.lots))] });
      for (const i of await this.repo.inspections(workPackageId, codes, tx)) out.inspections.push({ number: i.number, stage: i.stage, marking: marking(i.lot), samples: i.sampleSize, decidedAt: i.decidedAt ? i.decidedAt.toISOString() : null });
      for (const c of await this.repo.characteristics(workPackageId, codes, tx)) {
        const unit = c.unit ?? '';
        const limits = [c.lower !== null ? `${c.lowerInclusive ? '≥' : '>'} ${num(c.lower)}` : '', c.upper !== null ? `${c.upperInclusive ? '≤' : '<'} ${num(c.upper)}` : ''].filter(Boolean).join(', ');
        const requirement = c.kind === 'attribute' ? c.acceptedValues.join(' / ') || 'conforming' : `${c.nominal !== null ? `${num(c.nominal)} ${unit}, ` : ''}${limits} ${unit}`.trim();
        const measured = c.kind === 'attribute' || c.min === null ? (c.allPass ? 'all conforming' : 'not all conforming') : c.min === c.max ? `${num(c.min)} ${unit}` : `${num(c.min)} – ${num(c.max)} ${unit}`;
        out.characteristics.push({ reference: c.reference, name: c.name, criticality: c.criticality, requirement, samples: c.samples, measured, result: c.allPass ? 'pass' : 'fail' });
      }
      for (const d of await this.repo.deviations(workPackageId, codes, tx)) out.deviations.push({ number: d.number, markings: [...new Set(markings(d.lots))] });
    }
    return out;
  }
}
