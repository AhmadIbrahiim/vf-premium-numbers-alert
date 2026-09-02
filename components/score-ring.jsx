import { scoreStyle } from "../lib/format.js";

/**
 * Circular score gauge. The arc is drawn against 60 rather than 100, because no number
 * in the public catalogues scores above 59 — against 100 every ring would look empty.
 */
export default function ScoreRing({ score, size = 56 }) {
  const value = Number(score) || 0;
  const { ring, text } = scoreStyle(value);
  const r = (size - 12) / 2;
  const circumference = 2 * Math.PI * r;
  const fraction = Math.max(0, Math.min(1, value / 60));
  const offset = circumference * (1 - fraction);

  return (
    <div
      className="relative grid shrink-0 place-items-center"
      style={{ height: size, width: size }}
      aria-label={`score ${value} of 60`}
    >
      <svg className="-rotate-90" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(125,125,125,.22)" strokeWidth="4" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={ring}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference.toFixed(1)}
          strokeDashoffset={offset.toFixed(1)}
        />
      </svg>
      <span className={`absolute num-tnum font-bold ${size >= 72 ? "text-xl" : "text-base"} ${text}`}>
        {value}
      </span>
    </div>
  );
}
