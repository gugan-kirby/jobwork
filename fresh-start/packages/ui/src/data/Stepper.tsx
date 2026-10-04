'use client';

/**
 * The wizard stepper (doc 21 §7, doc 14 §4 seven-step enquiry intake).
 *
 * A step carries **two independent facts**: where the reader is (`current`), and what
 * the step's own contents are worth (`state`). They are separate because they collide —
 * a failed submit lands the reader on a step that is both current *and* in error, and an
 * earlier draft that folded the two into one value silently dropped the "you are here"
 * marker exactly when the reader most needed it.
 *
 * Colour is never the only carrier (`DS-07`): each state has a glyph, and the accessible
 * name spells out both position and state.
 */

export type StepState = 'complete' | 'incomplete' | 'error';

export interface Step {
  label: string;
  state: StepState;
}

const STATE_TONE: Record<StepState, { fg: string; bg: string; border: string }> = {
  complete: {
    fg: 'var(--status-positive-fg)',
    bg: 'var(--status-positive-bg)',
    border: 'var(--status-positive-border)',
  },
  incomplete: {
    fg: 'var(--color-text-muted)',
    bg: 'var(--color-surface)',
    border: 'var(--color-border)',
  },
  error: {
    fg: 'var(--status-blocked-fg)',
    bg: 'var(--status-blocked-bg)',
    border: 'var(--status-blocked-border)',
  },
};

const STATE_PREFIX: Record<StepState, string> = {
  complete: 'Completed',
  incomplete: 'Not started',
  error: 'Needs attention',
};

const STATE_MARK: Record<StepState, string> = {
  complete: '✓',
  incomplete: '',
  error: '!',
};

export interface StepperProps {
  steps: readonly Step[];
  /** Index of the step the reader is on. Independent of each step's own state. */
  current: number;
  onSelect?: ((index: number) => void) | undefined;
  ariaLabel?: string | undefined;
}

export function Stepper({
  steps,
  current,
  onSelect,
  ariaLabel = 'Progress',
}: StepperProps): React.JSX.Element {
  return (
    <nav aria-label={ariaLabel}>
      <ol
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--space-2)',
          listStyle: 'none',
          margin: 0,
          padding: 0,
        }}
      >
        {steps.map((step, index) => {
          const isCurrent = index === current;
          // An untroubled current step wears the action colour; a current step that is
          // in error keeps the error colour and gains a ring, so both facts survive.
          const tone =
            isCurrent && step.state === 'incomplete'
              ? {
                  fg: 'var(--button-primary-fg)',
                  bg: 'var(--color-action)',
                  border: 'var(--color-action)',
                }
              : STATE_TONE[step.state];
          const mark = STATE_MARK[step.state];

          return (
            <li key={step.label}>
              <button
                type="button"
                onClick={onSelect ? () => onSelect(index) : undefined}
                disabled={!onSelect}
                {...(isCurrent ? { 'aria-current': 'step' as const } : {})}
                aria-label={`Step ${index + 1} of ${steps.length}: ${step.label}. ${
                  STATE_PREFIX[step.state]
                }.${isCurrent ? ' You are here.' : ''}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  minHeight: 32,
                  padding: '0 var(--space-3)',
                  borderRadius: 'var(--radius-sm)',
                  border: `var(--hairline) solid ${tone.border}`,
                  background: tone.bg,
                  color: tone.fg,
                  font: isCurrent ? 'var(--text-body-strong)' : 'var(--text-caption)',
                  cursor: onSelect ? 'pointer' : 'default',
                  // The ring is what says "you are here" when the tone is already
                  // spoken for by an error.
                  boxShadow: isCurrent ? `0 0 0 2px var(--color-action)` : undefined,
                }}
              >
                <span aria-hidden>{mark || index + 1}</span>
                <span>{step.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
