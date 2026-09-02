/**
 * Inline SVG sparkline. No charting library for one polyline; `viewBox` plus
 * `preserveAspectRatio="none"` makes it stretch to whatever width the card has.
 */
export default function Sparkline({ values, stroke, height = 44 }) {
  if (!values || values.length < 2) return null;

  const width = 300;
  const pad = 3;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = (width - pad * 2) / (values.length - 1);

  const points = values.map((v, i) => {
    const x = pad + i * step;
    const y = height - pad - ((v - min) / span) * (height - pad * 2);
    return [x, y];
  });
  const last = points[points.length - 1];

  return (
    <svg
      className="mt-3.5 block w-full"
      style={{ height }}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
      />
      <circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r="2.6" fill={stroke} />
    </svg>
  );
}
