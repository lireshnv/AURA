import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts"
import { EmotionScores } from "../types"

const ORDER: (keyof EmotionScores)[] = ["happy", "neutral", "surprise", "sad", "angry", "fear", "disgust"]

export default function EmotionDistribution({
  scores,
  emptyLabel = "No data available",
}: {
  scores?: EmotionScores
  emptyLabel?: string
}) {
  // An all-zero chart is not a measurement - it looks like one. When there is
  // no analysis, say so rather than rendering seven 0% bars that read as a
  // real distribution.
  const total = scores
    ? ORDER.reduce((sum, k) => sum + (scores[k] ?? 0), 0)
    : 0

  if (!scores || total <= 0) {
    return (
      <div className="h-48 flex items-center justify-center">
        <p className="text-sm text-on-surface-variant">{emptyLabel}</p>
      </div>
    )
  }

  const data = ORDER.map((key) => ({
    name: key.charAt(0).toUpperCase() + key.slice(1),
    value: scores[key] ?? 0,
  }))

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="name" width={64} tick={{ fill: "#475569", fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={{ background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "#0f172a" }}
            formatter={(v: any) => [`${Number(v).toFixed(1)}%`, "Score"]}
          />
          <Bar dataKey="value" fill="#6366f1" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
