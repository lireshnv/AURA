import { AreaChart, Area, ResponsiveContainer, YAxis } from "recharts"

const LEVEL_COLOR: Record<string, string> = {
  Low: "text-emerald-600",
  Mild: "text-amber-600",
  Elevated: "text-orange-400",
  Variable: "text-orange-400",
  High: "text-rose-600",
  Stable: "text-emerald-600",
  Moderate: "text-amber-600",
}

interface Props {
  distressScore: number
  distressLevel: string
  stabilityScore: number
  stabilityLabel: string
  distressTrend: number[]
}

export default function DistressPanel({
  distressScore,
  distressLevel,
  stabilityScore,
  stabilityLabel,
  distressTrend,
}: Props) {
  const trendData = distressTrend.map((v, i) => ({ i, v }))

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-on-surface-variant mb-1">
          Distress Estimate <span className="normal-case text-on-surface-variant/70">(expression-based)</span>
        </div>
        <div className="flex items-end gap-2">
          <span className="text-2xl font-bold text-on-surface">{distressScore}</span>
          <span className="text-xs text-on-surface-variant mb-0.5">/ 100</span>
          <span className={`text-xs font-medium mb-1 ${LEVEL_COLOR[distressLevel] ?? "text-on-surface-variant"}`}>
            {distressLevel}
          </span>
        </div>
        {distressTrend.length > 1 && (
          <div className="h-10 mt-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData}>
                <YAxis hide domain={[0, 100]} />
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke="#fb923c"
                  fill="#fb923c"
                  fillOpacity={0.15}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wide text-on-surface-variant mb-1">Emotional Stability</div>
        <div className="flex items-end gap-2">
          <span className="text-2xl font-bold text-on-surface">{stabilityScore}</span>
          <span className="text-xs text-on-surface-variant mb-0.5">/ 100</span>
          <span className={`text-xs font-medium mb-1 ${LEVEL_COLOR[stabilityLabel] ?? "text-on-surface-variant"}`}>
            {stabilityLabel}
          </span>
        </div>
        <p className="text-[11px] text-on-surface-variant mt-2">
          {stabilityLabel === "Stable"
            ? "Detected expression probabilities have stayed consistent."
            : "Higher variation in detected expression probabilities."}
        </p>
      </div>
    </div>
  )
}
