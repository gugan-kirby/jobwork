'use client';

import { useId, type ReactNode } from 'react';
import { Icon, type IconName } from '../primitives/Icon';

/**
 * A radio group drawn as cards (F-MX.6): the job-type question and any other choice
 * where each option deserves a sentence of explanation, not just a word.
 *
 * Real `<input type="radio">` elements do the work — keyboard, grouping, form
 * semantics come for free and cannot drift — and the card is their label. The input is
 * visually hidden, not `display: none`, so it stays focusable and the focus ring lands
 * on the card via `:focus-visible` on the label.
 */

export interface ChoiceCardOption<T extends string> {
  value: T;
  label: string;
  description?: ReactNode | undefined;
  icon?: IconName | undefined;
  disabled?: boolean | undefined;
  /** Why it cannot be chosen; rendered where the description would be. */
  disabledReason?: string | undefined;
}

export interface ChoiceCardsProps<T extends string> {
  legend: string;
  hint?: string | undefined;
  name: string;
  value: T | null;
  options: readonly ChoiceCardOption<T>[];
  onChange: (value: T) => void;
  error?: string | undefined;
  /** Cards per row above `sm`; always one column on the narrowest phones. */
  columns?: 1 | 2 | 3 | undefined;
}

export function ChoiceCards<T extends string>({
  legend,
  hint,
  name,
  value,
  options,
  onChange,
  error,
  columns = 1,
}: ChoiceCardsProps<T>): React.JSX.Element {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <fieldset
      className="jw-choice"
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
      {...(error ? { 'aria-invalid': true } : {})}
    >
      <legend className="jw-choice-legend">{legend}</legend>
      {hint ? (
        <p id={`${id}-hint`} className="jw-choice-hint">
          {hint}
        </p>
      ) : null}
      <div className={`jw-choice-grid jw-choice-grid-${columns}`}>
        {options.map((option) => {
          const inputId = `${id}-${option.value}`;
          const checked = option.value === value;
          return (
            <div key={option.value} className="jw-choice-item">
              <input
                id={inputId}
                className="jw-choice-input"
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                disabled={option.disabled}
                onChange={() => onChange(option.value)}
              />
              <label
                htmlFor={inputId}
                className={checked ? 'jw-choice-card jw-choice-card-on' : 'jw-choice-card'}
              >
                {option.icon ? (
                  <span className="jw-choice-icon">
                    <Icon name={option.icon} size={1.4} />
                  </span>
                ) : null}
                <span className="jw-choice-text">
                  <span className="jw-choice-label">{option.label}</span>
                  {option.disabled && option.disabledReason ? (
                    <span className="jw-choice-desc">{option.disabledReason}</span>
                  ) : option.description ? (
                    <span className="jw-choice-desc">{option.description}</span>
                  ) : null}
                </span>
                <span className="jw-choice-mark" aria-hidden="true">
                  {checked ? <Icon name="check" size={1} /> : null}
                </span>
              </label>
            </div>
          );
        })}
      </div>
      {error ? (
        <p id={`${id}-error`} className="jw-choice-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
