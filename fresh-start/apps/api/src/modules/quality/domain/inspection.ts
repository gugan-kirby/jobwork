import { DomainError } from '../../../platform/http/domain-error';

/**
 * Inspection rules (IN-14 F-14.3; doc 06 §10; doc 09 §§9–10; BR-QLT-01, BR-QLT-03, BR-QLT-05).
 * Results are never rewritten, so "the" result for a sample and characteristic is the one no
 * later row supersedes. An inspection can pass only when nothing below stands in the way.
 */

export const STAGE_LABEL: Record<string, string> = {
  incoming: 'incoming material',
  in_process: 'in-process',
  fai: 'first article',
  final: 'final',
  jobwork_incoming: 'JobWork incoming',
  customer_receiving: 'customer receiving',
};

export class QualityRefused extends DomainError {
  constructor(code: string, title: string, detail?: string, status = 409) {
    super(code, status, title, detail);
  }
}

export class InspectionNotFound extends DomainError {
  constructor() {
    super('INSPECTION_NOT_FOUND', 404, 'Inspection not found');
  }
}

export interface RollupCharacteristic {
  id: string;
  seq: number;
  name: string;
  mandatory: boolean;
}

export interface RollupResult {
  id: string;
  sampleNo: number;
  characteristicId: string;
  outcome: 'pass' | 'fail' | 'cannot_evaluate';
  outcomeReason: string;
  calibrationStatus: 'valid' | 'expired' | 'uncalibrated' | 'not_required';
  instrumentAssetTag: string | null;
  supersededByResultId: string | null;
  disposition: { decision: 'accept' | 'reinspect' } | null;
}

export function currentResults<T extends { supersededByResultId: string | null }>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.supersededByResultId === null);
}

/** Why `passed` is not available: empty when it is. */
export function passBlockers(characteristics: readonly RollupCharacteristic[], sampleNos: readonly number[], rows: readonly RollupResult[]): string[] {
  const current = currentResults(rows);
  const name = (id: string): string => {
    const c = characteristics.find((x) => x.id === id);
    return c ? `${c.seq}. ${c.name}` : 'A characteristic';
  };
  const out: string[] = [];
  for (const c of characteristics) {
    for (const n of sampleNos) {
      if (!current.some((r) => r.characteristicId === c.id && r.sampleNo === n)) out.push(`${c.seq}. ${c.name} has no result for sample ${n}.`);
    }
  }
  for (const r of current) {
    const c = characteristics.find((x) => x.id === r.characteristicId);
    if (r.outcome === 'fail' && c?.mandatory) out.push(`${name(r.characteristicId)} failed on sample ${r.sampleNo}, and it is mandatory.`);
    if (r.outcome === 'cannot_evaluate') out.push(`${name(r.characteristicId)} on sample ${r.sampleNo} cannot be evaluated: ${r.outcomeReason}`);
    if (r.calibrationStatus === 'expired' || r.calibrationStatus === 'uncalibrated') {
      const what = `${name(r.characteristicId)} on sample ${r.sampleNo} was measured with ${r.instrumentAssetTag ?? 'an instrument'} ${r.calibrationStatus === 'expired' ? 'past its calibration due date' : 'without a valid calibration'}`;
      if (!r.disposition) out.push(`${what}: it needs a calibration disposition.`);
      else if (r.disposition.decision === 'reinspect') out.push(`${what}, and was sent for reinspection.`);
    }
  }
  return out;
}

/** Failed characteristics that do not block a pass on their own, but need the reviewer's reason. */
export function nonMandatoryFailures(characteristics: readonly RollupCharacteristic[], rows: readonly RollupResult[]): RollupResult[] {
  return currentResults(rows).filter((r) => r.outcome === 'fail' && characteristics.find((c) => c.id === r.characteristicId)?.mandatory === false);
}
