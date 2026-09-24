import { Observation } from "../types"

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
}

function dominantEmotionOf(o: Observation): string {
  const scores = o.emotion_scores
  return (Object.keys(scores) as (keyof typeof scores)[]).reduce((best, k) =>
    scores[k] > scores[best] ? k : best
  )
}

function mode(values: string[]): string {
  if (values.length === 0) return "—"
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

export default function SessionMetrics({
  observations,
  sessionSeconds,
}: {
  observations: Observation[]
  sessionSeconds: number
}) {
  const total = observations.length
  const dominantEmotion = mode(observations.map(dominantEmotionOf))
  const avgConfidence = total > 0 ? observations.reduce((sum, o) => sum + o.confidence, 0) / total : 0

  const sentimentTotals = observations.reduce(
    (acc, o) => {
      acc.positive += o.sentiment.positive
      acc.neutral += o.sentiment.neutral
      acc.negative += o.sentiment.negative
      return acc
    },
    { positive: 0, neutral: 0, negative: 0 }
  )
  const pct = (n: number) => (total > 0 ? n / total : 0)

  const items = [
    { label: "Session Duration", value: formatDuration(sessionSeconds) },
    { label: "Total Analyses", value: String(total) },
    { label: "Dominant Emotion", value: dominantEmotion },
    { label: "Avg Confidence", value: `${avgConfidence.toFixed(0)}%` },
    { label: "Positive %", value: `${pct(sentimentTotals.positive).toFixed(0)}%` },
    { label: "Neutral %", value: `${pct(sentimentTotals.neutral).toFixed(0)}%` },
    { label: "Negative %", value: `${pct(sentimentTotals.negative).toFixed(0)}%` },
  ]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg bg-surface-container-lowest border border-outline-variant px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-on-surface-variant">{item.label}</div>
          <div className="text-sm font-semibold text-on-surface mt-0.5 truncate capitalize">{item.value}</div>
        </div>
      ))}
    </div>
  )
}
