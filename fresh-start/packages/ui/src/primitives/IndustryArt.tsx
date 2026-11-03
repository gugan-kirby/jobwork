import type { CSSProperties } from 'react';

/**
 * Small original illustrations for the customer home (VF-04, reference screen 04): the
 * banner's machines drawn light-on-brand, and one picture per process for the category
 * tiles. Token fills only; decorative by contract (`aria-hidden`), the label beside each
 * one carries the meaning.
 */

const f = (token: string): CSSProperties => ({ fill: `var(${token})` });

/** Milling centre and column machine in whites and pale blues, for the brand banner. */
export function BannerMachines(): React.JSX.Element {
  return (
    <svg viewBox="0 0 170 120" width="100%" aria-hidden="true" focusable="false" style={{ display: 'block', height: 'auto' }}>
      <circle cx="60" cy="40" r="34" style={{ ...f('--blue-500'), opacity: 0.35 }} />
      {/* milling centre */}
      <rect x="10" y="68" width="92" height="36" rx="4" style={f('--color-surface')} />
      <rect x="10" y="68" width="92" height="6" rx="3" style={f('--blue-100')} />
      <rect x="32" y="28" width="48" height="36" rx="4" style={{ fill: 'none', stroke: 'var(--color-surface)', strokeWidth: 6 }} />
      <rect x="50" y="16" width="12" height="32" rx="2" style={f('--blue-200')} />
      <rect x="52" y="10" width="8" height="7" rx="1.5" style={f('--color-surface')} />
      <rect x="40" y="62" width="32" height="7" rx="1.5" style={f('--blue-300')} />
      <circle cx="26" cy="88" r="7" style={f('--blue-300')} />
      <circle cx="26" cy="88" r="3" style={f('--blue-700')} />
      <rect x="44" y="84" width="20" height="4" rx="2" style={f('--blue-300')} />
      <circle cx="84" cy="88" r="7" style={f('--blue-200')} />
      <circle cx="84" cy="88" r="3" style={f('--blue-600')} />
      {/* operator */}
      <circle cx="116" cy="62" r="5" style={f('--illus-skin')} />
      <path d="M109 72 Q116 68 123 72 L122 92 L110 92 Z" style={f('--blue-300')} />
      <rect x="110" y="92" width="5" height="12" style={f('--blue-900')} />
      <rect x="117" y="92" width="5" height="12" style={f('--blue-900')} />
      {/* column machine */}
      <rect x="132" y="62" width="30" height="42" rx="3" style={f('--blue-800')} />
      <rect x="137" y="70" width="20" height="4" rx="1" style={f('--blue-300')} />
      <rect x="137" y="78" width="20" height="4" rx="1" style={f('--blue-300')} />
      <rect x="141" y="22" width="12" height="42" rx="2" style={f('--blue-100')} />
      <rect x="136" y="6" width="22" height="20" rx="4" style={f('--color-surface')} />
      <rect x="141" y="11" width="9" height="9" rx="1.5" style={f('--blue-400')} />
      <rect x="0" y="104" width="170" height="7" rx="2" style={f('--blue-900')} />
    </svg>
  );
}

type ArtName = 'milling' | 'vmc' | 'turning' | 'welding' | 'casting' | 'sheet' | 'forging' | 'moulding';

