import { SentimentResult } from "../types"

const ROWS: { key: keyof SentimentResult["scores"]; label: string; color: string }[] = [
  { key: "positive", label: "Positive", color: "bg-emerald-500" },
  { key: "neutral", label: "Neutral", color: "bg-slate-500" },
  { key: "negative", label: "Negative", color: "bg-rose-500" },
]

export default function SentimentChart({
  sentiment,
  emptyLabel = "No data available",
}: {
  sentiment?: SentimentResult
  emptyLabel?: string
}) {
  // Previously this defaulted to { negative: 100 } when no data existed,
  // rendering "Negative 100%" for someone who had run no analysis at all.
  // A fabricated maximum-distress reading is the worst possible default here.
  if (!sentiment?.scores) {
    return <p className="text-sm text-slate-400 py-4">{emptyLabel}</p>
  }
  const scores = sentiment.scores

  return (
    <div className="space-y-3">
      {ROWS.map((row) => (
        <div key={row.key}>
          <div className="flex justify-between text-xs text-slate-600 mb-1">
            <span>{row.label}</span>
            <span className="font-semibold">{scores[row.key].toFixed(0)}%</span>
          </div>
          <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
            <div
              className={`h-full ${row.color} transition-all duration-500`}
              style={{ width: `${scores[row.key]}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
