import { AnimationSelection } from "./types"

const OPTIONS: { value: AnimationSelection; label: string }[] = [
  { value: "auto", label: "Auto (follows conversation)" },
  { value: "idle", label: "Idle" },
  { value: "talking", label: "Talking" },
  { value: "listening", label: "Listening" },
  { value: "thinking", label: "Thinking" },
  { value: "greeting", label: "Greeting" },
  { value: "concerned", label: "Concerned" },
]

export default function AnimationSelector({
  value,
  onChange,
}: {
  value: AnimationSelection
  onChange: (v: AnimationSelection) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-label-md text-on-surface-variant">
      Animation
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as AnimationSelection)}
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
