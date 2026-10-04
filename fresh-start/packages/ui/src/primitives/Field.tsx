'use client';

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

/**
 * The labelled-control wrapper every form input in both apps goes through.
 *
 * It exists because the doc 21 §9 requirement — "all form controls labeled and
 * described; error summary receives focus" — is not something each screen can be
 * trusted to re-do. `Field` owns the id, the `aria-describedby` chain to the hint and
 * the error, and `aria-invalid`; a caller cannot render a control that is unlabelled
 * or an error that is announced to nobody.
 *
 * Error text states the fix, not the failure (doc 21 §7) — that wording is the caller's,
 * but the placement and announcement are not negotiable.
 */

export interface FieldProps {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  children: (control: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean | undefined;
  }) => ReactNode;
}

export function Field({ label, hint, error, required, children }: FieldProps): React.JSX.Element {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
      <label htmlFor={id} style={{ display: 'block', font: 'var(--text-body-strong)' }}>
        {label}
        {required ? (
          <span aria-hidden style={{ color: 'var(--status-blocked-fg)' }}> *</span>
        ) : null}
        {required ? <span className="jw-visually-hidden"> (required)</span> : null}
      </label>
      {hint ? (
        <p id={hintId} style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)', marginTop: 'var(--space-1)' }}>
          {hint}
        </p>
      ) : null}
      <div style={{ marginTop: 'var(--space-1)' }}>
        {children({
          id,
          'aria-describedby': describedBy,
          'aria-invalid': error ? true : undefined,
        })}
      </div>
      {error ? (
        <p
          id={errorId}
          style={{ font: 'var(--text-caption)', color: 'var(--status-blocked-fg)', marginTop: 'var(--space-1)' }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

const controlStyle = (invalid: boolean): React.CSSProperties => ({
  display: 'block',
  width: '100%',
  minHeight: 'var(--control-height)',
  padding: '0 var(--space-3)',
  background: 'var(--field-bg)',
  color: 'var(--color-text)',
  border: `1px solid ${invalid ? 'var(--field-border-invalid)' : 'var(--field-border)'}`,
  borderRadius: 'var(--field-radius)',
  font: 'var(--text-body)',
});

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  /** Right-aligned tabular numerals for money, quantities and measurements (`DS-08`). */
  numeric?: boolean | undefined;
}

export function TextInput({
  label,
  hint,
  error,
  required,
  numeric,
  style,
  ...rest
}: TextInputProps): React.JSX.Element {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {(control) => (
        <input
          {...rest}
          {...control}
          required={required}
          className={numeric ? 'numeric' : undefined}
          style={{
            ...controlStyle(Boolean(error)),
            ...(numeric ? { textAlign: 'right' } : {}),
            ...style,
          }}
        />
      )}
    </Field>
  );
}

export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
}

export function TextArea({
  label,
  hint,
  error,
  required,
  style,
  ...rest
}: TextAreaProps): React.JSX.Element {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {(control) => (
        <textarea
          {...rest}
          {...control}
          required={required}
          style={{
            ...controlStyle(Boolean(error)),
            minHeight: 88,
            padding: 'var(--space-2) var(--space-3)',
            resize: 'vertical',
            ...style,
          }}
        />
      )}
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'children'> {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  options: readonly SelectOption[];
  placeholder?: string | undefined;
}

export function Select({
  label,
  hint,
  error,
  required,
  options,
  placeholder,
  style,
  ...rest
}: SelectProps): React.JSX.Element {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {(control) => (
        <select
          {...rest}
          {...control}
          required={required}
          style={{ ...controlStyle(Boolean(error)), ...style }}
        >
          {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> {
  label: string;
  hint?: string | undefined;
}

export function Checkbox({ label, hint, style, ...rest }: CheckboxProps): React.JSX.Element {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start' }}>
        <input
          {...rest}
          id={id}
          type="checkbox"
          {...(hintId ? { 'aria-describedby': hintId } : {})}
          style={{ width: 18, height: 18, marginTop: 3, accentColor: 'var(--color-action)', ...style }}
        />
        <label htmlFor={id} style={{ font: 'var(--text-body)' }}>
          {label}
        </label>
      </div>
      {hint ? (
        <p
          id={hintId}
          style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)', margin: 'var(--space-1) 0 0 26px' }}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
