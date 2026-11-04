/**
 * A single-series trend line (VF-18, reference screen 15 "Revenue"): one 2 px line, a soft
 * area under it, a marker on the latest point. The figure beside it carries the value, so
 * the line is named by its aria-label and each point keeps a native tooltip.
 */
export function Sparkline({
  points,
  label,
}: {
  points: ReadonlyArray<{ label: string; value: number }>;
  label: string;
}): React.JSX.Element {
  const width = 160;
  const height = 56;
  const max = Math.max(1, ...points.map((p) => p.value));
  const step = width / Math.max(1, points.length - 1);
  const at = points.map((p, index) => ({ ...p, x: index * step, y: height - 6 - (p.value / max) * (height - 12) }));
  const line = at.map((p) => `${p.x},${p.y}`).join(' ');
  const last = at[at.length - 1];
  return (
    <svg viewBox={`-4 0 ${width + 8} ${height}`} width="100%" role="img" aria-label={label} className="jw-spark" style={{ maxWidth: 170 }}>
      <polygon points={`0,${height} ${line} ${width},${height}`} className="jw-spark-area" />
      <polyline points={line} className="jw-spark-line" />
      {last ? <circle cx={last.x} cy={last.y} r="4" className="jw-spark-dot" /> : null}
      {at.map((p) => (
        <circle key={p.label} cx={p.x} cy={p.y} r="8" fill="transparent">
          <title>{p.label}</title>
        </circle>
      ))}
    </svg>
  );
}
