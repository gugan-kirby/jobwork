/**
 * A small part-to-whole donut (VF-15, reference screen 15 "Orders Overview"): up to three
 * categorical slots in fixed order, a 2 px surface gap between segments, the total in the
 * centre and a legend with every count — so no segment is identified by colour alone and
 * the figure reads without hovering. Each segment carries a native tooltip.
 */

export interface DonutSlice {
  label: string;
  value: number;
}

const SLOT = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'];

export function Donut({
  slices,
  totalLabel,
}: {
  slices: readonly DonutSlice[];
  totalLabel: string;
}): React.JSX.Element {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const r = 40;
  const c = 2 * Math.PI * r;
  const gap = total > 0 && slices.filter((s) => s.value > 0).length > 1 ? 2 : 0;
  let offset = 0;
  return (
    <figure className="jw-donut">
      <svg viewBox="0 0 100 100" width="132" height="132" role="img" aria-label={`${total} ${totalLabel}: ${slices.map((s) => `${s.value} ${s.label}`).join(', ')}`}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--neutral-200)" strokeWidth="14" />
        {total > 0
          ? slices.map((slice, index) => {
              const length = (slice.value / total) * c;
              const dash = Math.max(0, length - gap);
              const node = slice.value > 0 ? (
                <circle
                  key={slice.label}
                  cx="50"
                  cy="50"
                  r={r}
                  fill="none"
                  stroke={SLOT[index % SLOT.length]}
                  strokeWidth="14"
                  strokeDasharray={`${dash} ${c - dash}`}
                  strokeDashoffset={-offset}
                  transform="rotate(-90 50 50)"
                >
                  <title>{`${slice.label}: ${slice.value}`}</title>
                </circle>
              ) : null;
              offset += length;
              return node;
            })
          : null}
        <text x="50" y="49" textAnchor="middle" className="jw-donut-total">
          {total}
        </text>
        <text x="50" y="62" textAnchor="middle" className="jw-donut-caption">
          {totalLabel}
        </text>
      </svg>
      <figcaption>
        <ul className="jw-donut-legend">
          {slices.map((slice, index) => (
            <li key={slice.label}>
              <span className="jw-donut-key" style={{ background: SLOT[index % SLOT.length] }} aria-hidden="true" />
              <span className="jw-donut-label">{slice.label}</span>
              <span className="jw-donut-value numeric">{slice.value}</span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}
