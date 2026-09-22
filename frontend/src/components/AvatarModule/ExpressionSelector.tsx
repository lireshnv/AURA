import { Expression } from "./types"

const OPTIONS: { value: Expression; label: string }[] = [
  { value: "natural", label: "Natural" },
  { value: "happy", label: "Happy" },
  { value: "sad", label: "Sad" },
  { value: "concerned", label: "Concerned" },
  { value: "angry", label: "Angry" },
  { value: "surprised", label: "Surprised" },
  { value: "calm", label: "Calm" },
  { value: "neutral", label: "Neutral" },
]

export default function ExpressionSelector({
  value,
  onChange,
}: {
  value: Expression
  onChange: (v: Expression) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-label-md text-on-surface-variant">
      Expression
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Expression)}
        className="bg-surface-container-low border border-outline-variant text-on-surface text-label-md rounded-full px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary"
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
