'use client';

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

/**
 * The one button in the system (doc 21 §11: a proposed new colour or size must become
 * a token or be rejected — so variants are a closed set, not a `style` prop).
 *
 * Every variant meets the doc 21 §9 bars: a ≥24×24 px target, a visible focus ring from
 * the base layer, and a disabled state that is still readable at 4.5:1. Labels are the
 * caller's job and doc 21 §10 asks them to name the business command, not "Submit".
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  /** Shows in-flight state and blocks interaction without collapsing the layout. */
  busy?: boolean | undefined;
  /** Why the control is unavailable — rendered as the title so it is never a mystery. */
  disabledReason?: string | undefined;
  iconStart?: ReactNode | undefined;
  fullWidth?: boolean | undefined;
}

const VARIANT_STYLE: Record<ButtonVariant, CSSProperties> = {
  primary: {
    background: 'var(--button-primary-bg)',
    color: 'var(--button-primary-fg)',
    border: '1px solid transparent',
  },
  secondary: {
    background: 'var(--button-secondary-bg)',
    color: 'var(--button-secondary-fg)',
    border: '1px solid var(--color-border)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--color-action)',
    border: '1px solid transparent',
  },
  danger: {
    background: 'var(--button-danger-bg)',
    color: 'var(--button-danger-fg)',
    border: '1px solid transparent',
  },
};

/**
 * The button's look as a style object, shared with `ButtonLink` so a navigation that
 * looks like a button is styled by the same closed set of variants (F-FE.4).
 */
export function buttonStyle({
  variant = 'primary',
  size = 'md',
  fullWidth,
  disabled = false,
}: {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  fullWidth?: boolean | undefined;
  disabled?: boolean | undefined;
}): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-2)',
    minHeight: size === 'sm' ? 'calc(var(--control-height) - 8px)' : 'var(--control-height)',
    minWidth: 24,
    padding: size === 'sm' ? '0 var(--space-3)' : '0 var(--space-4)',
    borderRadius: 'var(--button-radius)',
    font: 'var(--text-body-strong)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    transition: 'background var(--motion-fast) var(--motion-ease)',
    width: fullWidth ? '100%' : undefined,
    ...VARIANT_STYLE[variant],
  };
}

export function Button({
  variant = 'primary',
  size = 'md',
  busy = false,
  disabled,
  disabledReason,
  iconStart,
  fullWidth,
  children,
  style,
  ...rest
}: ButtonProps): React.JSX.Element {
  const isDisabled = Boolean(disabled) || busy;
  return (
    <button
      type="button"
      {...rest}
      disabled={isDisabled}
      aria-busy={busy || undefined}
      {...(isDisabled && disabledReason ? { title: disabledReason } : {})}
      style={{ ...buttonStyle({ variant, size, fullWidth, disabled: isDisabled }), ...style }}
    >
      {busy ? <Spinner /> : iconStart}
      {children}
    </button>
  );
}

/**
 * Deliberately a text-free mark: doc 21 §9 requires long-running states to be polled
 * into text, so the *label* carries the meaning and this only carries the motion.
 */
function Spinner(): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        border: '2px solid currentColor',
        borderTopColor: 'transparent',
        animation: 'jw-spin 700ms linear infinite',
      }}
    />
  );
}
