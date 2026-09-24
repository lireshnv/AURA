import { ReactNode } from "react"
import { motion } from "framer-motion"

/** Small floating glass card, the kind that surrounds the Landing hero
 * visual ("Wellbeing", "Private", "Counsellor" ...). Each instance gets its
 * own float phase via `delay` so a cluster of them doesn't move in unison. */
export default function FloatCard({
  icon,
  label,
  value,
  className = "",
  delay = 0,
}: {
  icon: ReactNode
  label: string
  value?: string
  className?: string
  delay?: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] }}
      className={`aura-glass-strong rounded-2xl px-4 py-3 flex items-center gap-3 shadow-[0_20px_60px_rgba(0,0,0,0.35)] animate-aura-float ${className}`}
      style={{ animationDelay: `${delay}s` }}
    >
      <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-[var(--color-glow-violet)] shrink-0">
        {icon}
      </div>
      <div className="text-left leading-tight">
        <p className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</p>
        {value && <p className="text-[13px] font-semibold text-[var(--color-ink)]">{value}</p>}
      </div>
    </motion.div>
  )
}
