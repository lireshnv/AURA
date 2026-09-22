import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts"
import { Observation } from "../types"

const LINES: { key: keyof Observation["emotion_scores"]; color: string }[] = [
  { key: "happy", color: "#34d399" },
  { key: "neutral", color: "#64748b" },
  { key: "sad", color: "#60a5fa" },
  { key: "angry", color: "#f87171" },
]

const MAX_POINTS = 120

export default function EmotionTimeline({ observations }: { observations: Observation[] }) {
  const windowed = observations.slice(-MAX_POINTS)

  const data = windowed.map((o) => ({
    time: new Date(o.timestamp).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
    ...o.emotion_scores,
  }))

  if (data.length === 0) {
    return (
      <div className="h-56 flex items-center justify-center text-sm text-slate-500">
        No data yet. Start analysis to see the emotion graph.
      </div>
    )
  }

  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ left: 8, right: 16, top: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="time" tick={{ fill: "#64748b", fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fill: "#64748b", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip
            contentStyle={{ background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "#0f172a" }}
            formatter={(v: any, name: any) => [`${Number(v).toFixed(0)}%`, String(name)]}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {LINES.map((line) => (
            <Line
              key={line.key}
              type="monotone"
              dataKey={line.key}
              stroke={line.color}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
