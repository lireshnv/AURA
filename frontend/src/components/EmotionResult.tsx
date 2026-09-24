import { motion, AnimatePresence } from "framer-motion"
import { Check } from "lucide-react"
import { EmotionResult as EmotionResultType } from "../types"

const EMOJI: Record<string, string> = {
  happy: "😊",
  sad: "😢",
  angry: "😠",
  fear: "😨",
  surprise: "😲",
  neutral: "😐",
  disgust: "🤢",
  uncertain: "🤔",
}

const RELIABILITY_COLOR: Record<string, string> = {
  low: "text-on-surface-variant",
  moderate: "text-amber-600",
  good: "text-sky-400",
  high: "text-emerald-600",
}

export default function EmotionResult({ emotion }: { emotion?: EmotionResultType }) {
  const dominant = emotion?.dominant ?? "uncertain"
  const isUncertain = dominant === "uncertain"

  return (
    <div className="flex flex-col items-center">
      <AnimatePresence mode="wait">
        <motion.div
          key={dominant}
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.7, opacity: 0 }}
          transition={{ duration: 0.22 }}
          className="text-6xl mt-2"
        >
          {EMOJI[dominant] ?? "🤔"}
        </motion.div>
      </AnimatePresence>

      <div className="text-2xl font-bold uppercase tracking-wide text-on-surface mt-2">
        {isUncertain ? "Uncertain" : dominant}
      </div>

      {isUncertain ? (
        <p className="text-xs text-on-surface-variant mt-1 text-center max-w-[240px]">
          Evidence is insufficient to name an expression confidently.
        </p>
      ) : (
        emotion && (
          <div className="w-full mt-4 space-y-1.5">
            {[
              { label: "Confidence", value: `${emotion.confidence.toFixed(0)}%` },
              {
                label: "Reliability",
                value: `${emotion.reliability.toFixed(0)}%`,
                color: RELIABILITY_COLOR[emotion.reliability_label],
              },
              { label: "Intensity", value: `${emotion.expression_intensity.toFixed(0)}%` },
              { label: "Reaction", value: emotion.overall_reaction },
            ].map((row) => (
              <div key={row.label} className="flex justify-between text-xs">
                <span className="text-on-surface-variant">{row.label}</span>
                <span className={`font-semibold ${row.color ?? "text-on-surface"}`}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        )
      )}

      {emotion?.session_dominant && !isUncertain && emotion.session_dominant !== dominant && (
        <div className="mt-3 w-full rounded-lg bg-surface-container-low border border-outline-variant px-2.5 py-1.5 text-[11px] text-on-surface-variant">
          Session overall:{" "}
          <span className="text-on-surface capitalize font-medium">
            {EMOJI[emotion.session_dominant] ?? ""} {emotion.session_dominant}
          </span>
        </div>
      )}

      {emotion?.recent_reaction && (
        <div className="mt-2 w-full rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-1.5 text-[11px] text-amber-800">
          Brief reaction: {emotion.recent_reaction.replace("->", "→")}
        </div>
      )}

      {emotion?.reasons && emotion.reasons.length > 0 && (
        <div className="mt-3 w-full">
          <div className="text-[10px] uppercase tracking-wide text-on-surface-variant mb-1.5">
            Why {isUncertain ? "uncertain" : dominant}?
          </div>
          <ul className="space-y-1">
            {emotion.reasons.map((reason, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11px] text-on-surface-variant">
                <Check size={11} className="mt-0.5 shrink-0 text-emerald-600" />
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
