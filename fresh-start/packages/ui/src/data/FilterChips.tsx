'use client';

import { useId, useRef, type KeyboardEvent } from 'react';

/**
 * A single-select chip row (F-MX.7, prototype tiles 8/11 "All · Pending · Quoted …").
 *
 * Semantically it is a radio group: exactly one filter is on, choosing one turns the
 * others off, and the arrow keys move between them. It is *not* a tab list — the chips
 * filter one list, they do not switch between panels — so a screen-reader user hears
 * "radio group, In review, 2 of 5" rather than being promised tabs that are not there.
 *
 * On a phone the row scrolls sideways instead of wrapping, so the list underneath keeps
 * its place on screen; the scroll container is reachable by keyboard via the chips.
 */

export interface FilterChipOption<T extends string> {
  value: T;
  label: string;
  /** Items behind this filter, shown as a count when known. */
  count?: number | undefined;
}

export interface FilterChipsProps<T extends string> {
  /** The spoken name of the group, e.g. "Filter enquiries by status". */
  label: string;
  value: T;
  options: readonly FilterChipOption<T>[];
  onChange: (value: T) => void;
}

export function FilterChips<T extends string>({
  label,
  value,
  options,
  onChange,
}: FilterChipsProps<T>): React.JSX.Element {
  const id = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (index - 1 + options.length) % options.length;
    }
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = options.length - 1;
    if (next === null) return;
    event.preventDefault();
    const option = options[next]!;
    onChange(option.value);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-labelledby={`${id}-label`} className="jw-chips">
      <span id={`${id}-label`} className="jw-visually-hidden">
        {label}
      </span>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            // Roving tabindex: one stop for the whole group, arrows move within it.
            tabIndex={checked ? 0 : -1}
            className={checked ? 'jw-chip jw-chip-on' : 'jw-chip'}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
            {typeof option.count === 'number' ? (
              <span className="jw-chip-count">{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