const ART: Record<ArtName, React.JSX.Element> = {
  milling: (
    <>
      <rect x="6" y="40" width="52" height="18" rx="3" style={f('--blue-400')} />
      <rect x="18" y="14" width="28" height="24" rx="3" style={{ fill: 'none', stroke: 'var(--blue-500)', strokeWidth: 5 }} />
      <rect x="28" y="6" width="8" height="24" rx="2" style={f('--blue-700')} />
      <rect x="22" y="36" width="20" height="5" rx="1" style={f('--blue-800')} />
      <circle cx="16" cy="49" r="4" style={f('--illus-accent')} />
      <rect x="40" y="45" width="12" height="8" rx="1" style={f('--color-surface')} />
    </>
  ),
  vmc: (
    <>
      <rect x="10" y="8" width="44" height="50" rx="4" style={f('--color-surface')} />
      <rect x="10" y="8" width="44" height="50" rx="4" style={{ fill: 'none', stroke: 'var(--blue-300)', strokeWidth: 2 }} />
      <rect x="15" y="16" width="24" height="26" rx="2" style={f('--blue-100')} />
      <rect x="25" y="16" width="5" height="14" style={f('--blue-600')} />
      <rect x="42" y="16" width="8" height="12" rx="1.5" style={f('--blue-700')} />
      <rect x="10" y="46" width="44" height="12" rx="2" style={f('--blue-800')} />
      <rect x="44" y="32" width="5" height="5" rx="1" style={f('--illus-accent')} />
    </>
  ),
  turning: (
    <>
      <rect x="4" y="40" width="56" height="10" rx="3" style={f('--neutral-700')} />
      <rect x="6" y="20" width="16" height="22" rx="3" style={f('--illus-accent')} />
      <circle cx="14" cy="31" r="5" style={f('--neutral-800')} />
      <rect x="22" y="28" width="26" height="6" rx="2" style={f('--neutral-400')} />
      <rect x="46" y="22" width="12" height="20" rx="2" style={f('--illus-accent')} />
      <circle cx="14" cy="54" r="5" style={f('--neutral-800')} />
      <circle cx="50" cy="54" r="5" style={f('--neutral-800')} />
    </>
  ),
  welding: (
    <>
      <rect x="8" y="46" width="48" height="8" rx="2" style={f('--neutral-500')} />
      <path d="M14 14 L40 40 L35 45 L9 19 Z" style={f('--neutral-600')} />
      <rect x="36" y="10" width="10" height="26" rx="4" transform="rotate(35 41 23)" style={f('--illus-accent')} />
      <path d="M30 44 l4 -6 l3 5 l4 -4 l1 6 z" style={f('--illus-accent')} />
      <circle cx="38" cy="44" r="2.5" style={f('--color-surface')} />
    </>
  ),
  casting: (
    <>
      <path d="M14 10 h24 l-4 14 h-16 z" style={f('--neutral-600')} />
      <path d="M33 22 q6 8 2 18" style={{ fill: 'none', stroke: 'var(--illus-accent)', strokeWidth: 4, strokeLinecap: 'round' }} />
      <rect x="12" y="40" width="40" height="16" rx="3" style={f('--blue-500')} />
      <rect x="26" y="36" width="14" height="6" rx="2" style={f('--illus-accent')} />
    </>
  ),
  sheet: (
    <>
      <path d="M6 40 L30 28 L58 40 L34 52 Z" style={f('--blue-200')} />
      <path d="M6 40 L34 52 L34 58 L6 46 Z" style={f('--blue-400')} />
      <path d="M34 52 L58 40 L58 46 L34 58 Z" style={f('--blue-500')} />
      <rect x="26" y="8" width="12" height="18" rx="2" style={f('--blue-700')} />
      <path d="M32 26 v8" style={{ stroke: 'var(--status-blocked-fg)', strokeWidth: 2 }} />
    </>
  ),
  forging: (
    <>
      <rect x="10" y="44" width="44" height="12" rx="3" style={f('--neutral-700')} />
      <rect x="18" y="36" width="28" height="9" rx="2" style={f('--illus-accent')} />
      <rect x="26" y="6" width="12" height="26" rx="2" style={f('--neutral-500')} />
      <rect x="18" y="6" width="28" height="8" rx="2" style={f('--neutral-600')} />
    </>
  ),
  moulding: (
    <>
      <rect x="6" y="22" width="34" height="30" rx="3" style={f('--blue-400')} />
      <rect x="40" y="30" width="18" height="14" rx="2" style={f('--blue-200')} />
      <rect x="12" y="10" width="10" height="14" rx="2" style={f('--blue-700')} />
      <circle cx="49" cy="37" r="4" style={f('--illus-accent')} />
      <rect x="6" y="52" width="52" height="5" rx="2" style={f('--blue-800')} />
    </>
  ),
};

/** Picks a picture from a process code or label; anything unknown gets the milling centre. */
export function processArtFor(code: string): ArtName {
  const c = code.toLowerCase();
  if (c.includes('vmc')) return 'vmc';
  if (c.includes('turn')) return 'turning';
  if (c.includes('weld') || c.includes('fabric')) return 'welding';
  if (c.includes('cast')) return 'casting';
  if (c.includes('sheet') || c.includes('laser') || c.includes('bend')) return 'sheet';
  if (c.includes('forg') || c.includes('form')) return 'forging';
  if (c.includes('mould') || c.includes('mold') || c.includes('injection')) return 'moulding';
  return 'milling';
}

export function ProcessArt({ name, size = 56 }: { name: ArtName; size?: number }): React.JSX.Element {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      {ART[name]}
    </svg>
  );
}
