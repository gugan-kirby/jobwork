import { useId, type InputHTMLAttributes } from 'react';
import { Icon, type IconName } from '../primitives/Icon';

/**
 * The reference screens' field (VF-03): a leading glyph, the label shown as the
 * placeholder, a 52 px rounded box. The label is still a real `<label>` (visually
 * hidden), so the control keeps its accessible name after the user types, and hint and
 * error stay on the `aria-describedby` chain exactly as `Field` does it (doc 21 §9).
 */
export interface IconTextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'placeholder' | 'id' | 'className' | 'style'> {
  label: string;
  icon: IconName;
  hint?: string | undefined;
  error?: string | undefined;
}

export function IconTextInput({ label, icon, hint, error, required, ...rest }: IconTextInputProps): React.JSX.Element {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="jw-icon-field">
      <label htmlFor={id} className="jw-visually-hidden">
        {label}
        {required ? ' (required)' : ''}
      </label>
      <div className={error ? 'jw-icon-field-box jw-icon-field-invalid' : 'jw-icon-field-box'}>
        <Icon name={icon} size={1.45} />
        <input
          {...rest}
          id={id}
          required={required}
          placeholder={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
      </div>
      {hint && !error ? (
        <p id={hintId} className="jw-icon-field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="jw-icon-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
