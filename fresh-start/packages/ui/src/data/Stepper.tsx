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
  // VF-05 (reference screen 05): numbered discs on one rail, labels underneath. The rail
  // segment after a step fills as the reader moves past it.
  return (
    <nav aria-label={ariaLabel} className="jw-stepper">
      <ol>
        {steps.map((step, index) => {
          const isCurrent = index === current;
          const mark = STATE_MARK[step.state];
          const classes = [
            'jw-step',
            isCurrent ? 'jw-step-current' : '',
            index < current ? 'jw-step-passed' : '',
            `jw-step-${step.state}`,
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <li key={step.label} className={classes}>
              <button
                type="button"
                onClick={onSelect ? () => onSelect(index) : undefined}
                disabled={!onSelect}
                {...(isCurrent ? { 'aria-current': 'step' as const } : {})}
                aria-label={`Step ${index + 1} of ${steps.length}: ${step.label}. ${
                  STATE_PREFIX[step.state]
                }.${isCurrent ? ' You are here.' : ''}`}
              >
                <span className="jw-step-disc" aria-hidden>
                  {mark || index + 1}
                </span>
                <span className="jw-step-label">{step.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
