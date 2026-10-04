import { Icon } from '../primitives/Icon';

/**
 * The release gate matrix (doc 21 component inventory, F-09.3). One row per gate: whether
 * it passes, and — when it does not — every reason, so the reader knows what to fix
 * without opening five screens. Colour is never the only carrier (`DS-07`): each row has
 * a glyph and its accessible name says "passes" or "blocked".
 */

export interface GateMatrixGate {
  key: string;
  label: string;
  pass: boolean;
  reasons: readonly string[];
}

export interface GateMatrixProps {
  gates: readonly GateMatrixGate[];
  /** Spoken name of the list, e.g. "Release gates for WP-2026-0001". */
  label: string;
}

export function GateMatrix({ gates, label }: GateMatrixProps): React.JSX.Element {
  const blocked = gates.filter((g) => !g.pass).length;
  return (
    <div>
      <p style={{ font: 'var(--text-body-strong)', marginBottom: 'var(--space-2)', color: blocked === 0 ? 'var(--status-positive-fg)' : 'var(--status-blocked-fg)' }}>
        {blocked === 0 ? 'All gates pass — ready to release' : `${blocked} of ${gates.length} gates blocked`}
      </p>
      <ul aria-label={label} style={{ listStyle: 'none', display: 'grid', gap: 'var(--space-2)' }}>
        {gates.map((gate) => {
          const tone = gate.pass ? 'positive' : 'blocked';
          return (
            <li
              key={gate.key}
              aria-label={`${gate.label}: ${gate.pass ? 'passes' : 'blocked'}`}
              style={{
                display: 'flex',
                gap: 'var(--space-3)',
                alignItems: 'flex-start',
                padding: 'var(--space-2) var(--space-3)',
                border: `var(--hairline) solid var(--status-${tone}-border)`,
                background: `var(--status-${tone}-bg)`,
                borderRadius: 'var(--radius-md)',
              }}
            >
              <span aria-hidden="true" style={{ color: `var(--status-${tone}-fg)`, flex: 'none', marginTop: 'var(--space-1)' }}>
                <Icon name={gate.pass ? 'check' : 'close'} size={0.9} />
              </span>
              <span style={{ flex: 1 }}>
                <span style={{ display: 'block', font: 'var(--text-body-strong)', color: `var(--status-${tone}-fg)` }}>{gate.label}</span>
                {gate.reasons.length > 0 ? (
                  <ul style={{ paddingLeft: 'var(--space-4)', font: 'var(--text-caption)', color: 'var(--color-text)' }}>
                    {gate.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
