'use client';

import type { Tone } from '../tokens';

/**
 * The status chip (doc 21 §6), now covering all six semantic tones rather than the
 * enquiry projection alone.
 *
 * `DS-07` is the reason for the glyph: colour never carries meaning by itself, so every
 * chip renders a mark *and* a label. Someone who cannot distinguish the amber from the
 * green still sees `!` against `✓`, and a screen reader gets the tone spelled out.
 *
 * `DS-04` is the reason `special` exists at all: an item accepted under deviation must
 * not wear the same green as a clean pass. It passed — with an asterisk, and the chip
 * says so.
 */

const MARK: Record<Tone, string> = {
  neutral: '·',
  progress: '›',
  attention: '!',
  positive: '✓',
  blocked: '×',
  special: '*',
};

const TONE_MEANING: Record<Tone, string> = {
  neutral: 'inactive',
  progress: 'in progress',
  attention: 'action needed',
  positive: 'passed',
  blocked: 'blocked',
  special: 'passed with a deviation',
};

export interface StatusChipProps {
  tone: Tone;
  children: React.ReactNode;
  /** Suppresses the spoken tone where the label already says it. */
  silent?: boolean | undefined;
}

export function StatusChip({ tone, children, silent }: StatusChipProps): React.JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        padding: '2px var(--space-2)',
        borderRadius: 'var(--radius-sm)',
        background: `var(--status-${tone}-bg)`,
        border: `1px solid var(--status-${tone}-border)`,
        color: `var(--status-${tone}-fg)`,
        font: 'var(--text-caption)',
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ fontWeight: 700 }}>
        {MARK[tone]}
      </span>
      {children}
      {silent ? null : <span className="jw-visually-hidden"> — {TONE_MEANING[tone]}</span>}
    </span>
  );
}

/** Kept as the legacy name used by the document manifest row. */
export const Chip = StatusChip;
