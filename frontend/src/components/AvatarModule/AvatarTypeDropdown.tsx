import { AvatarType } from "./types"

const OPTIONS: { value: AvatarType; label: string }[] = [
  { value: "fox", label: "Fox (3D)" },
  { value: "dog", label: "Dog" },
  { value: "cat", label: "Cat" },
  { value: "robot", label: "Robot" },
  { value: "plant", label: "Plant" },
  { value: "custom", label: "Custom" },
]

export default function AvatarTypeDropdown({
  value,
  onChange,
}: {
  value: AvatarType
  onChange: (v: AvatarType) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-label-md text-on-surface-variant">
      Avatar Type
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as AvatarType)}
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
