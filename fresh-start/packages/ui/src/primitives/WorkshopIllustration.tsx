import type { CSSProperties } from 'react';

/**
 * The welcome workshop (VF-02, reference screen 02): a milling centre, an operator with a
 * tablet, a fitter at a bench and a column machine on one floor line. Flat shapes in the
 * brand ramp so it sits on white without competing with the actions under it.
 * Decorative by contract: `aria-hidden`, and nothing on the page depends on it.
 */

const fill = (token: string): CSSProperties => ({ fill: `var(${token})` });
const line = (token: string, width = 3): CSSProperties => ({
  fill: 'none',
  stroke: `var(${token})`,
  strokeWidth: width,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
});

function Gear({ x, y, r, token }: { x: number; y: number; r: number; token: string }): React.JSX.Element {
  return (
    <g transform={`translate(${x} ${y})`}>
      {[0, 45, 90, 135].map((a) => (
        <rect key={a} x={-r * 0.28} y={-r * 1.25} width={r * 0.56} height={r * 2.5} rx={r * 0.12} transform={`rotate(${a})`} style={fill(token)} />
      ))}
      <circle r={r} style={fill(token)} />
      <circle r={r * 0.42} style={fill('--color-surface')} />
    </g>
  );
}

function Person({
  x,
  shirt,
  trousers,
  long = false,
}: {
  x: number;
  shirt: string;
  trousers: string;
  long?: boolean;
}): React.JSX.Element {
  return (
    <g transform={`translate(${x} 0)`}>
      {/* legs */}
      <rect x="-9" y="108" width="8" height="38" rx="3" style={fill(trousers)} />
      <rect x="1" y="108" width="8" height="38" rx="3" style={fill(trousers)} />
      <rect x="-11" y="144" width="11" height="4" rx="2" style={fill('--illus-hair')} />
      <rect x="0" y="144" width="11" height="4" rx="2" style={fill('--illus-hair')} />
      {/* torso */}
      <path d="M-13 74 Q0 68 13 74 L12 112 L-12 112 Z" style={fill(shirt)} />
      <rect x="-12" y="104" width="24" height="5" style={fill(trousers)} />
      {/* neck and head */}
      <rect x="-3" y="62" width="6" height="9" style={fill('--illus-skin')} />
      <circle cx="0" cy="54" r="10" style={fill('--illus-skin')} />
      <path d="M-10.5 53 Q-10 41 0 41 Q11 41 10.5 53 Q7 46 0 47 Q-6 46 -10.5 53 Z" style={fill('--illus-hair')} />
      {long ? <path d="M8 46 Q16 52 12 64 Q9 58 8 50 Z" style={fill('--illus-hair')} /> : null}
    </g>
  );
}

export function WorkshopIllustration(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 360 170"
      width="100%"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', height: 'auto' }}
    >
      {/* backdrop */}
      <ellipse cx="95" cy="118" rx="88" ry="52" style={fill('--blue-50')} />
      <ellipse cx="262" cy="96" rx="98" ry="78" style={fill('--blue-50')} />
      <ellipse cx="180" cy="160" rx="176" ry="6" style={fill('--blue-50')} />

      {/* milling centre */}
      <rect x="22" y="104" width="150" height="46" rx="5" style={fill('--blue-400')} />
      <rect x="22" y="104" width="150" height="8" rx="3" style={fill('--blue-500')} />
      <rect x="58" y="44" width="78" height="52" rx="6" style={line('--blue-500', 9)} />
      <rect x="88" y="26" width="18" height="44" rx="3" style={fill('--blue-600')} />
      <rect x="91" y="18" width="12" height="10" rx="2" style={fill('--blue-700')} />
      <path d="M93 70 h8 l-2 12 h-4 z" style={fill('--neutral-400')} />
      <rect x="72" y="96" width="50" height="9" rx="2" style={fill('--blue-700')} />
      <rect x="134" y="114" width="28" height="22" rx="3" style={fill('--color-surface')} />
      <rect x="138" y="118" width="20" height="7" rx="1" style={fill('--illus-accent')} />
      <circle cx="141" cy="131" r="2" style={fill('--blue-700')} />
      <circle cx="148" cy="131" r="2" style={fill('--blue-700')} />
      <Gear x={48} y={128} r={7} token="--illus-accent" />
      <Gear x={88} y={128} r={7} token="--blue-100" />
      <rect x="156" y="84" width="3" height="20" style={fill('--neutral-400')} />
      <rect x="153" y="80" width="9" height="6" rx="2" style={fill('--blue-300')} />

      {/* operator with tablet */}
      <Person x={196} shirt="--blue-400" trousers="--blue-500" long />
      <path d="M-12 78 L-16 96 L-6 100" transform="translate(196 0)" style={line('--blue-400', 6)} />
      <rect x="198" y="86" width="20" height="14" rx="2" transform="rotate(-12 208 93)" style={fill('--blue-200')} />
      <path d="M208 78 L212 94" style={line('--blue-400', 6)} />

      {/* fitter at the bench */}
      <Person x={262} shirt="--blue-200" trousers="--blue-800" />
      <rect x="230" y="96" width="70" height="6" rx="2" style={fill('--neutral-300')} />
      <rect x="234" y="102" width="4" height="46" style={fill('--neutral-300')} />
      <rect x="292" y="102" width="4" height="46" style={fill('--neutral-300')} />
      <rect x="246" y="104" width="34" height="40" rx="3" style={fill('--blue-500')} />
      <circle cx="246" cy="98" r="4.5" style={fill('--blue-700')} />
      <circle cx="278" cy="98" r="4.5" style={fill('--blue-700')} />
      <Gear x={262} y={90} r={5} token="--neutral-500" />
      <Gear x={306} y={78} r={5} token="--neutral-600" />

      {/* column machine */}
      <rect x="312" y="96" width="38" height="54" rx="4" style={fill('--blue-500')} />
      <rect x="318" y="104" width="26" height="5" rx="1" style={fill('--blue-800')} />
      <rect x="318" y="112" width="26" height="5" rx="1" style={fill('--blue-800')} />
      <rect x="320" y="124" width="22" height="14" rx="2" style={fill('--blue-100')} />
      <circle cx="316" cy="104" r="1.8" style={fill('--illus-accent')} />
      <rect x="324" y="46" width="14" height="52" rx="2" style={fill('--blue-600')} />
      <rect x="316" y="14" width="30" height="34" rx="6" style={fill('--color-surface')} />
      <rect x="316" y="14" width="30" height="34" rx="6" style={line('--blue-300', 2)} />
      <rect x="322" y="22" width="12" height="14" rx="2" style={fill('--blue-400')} />
      <rect x="327" y="8" width="8" height="7" rx="2" style={fill('--blue-700')} />

      {/* floor */}
      <rect x="10" y="148" width="340" height="8" rx="2" style={fill('--blue-800')} />
    </svg>
  );
}
