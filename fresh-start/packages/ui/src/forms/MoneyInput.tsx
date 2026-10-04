'use client';

import { useState } from 'react';
import { Field } from '../primitives/Field';

/**
 * Doc 21 §7 money input. Money crosses every boundary as **integer minor units plus a
 * currency** (`BR-FIN-01`), never as a float: ₹12,34,567.00 is
 * `{ amountMinor: 123456700, currency: 'INR' }`.
 *
 * Display uses en-IN lakh/crore grouping while the wire format stays minor units — the
 * two are separated so a formatting change can never move a decimal point in stored
 * money. The single rounding happens here, at the edge, where the person can still see
 * the field they typed into.
 */

const MINOR_UNITS: Record<string, number> = { INR: 2, USD: 2, EUR: 2 };

export interface MoneyValue {
  amountMinor: number;
  currency: string;
}

export interface MoneyInputProps {
  label: string;
  value: MoneyValue | null;
  currency?: string | undefined;
  onChange: (value: MoneyValue | null) => void;
  hint?: string | undefined;
  error?: string | undefined;
  disabled?: boolean | undefined;
}

export function minorUnitDigits(currency: string): number {
  return MINOR_UNITS[currency] ?? 2;
}

/**
 * Display money as doc 21 specifies: the currency's symbol with en-IN grouping for INR
 * (₹12,34,567.00), the locale default otherwise. An amount without its currency is
 * ambiguous on a screen that may show more than one, so the symbol is never optional.
 */
export function formatMoney(value: MoneyValue): string {
  const digits = minorUnitDigits(value.currency);
  return new Intl.NumberFormat(value.currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency: value.currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value.amountMinor / 10 ** digits);
}

function toEditableString(value: MoneyValue | null): string {
  if (!value) return '';
  const digits = minorUnitDigits(value.currency);
  return (value.amountMinor / 10 ** digits).toFixed(digits);
}

export function MoneyInput({
  label,
  value,
  currency = 'INR',
  onChange,
  hint,
  error,
  disabled,
}: MoneyInputProps): React.JSX.Element {
  // While focused the field holds the raw digits the person is typing; on blur it
  // settles back to the canonical string. Grouping separators are never inserted
  // mid-typing, which would fight the caret.
  const [text, setText] = useState(() => toEditableString(value));
  const digits = minorUnitDigits(currency);

  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => (
        <span style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <span
            aria-hidden
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0 var(--space-2)',
              border: '1px solid var(--field-border)',
              borderRadius: 'var(--field-radius)',
              background: 'var(--neutral-100)',
              font: 'var(--text-caption)',
              color: 'var(--color-text-muted-on-tint)',
            }}
          >
            {currency}
          </span>
          <input
            {...control}
            type="text"
            inputMode="decimal"
            disabled={disabled}
            className="numeric"
            value={text}
            onChange={(event) => {
              const raw = event.target.value;
              setText(raw);
              if (raw.trim() === '') {
                onChange(null);
                return;
              }
              const parsed = Number(raw.replace(/,/g, ''));
              if (!Number.isFinite(parsed)) return;
              onChange({ amountMinor: Math.round(parsed * 10 ** digits), currency });
            }}
            onBlur={() => setText(toEditableString(value))}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 'var(--control-height)',
              padding: '0 var(--space-3)',
              textAlign: 'right',
              background: 'var(--field-bg)',
              color: 'var(--color-text)',
              border: `1px solid ${error ? 'var(--field-border-invalid)' : 'var(--field-border)'}`,
              borderRadius: 'var(--field-radius)',
              font: 'var(--text-body)',
            }}
          />
        </span>
      )}
    </Field>
  );
}
