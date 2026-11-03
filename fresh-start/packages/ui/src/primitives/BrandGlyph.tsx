import { useId } from 'react';

/**
 * The JobWork mark (VF-01, splash reference): a gear with a wrench laid across its bore.
 * Drawn in one colour (`currentColor`) with the wrench cut out of the gear by a mask, so
 * whatever is behind the mark — the hero gradient, a brand-blue square — shows through
 * the gap. Decorative by contract like `Icon`: the product name always sits next to it.
 */

const TEETH = [0, 45, 90, 135, 180, 225, 270, 315];
/** One tapered tooth at twelve o'clock, rotated into place for the other seven. */
const TOOTH = 'M48.5 22 L51.5 6 Q52 3.5 54.5 3.5 L65.5 3.5 Q68 3.5 68.5 6 L71.5 22 Z';

/** The wrench in its own frame: head centred on the origin, jaw up, handle down. */
function Wrench({ gap = 0 }: { gap?: number }): React.JSX.Element {
  return (
    <>
      <circle cx="0" cy="0" r={16 + gap} />
      <rect x={-7 - gap} y="0" width={14 + gap * 2} height={56 + gap} rx={7 + gap} />
    </>
  );
}

export function BrandGlyph({ size = 120 }: { size?: number | string }): React.JSX.Element {
  const id = useId();
  const gearMask = `${id}-gear`;
  const jawMask = `${id}-jaw`;
  const wrenchAt = 'translate(54 54) rotate(-45)';

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', color: 'currentColor' }}
    >
      <defs>
        <mask id={gearMask} maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="120">
          <rect width="120" height="120" fill="#fff" />
          <circle cx="60" cy="60" r="25" fill="black" />
          <g transform={wrenchAt} fill="black">
            <Wrench gap={4} />
          </g>
        </mask>
        <mask id={jawMask} maskUnits="userSpaceOnUse" x="-60" y="-60" width="120" height="120">
          <rect x="-60" y="-60" width="120" height="120" fill="#fff" />
          <rect x="-6" y="-22" width="12" height="17" rx="2" fill="black" />
        </mask>
      </defs>

      <g mask={`url(#${gearMask})`} fill="currentColor">
        <circle cx="60" cy="60" r="43" />
        {TEETH.map((angle) => (
          <path key={angle} d={TOOTH} transform={`rotate(${angle} 60 60)`} />
        ))}
      </g>

      <g transform={wrenchAt} fill="currentColor" mask={`url(#${jawMask})`}>
        <Wrench />
      </g>
    </svg>
  );
}
