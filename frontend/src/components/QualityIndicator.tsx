import { Gauge, AlertTriangle } from "lucide-react"
import { FacialEvidence, QualityInfo } from "../types"

const QUALITY_COLOR: Record<string, string> = {
  good: "text-emerald-600",
  acceptable: "text-amber-600",
  poor: "text-rose-600",
  rejected: "text-rose-600",
}

export default function QualityIndicator({
  quality,
  evidence,
}: {
  quality?: QualityInfo
  evidence?: FacialEvidence
}) {
  if (!quality) return null

  return (
    <div className="mt-3 pt-3 border-t border-slate-200 space-y-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="flex items-center gap-1.5 text-slate-500">
          <Gauge size={12} />
          Image quality
        </span>
        <span className={`font-medium ${QUALITY_COLOR[quality.label] ?? "text-slate-500"}`}>
          {quality.overall.toFixed(0)}% · {quality.label}
        </span>
      </div>

      {!quality.head_pose_ok && (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-600">
          <AlertTriangle size={11} />
          Head turned — geometry weighted down
        </div>
      )}

      {evidence && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
          <div className="flex justify-between">
            <span>smile</span>
            <span className="text-slate-600">{evidence.smile.toFixed(0)}%</span>
          </div>
          <div className="flex justify-between">
            <span>motion</span>
            <span className="text-slate-600">{evidence.facial_motion.toFixed(0)}%</span>
          </div>
        </div>
      )}
    </div>
  )
}
