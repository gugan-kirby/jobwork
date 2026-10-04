'use client';

import { useCallback, useRef, useState } from 'react';
import { Button, type ButtonProps } from './Button';
import { announceCommandSucceeded } from './command-events';

/**
 * The doc 21 §6 idempotent action button, used for every money, approval, release and
 * state-changing command.
 *
 * Three properties it exists to guarantee:
 *
 *  1. **Single flight.** A second click while the first is in the air is dropped. The
 *     API is idempotent anyway, but a UI that fires twice makes the idempotency key the
 *     only thing between a customer and a double approval — so the button holds the line
 *     too.
 *  2. **No optimistic result** (`DS-13`). Nothing renders as done until the server says
 *     so; a failure leaves the previous state visible, not a half-applied one.
 *  3. **Failures name themselves.** The stable problem `code` is shown, because that is
 *     the string support will ask for (doc 08 §3).
 */

export interface CommandProblem {
  code: string;
  title: string;
  detail?: string | undefined;
  correlationId?: string | undefined;
}

export interface CommandButtonProps extends Omit<ButtonProps, 'onClick' | 'busy'> {
  /** Resolves when the server has confirmed. Rejecting shows the failure inline. */
  onCommand: () => Promise<void>;
  /** Shown briefly after success — the receipt half of the contract. */
  receiptLabel?: string | undefined;
  onProblem?: ((problem: CommandProblem) => void) | undefined;
}

function toProblem(error: unknown): CommandProblem {
  const candidate = (error as { problem?: CommandProblem } | undefined)?.problem;
  if (candidate?.code) return candidate;
  return {
    code: 'UNEXPECTED',
    title: error instanceof Error ? error.message : 'That command did not complete',
  };
}

export function CommandButton({
  onCommand,
  receiptLabel = 'Done',
  onProblem,
  children,
  ...rest
}: CommandButtonProps): React.JSX.Element {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [problem, setProblem] = useState<CommandProblem | null>(null);
  // A ref, not the state: two clicks in the same tick would both read `idle`.
  const inFlight = useRef(false);

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase('running');
    setProblem(null);
    try {
      await onCommand();
      announceCommandSucceeded();
      setPhase('done');
      window.setTimeout(() => setPhase('idle'), 2500);
    } catch (error) {
      const next = toProblem(error);
      setProblem(next);
      setPhase('idle');
      onProblem?.(next);
    } finally {
      inFlight.current = false;
    }
  }, [onCommand, onProblem]);

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      <Button {...rest} busy={phase === 'running'} onClick={() => void run()}>
        {phase === 'done' ? receiptLabel : children}
      </Button>
      <span role="status" aria-live="polite" className="jw-visually-hidden">
        {phase === 'running' ? 'Working' : phase === 'done' ? receiptLabel : ''}
      </span>
      {problem ? (
        <span
          role="alert"
          style={{
            font: 'var(--text-caption)',
            color: 'var(--status-blocked-fg)',
            maxWidth: 420,
          }}
        >
          {problem.detail ?? problem.title}{' '}
          <span className="mono" style={{ color: 'var(--color-text-muted)' }}>
            {problem.code}
            {problem.correlationId ? ` · ${problem.correlationId.slice(0, 8)}` : ''}
          </span>
        </span>
      ) : null}
    </span>
  );
}
