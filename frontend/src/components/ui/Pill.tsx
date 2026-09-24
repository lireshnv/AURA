import { ReactNode } from "react"

/** Small status/badge pill used across cinematic surfaces - "AURA is here",
 * live indicators, section eyebrows. */
export default function Pill({
  children,
  icon,
  dot,
}: {
  children: ReactNode
  icon?: ReactNode
  dot?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full aura-glass px-4 py-1.5 text-[13px] font-medium text-[var(--color-ink-dim)]">
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-glow-teal)] animate-pulse" />}
      {icon}
      {children}
    </span>
  )
}
