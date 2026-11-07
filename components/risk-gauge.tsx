/** Semicircular 0–100 risk gauge, shared by the dashboard and the customer's /protect page. */
export function RiskGauge({
  score,
  threshold = 70,
  size = "md",
  label = "Risk",
}: {
  score: number | null;
  threshold?: number;
  size?: "md" | "lg";
  label?: string;
}) {
  const value = Math.max(0, Math.min(100, score ?? 0));
  const angle = Math.PI * (1 - value / 100);
  const x = 50 + 40 * Math.cos(angle);
  const y = 50 - 40 * Math.sin(angle);
  const colour = value >= threshold ? "stroke-destructive" : value >= 40 ? "stroke-amber-400" : "stroke-emerald-400";
  // Threshold tick.
  const ta = Math.PI * (1 - threshold / 100);
  const t1 = { x: 50 + 34 * Math.cos(ta), y: 50 - 34 * Math.sin(ta) };
  const t2 = { x: 50 + 47 * Math.cos(ta), y: 50 - 47 * Math.sin(ta) };
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 100 58" className={size === "lg" ? "w-56" : "w-36"} role="img" aria-label={`${label} ${score ?? "unknown"} out of 100`}>
        <path d="M10 50 A40 40 0 0 1 90 50" className="fill-none stroke-muted" strokeWidth="9" strokeLinecap="round" />
        {score !== null && value > 0 && (
          <path
            d={`M10 50 A40 40 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`}
            className={`fill-none ${colour} transition-all duration-700`}
            strokeWidth="9"
            strokeLinecap="round"
          />
        )}
        <line x1={t1.x} y1={t1.y} x2={t2.x} y2={t2.y} className="stroke-foreground/50" strokeWidth="1.2" />
        <text x="50" y="47" textAnchor="middle" className="fill-foreground font-mono text-[18px] font-bold">
          {score ?? "—"}
        </text>
      </svg>
      <span className="-mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
    </div>
  );
}
