/**
 * Shared Framer Motion presets for the Aura Cinematic design system. One
 * definition per motion pattern so Landing, Victim Home and later screens
 * animate consistently instead of each hand-rolling slightly different
 * easing/duration values.
 */
import { Transition, Variants } from "framer-motion"

export const EASE_OUT: Transition["ease"] = [0.16, 1, 0.3, 1]

export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE_OUT } },
}

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.5, ease: EASE_OUT } },
}

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.92 },
  show: { opacity: 1, scale: 1, transition: { duration: 0.55, ease: EASE_OUT } },
}

/** Wraps a group of children so they enter one after another. Apply `show`
 * on the parent (once, on mount or on scroll) and `fadeInUp`/`scaleIn` on
 * each child - the stagger timing lives only here. */
export const staggerContainer = (staggerMs = 0.08, delayMs = 0): Variants => ({
  hidden: {},
  show: {
    transition: { staggerChildren: staggerMs, delayChildren: delayMs },
  },
})

export const springPop: Transition = { type: "spring", stiffness: 260, damping: 22 }

/** Standard viewport trigger for scroll-revealed sections - fires once,
 * slightly before the element is fully on screen so it never feels late. */
export const revealOnScroll = { once: true, margin: "-80px" }
