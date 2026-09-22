import { useState } from "react"
import MyWellbeing, { Tab as WellbeingTab } from "./MyWellbeing"
import RiskAndTrend from "./RiskAndTrend"

type SubPage = "wellbeing" | "risk"

/**
 * Combines the Well-being and Risk & Trend pages under one nav entry.
 * Neither page's own internals change - this is only the outer switcher;
 * MyWellbeing and RiskAndTrend are rendered exactly as before.
 */
export default function WellbeingRiskPage({
  onOpenCompanion,
  initialWellbeingTab = "overview",
}: {
  onOpenCompanion?: () => void
  initialWellbeingTab?: WellbeingTab
}) {
  const [sub, setSub] = useState<SubPage>("wellbeing")

  return (
    <div className="space-y-stack-sm">
      <div className="flex gap-1 border-b border-outline-variant">
        {(
          [
            ["wellbeing", "Well-being"],
            ["risk", "Risk & Trend"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSub(key)}
            className={`px-4 py-2 text-label-md whitespace-nowrap -mb-px border-b-2 ${
              sub === key
                ? "border-primary text-primary font-bold"
                : "border-transparent text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {sub === "wellbeing" ? (
        <MyWellbeing onOpenCompanion={onOpenCompanion} initialTab={initialWellbeingTab} />
      ) : (
        <RiskAndTrend />
      )}
    </div>
  )
}
