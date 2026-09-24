import { AvatarType } from "./types"

// Robot intentionally isn't offered here - the abstract Orb is the app's
// one non-animal presence, and it's reserved for the "Speak with Aura"
// conversation screen, not offered as a swappable companion skin. Fox and
// Plant are real downloaded/licensed 3D assets (Fox.glb CC0/CC-BY,
// Plant.glb CC0). Dog/Cat/Rabbit are custom-built stylised 3D geometry -
// a real CC0 dog rig (Gobkit's Corgi) was tried and is genuinely licensed
// and fetchable, but its skin/skeleton didn't render correctly in this
// viewer after multiple fitting attempts, so it was reverted rather than
// ship a broken model.
const OPTIONS: { value: AvatarType; label: string }[] = [
  { value: "fox", label: "Fox (3D)" },
  { value: "dog", label: "Dog" },
  { value: "cat", label: "Cat" },
  { value: "rabbit", label: "Rabbit" },
  { value: "plant", label: "Plant (3D)" },
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
