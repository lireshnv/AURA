import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts"
import { MultimodalTimelinePoint } from "../types"

/**
 * Aligned face / voice / text / overall emotion over time.
 *
 * Emotions are ordinal-encoded onto a shared valence-ish axis purely so four
 * categorical series can be read on one chart. The spacing is presentational,
 * not a claim that "sad" is numerically twice "angry".
 */
const LEVEL: Record<string, number> = {
  angry: 0,
  disgust: 1,
  fear: 2,
  sad: 3,
  neutral: 4,
  surprise: 5,
  happy: 6,
  uncertain: 4,
}

const AXIS_LABELS = ["Angry", "Disgust", "Fear", "Sad", "Neutral", "Surprise", "Happy"]

const SERIES = [
  { key: "face", color: "#818cf8", name: "Face" },
  { key: "voice", color: "#34d399", name: "Voice" },
  { key: "text", color: "#fbbf24", name: "Text" },
  { key: "overall", color: "#f472b6", name: "Overall" },
]

const MAX_POINTS = 120

export default function MultimodalTimeline({ points }: { points: MultimodalTimelinePoint[] }) {
  const windowed = points.slice(-MAX_POINTS)

  const data = windowed.map((p) => ({
    time: new Date(p.timestamp).toLocaleTimeString([], {
      minute: "2-digit",
      second: "2-digit",
    }),
    face: p.face ? LEVEL[p.face] ?? null : null,
    voice: p.voice ? LEVEL[p.voice] ?? null : null,
    text: p.text ? LEVEL[p.text] ?? null : null,
    overall: p.overall ? LEVEL[p.overall] ?? null : null,
    faceLabel: p.face,
    voiceLabel: p.voice,
    textLabel: p.text,
    overallLabel: p.overall,
    agreement: p.agreement,
  }))

  if (data.length === 0) {
    return (
      <div className="h-56 flex items-center justify-center text-sm text-slate-500">
        No multimodal data yet. Start camera and/or voice analysis.
      </div>
    )
  }

  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ left: 8, right: 16, top: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis
            dataKey="time"
            tick={{ fill: "#64748b", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={[0, 6]}
            ticks={[0, 1, 2, 3, 4, 5, 6]}
            tickFormatter={(v) => AXIS_LABELS[v] ?? ""}
            tick={{ fill: "#64748b", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={58}
          />
          <Tooltip
            contentStyle={{
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "#0f172a" }}
            formatter={(_: any, name: any, props: any) => {
              const key = String(name).toLowerCase() + "Label"
              const label = props.payload?.[key]
              return [label ?? "—", String(name)]
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {SERIES.map((s) => (
            <Line
              key={s.key}
              type="stepAfter"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={s.key === "overall" ? 2.5 : 1.5}
              strokeDasharray={s.key === "overall" ? undefined : "4 2"}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
