'use client';

import type { Measurement } from '@jobwork/contracts';
import { Field } from '../primitives/Field';

/**
 * Doc 21 §7 measurement input: a number and its unit, entered together and stored
 * together.
 *
 * There is deliberately no conversion and no "preferred unit" setting. A tolerance typed
 * as 0.05 mm stays 0.05 mm all the way into the frozen requirement, because a silent
 * conversion is the kind of error nobody finds until parts are scrap. Changing the unit
 * relabels the number; it never rescales it. Normalized forms are computed later,
 * versioned, and always kept beside the original (doc 09 §10).
 */

const MEASUREMENT_UNITS = ['mm', 'um', 'inch', 'deg'] as const;

const UNIT_LABELS: Record<(typeof MEASUREMENT_UNITS)[number], string> = {
  mm: 'mm',
  um: 'µm',
  inch: 'in',
  deg: '°',
};

export interface MeasurementInputProps {
  label: string;
  value: Measurement | null;
  onChange: (value: Measurement | null) => void;
  hint?: string | undefined;
  error?: string | undefined;
  disabled?: boolean | undefined;
}

export function MeasurementInput({
  label,
  value,
  onChange,
  hint,
  error,
  disabled,
}: MeasurementInputProps): React.JSX.Element {
  const unit = value?.unit ?? 'mm';

  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => (
        <span style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <input
            {...control}
            type="number"
            step="any"
            inputMode="decimal"
            disabled={disabled}
            className="numeric"
            value={value ? String(value.value) : ''}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === '') {
                onChange(null);
                return;
              }
              const parsed = Number(raw);
              if (Number.isFinite(parsed)) onChange({ value: parsed, unit });
            }}
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
          <UnitSelect
            units={MEASUREMENT_UNITS}
            labels={UNIT_LABELS}
            value={unit}
            disabled={disabled}
            ariaLabel={`${label} unit`}
            onChange={(next) => {
              if (value) onChange({ value: value.value, unit: next as Measurement['unit'] });
            }}
          />
        </span>
      )}
    </Field>
  );
}

export interface UnitSelectProps {
  units: readonly string[];
  labels?: Record<string, string> | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  ariaLabel?: string | undefined;
}

export function UnitSelect({
  units,
  labels,
  value,
  onChange,
  disabled,
  ariaLabel = 'Unit',
}: UnitSelectProps): React.JSX.Element {
  return (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={{
        minHeight: 'var(--control-height)',
        padding: '0 var(--space-2)',
        border: '1px solid var(--field-border)',
        borderRadius: 'var(--field-radius)',
        font: 'var(--text-body)',
        background: 'var(--field-bg)',
        color: 'var(--color-text)',
      }}
    >
      {units.map((unit) => (
        <option key={unit} value={unit}>
          {labels?.[unit] ?? unit}
        </option>
      ))}
    </select>
  );
}
