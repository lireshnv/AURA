import { ReactNode } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { X } from "lucide-react"

/**
 * The shared "Aura Intelligence Panel" - a right-side slide-in used by the
 * Counsellor and Admin dashboards so clicking a case/alert/counsellor opens
 * detail in place instead of navigating away and losing the list's context.
 * Content is passed in by the caller; this component only owns the chrome,
 * the overlay and the slide transition.
 */
export default function RightPanel({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            aria-label="Close panel"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40 bg-black/30"
          />
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed top-0 right-0 bottom-0 z-50 w-full sm:w-[420px] bg-surface-container-lowest border-l border-outline-variant shadow-xl flex flex-col"
          >
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-outline-variant shrink-0">
              <div className="min-w-0">
                <p className="text-headline-md text-on-surface truncate">{title}</p>
                {subtitle && <p className="text-label-sm text-on-surface-variant mt-0.5">{subtitle}</p>}
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-low"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
