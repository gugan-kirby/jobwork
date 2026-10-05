import type { ReactNode } from 'react';
import { StatusChip } from '../status/StatusChip';

/**
 * The measurement grid (doc 21 §6; doc 09 §10; IN-14 F-14.4): one row per characteristic, one
 * column per sample. Each cell shows the value and unit as measured, the normalized value
 * beside it when the unit differs, and the outcome as a glyph and a word (`DS-07`).
 * "Cannot evaluate" is its own state, never shown as a fail, and a result taken past its
 * calibration says so. A fail accepted under a deviation keeps its fail and gains a special
 * mark, never pass-green (`DS-04`). Numbers are tabular (`DS-08`). A corrected cell shows the result that
 * stands, and names the correction; the superseded value stays in the record.
 */

export interface GridBound {
  value: string;
  inclusive: boolean;
}

export interface GridCharacteristic {
  id: string;
  seq: number;
  name: string;
  drawingReference: string;
  kind: 'variable' | 'attribute';
  criticality: 'critical' | 'major' | 'minor';
  mandatory: boolean;
  unit: string | null;
  lower: GridBound | null;
  upper: GridBound | null;
  acceptedValues: readonly string[];
}

export interface GridResult {
  resultId: string;
  characteristicId: string;
  sampleNo: number;
  original: { value: string; unit: string | null };
  normalized: { value: string; unit: string } | null;
  outcome: 'pass' | 'fail' | 'cannot_evaluate';
  outcomeReason: string;
  calibrationStatus: 'valid' | 'expired' | 'uncalibrated' | 'not_required';
  disposition: { decision: 'accept' | 'reinspect' } | null;
  supersededByResultId: string | null;
  supersedesResultId: string | null;
  correctionReason: string | null;
  /** A failed result accepted for use under a deviation: it stays a fail, marked special (`DS-04`). */
  coveredByDeviation?: { number: string; active: boolean } | null | undefined;
}

export interface MeasurementGridProps {
  caption: string;
  characteristics: readonly GridCharacteristic[];
  sampleNos: readonly number[];
  results: readonly GridResult[];
  /** An action for one standing result, e.g. "Correct" or "Disposition". */
  cellAction?: ((result: GridResult) => ReactNode) | undefined;
}

const OUTCOME = {
  pass: { tone: 'positive', label: 'pass' },
  fail: { tone: 'blocked', label: 'fail' },
  cannot_evaluate: { tone: 'attention', label: 'cannot evaluate' },
} as const;

/** "≥ 11.98 and ≤ 12.02 mm", "< 3.2 um", "one of: conforming". */
export function describeLimits(c: GridCharacteristic): string {
  if (c.kind === 'attribute') return `one of: ${c.acceptedValues.join(', ')}`;
  const parts: string[] = [];
  if (c.lower) parts.push(`${c.lower.inclusive ? '≥' : '>'} ${c.lower.value}`);
  if (c.upper) parts.push(`${c.upper.inclusive ? '≤' : '<'} ${c.upper.value}`);
  return `${parts.join(' and ')} ${c.unit ?? ''}`.trim();
}

export function MeasurementGrid({ caption, characteristics, sampleNos, results, cellAction }: MeasurementGridProps): React.JSX.Element {
  const standing = results.filter((r) => r.supersededByResultId === null);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', font: 'var(--text-body)' }}>
        <caption className="jw-visually-hidden">{caption}</caption>
        <thead>
          <tr style={{ textAlign: 'left', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
            <th scope="col" style={{ padding: 'var(--space-2)' }}>
              Characteristic
            </th>
            <th scope="col" style={{ padding: 'var(--space-2)' }}>
              Limits
            </th>
            {sampleNos.map((n) => (
              <th key={n} scope="col" className="numeric" style={{ padding: 'var(--space-2)' }}>
                Sample {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {characteristics.map((c) => (
            <tr key={c.id} style={{ borderTop: 'var(--hairline) solid var(--color-border)', verticalAlign: 'top' }}>
              <th scope="row" style={{ padding: 'var(--space-2)', textAlign: 'left', fontWeight: 'normal' }}>
                <strong>
                  {c.seq}. {c.name}
                </strong>
                <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                  {[c.drawingReference ? `balloon ${c.drawingReference}` : null, c.criticality, c.mandatory ? 'mandatory' : 'not mandatory'].filter(Boolean).join(' · ')}
                </span>
              </th>
              <td className="numeric" style={{ padding: 'var(--space-2)' }}>
                {describeLimits(c)}
              </td>
              {sampleNos.map((n) => {
                const r = standing.find((x) => x.characteristicId === c.id && x.sampleNo === n);
                if (!r) {
                  return (
                    <td key={n} style={{ padding: 'var(--space-2)', color: 'var(--color-text-muted)' }}>
                      not recorded
                    </td>
                  );
                }
                const o = OUTCOME[r.outcome];
                const showNormalized = r.normalized && r.normalized.unit !== r.original.unit;
                const flagged = r.calibrationStatus === 'expired' || r.calibrationStatus === 'uncalibrated';
                return (
                  <td key={n} style={{ padding: 'var(--space-2)' }}>
                    <span className="numeric" style={{ display: 'block' }}>
                      {r.original.value}
                      {r.original.unit ? ` ${r.original.unit}` : ''}
                    </span>
                    {showNormalized ? (
                      <span className="numeric" style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                        = {r.normalized!.value} {r.normalized!.unit}
                      </span>
                    ) : null}
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)', marginTop: 'var(--space-1)' }}>
                      <StatusChip tone={o.tone}>{o.label}</StatusChip>
                      {r.coveredByDeviation ? <StatusChip tone={r.coveredByDeviation.active ? 'special' : 'neutral'}>{r.coveredByDeviation.active ? `accepted under ${r.coveredByDeviation.number}` : `${r.coveredByDeviation.number} expired`}</StatusChip> : null}
                      {flagged ? (
                        <StatusChip tone={r.disposition?.decision === 'accept' ? 'neutral' : 'attention'}>
                          {r.calibrationStatus === 'expired' ? 'calibration expired' : 'not calibrated'}
                          {r.disposition ? ` — ${r.disposition.decision === 'accept' ? 'accepted' : 'reinspect'}` : ''}
                        </StatusChip>
                      ) : null}
                      {r.supersedesResultId ? <StatusChip tone="neutral">corrected</StatusChip> : null}
                    </span>
                    {r.outcome !== 'pass' ? <span style={{ display: 'block', font: 'var(--text-caption)' }}>{r.outcomeReason}</span> : null}
                    {r.correctionReason ? <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>Correction: {r.correctionReason}</span> : null}
                    {cellAction ? <span style={{ display: 'block', marginTop: 'var(--space-1)' }}>{cellAction(r)}</span> : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
