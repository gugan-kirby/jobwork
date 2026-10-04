'use client';

import { TextArea } from './Field';

/**
 * The doc 21 §7 reason pattern. Rejection, override, decline, revoke and sensitive
 * grants all require a reason, and doc 03 §5 makes that a control, not a courtesy —
 * so it ships once here rather than being rebuilt per screen with a different minimum
 * length and a different tone each time.
 *
 * The hint says who will read it. A reason written for an auditor and a reason written
 * for the customer who was just declined are different sentences, and the person typing
 * needs to know which one they are writing.
 */

export interface ReasonFieldProps {
  label?: string | undefined;
  audience: 'customer' | 'supplier' | 'internal';
  value: string;
  onChange: (value: string) => void;
  minLength?: number | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
}

const AUDIENCE_HINT: Record<ReasonFieldProps['audience'], string> = {
  customer: 'The customer reads this. Say what happened and what they can do next.',
  supplier: 'The supplier reads this. Be specific enough for them to act on it.',
  internal: 'Internal record only. Written for whoever reviews this decision later.',
};

export function ReasonField({
  label = 'Reason',
  audience,
  value,
  onChange,
  minLength = 10,
  error,
  required = true,
}: ReasonFieldProps): React.JSX.Element {
  const tooShort = value.trim().length > 0 && value.trim().length < minLength;
  return (
    <TextArea
      label={label}
      hint={AUDIENCE_HINT[audience]}
      required={required}
      {...(error ?? (tooShort ? `Give at least ${minLength} characters so this is useful later.` : undefined)
        ? { error: error ?? `Give at least ${minLength} characters so this is useful later.` }
        : {})}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
