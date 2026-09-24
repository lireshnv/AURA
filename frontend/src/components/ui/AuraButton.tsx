import { ReactNode } from "react"
import { motion } from "framer-motion"

type Variant = "primary" | "secondary" | "ghost"
type Size = "lg" | "md"

interface Props {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  children: ReactNode
  onClick?: () => void
  type?: "button" | "submit" | "reset"
  disabled?: boolean
  "aria-label"?: string
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-gradient-to-r from-[var(--color-glow-violet)] to-[#7c5cff] text-[#100c1c] shadow-[0_8px_30px_rgba(166,130,255,0.35)] hover:shadow-[0_10px_40px_rgba(166,130,255,0.5)]",
  secondary:
    "aura-glass text-[var(--color-ink)] hover:bg-white/10",
  ghost:
    "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] hover:bg-white/5",
}

const SIZE_CLASSES: Record<Size, string> = {
  lg: "px-7 py-4 text-[16px]",
  md: "px-5 py-2.5 text-[14px]",
}

/** Cinematic pill button for the Aura design system - used on Landing and
 * Victim Home. Separate from the app's existing MD3 buttons on purpose, so
 * this doesn't collide with the light-theme surfaces that stay unchanged. */
export default function AuraButton({ variant = "primary", size = "lg", icon, children, ...rest }: Props) {
  return (
    <motion.button
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: "spring", stiffness: 400, damping: 22 }}
      className={`inline-flex items-center justify-center gap-2.5 rounded-full font-semibold tracking-tight transition-colors ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]}`}
      {...rest}
    >
      {icon}
      {children}
    </motion.button>
  )
}
