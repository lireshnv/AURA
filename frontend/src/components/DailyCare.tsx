import { useEffect, useState } from "react"
import { Bone, Droplets, X, Wind, PenLine, Footprints, Leaf } from "lucide-react"
import { CareActivityType } from "../lib/twinApi"

export const ACTIVITIES: { type: CareActivityType; label: string; icon: typeof Wind; description: string }[] = [
  { type: "breathing", label: "Breathing", icon: Wind, description: "A short guided box-breathing exercise." },
  { type: "journaling", label: "Journaling", icon: PenLine, description: "A private moment to write - kept on this device only." },
  { type: "walking", label: "Walking", icon: Footprints, description: "Step away for a short walk." },
  { type: "relaxation", label: "Relaxation", icon: Leaf, description: "A few minutes to simply pause." },
]

/** Guided box-breathing: 4s inhale, 4s hold, 4s exhale, 4s hold, on repeat. */
function BreathingActivity({ onComplete }: { onComplete: () => void }) {
  const [phase, setPhase] = useState<"inhale" | "hold1" | "exhale" | "hold2">("inhale")
  const [cycles, setCycles] = useState(0)

  useEffect(() => {
    const order: typeof phase[] = ["inhale", "hold1", "exhale", "hold2"]
    const id = window.setInterval(() => {
      setPhase((p) => {
        const next = order[(order.indexOf(p) + 1) % order.length]
        if (next === "inhale") setCycles((c) => c + 1)
        return next
      })
    }, 4000)
    return () => window.clearInterval(id)
  }, [])

  const scale = phase === "inhale" ? 1.4 : phase === "exhale" ? 0.8 : phase.startsWith("hold") ? (phase === "hold1" ? 1.4 : 0.8) : 1
  const label = { inhale: "Breathe in…", hold1: "Hold…", exhale: "Breathe out…", hold2: "Hold…" }[phase]

  return (
    <div className="flex flex-col items-center gap-4 py-4">
      <div
        className="w-24 h-24 rounded-full bg-violet-200 border-2 border-violet-400"
        style={{ transform: `scale(${scale})`, transition: "transform 4s ease-in-out" }}
      />
      <p className="text-sm text-on-surface-variant">{label}</p>
      <p className="text-xs text-on-surface-variant">{cycles} cycle{cycles === 1 ? "" : "s"} completed</p>
      <button
        onClick={onComplete}
        disabled={cycles < 1}
        className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm disabled:opacity-40"
      >
        Finish
      </button>
    </div>
  )
}

export function ActivityModal({
  onClose,
  onComplete,
}: {
  onClose: () => void
  onComplete: (type: CareActivityType) => void
}) {
  const [selected, setSelected] = useState<CareActivityType | null>(null)
  const [note, setNote] = useState("")

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
      <div className="bg-surface-container-lowest rounded-2xl border border-outline-variant shadow-xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-on-surface">
            {selected ? ACTIVITIES.find((a) => a.type === selected)?.label : "Choose an activity"}
          </h3>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface-variant">
            <X size={16} />
          </button>
        </div>

        {!selected && (
          <div className="grid grid-cols-2 gap-2">
            {ACTIVITIES.map((a) => (
              <button
                key={a.type}
                onClick={() => setSelected(a.type)}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-outline-variant p-3 hover:bg-surface-container-low text-center"
              >
                <a.icon size={20} className="text-violet-600" />
                <span className="text-xs font-medium text-on-surface">{a.label}</span>
                <span className="text-[10px] text-on-surface-variant">{a.description}</span>
              </button>
            ))}
          </div>
        )}

        {selected === "breathing" && <BreathingActivity onComplete={() => onComplete("breathing")} />}

        {selected === "journaling" && (
          <div className="space-y-3 py-2">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={5}
              placeholder="Write whatever you'd like. This stays on your device only."
              className="w-full rounded-lg border border-outline-variant px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none"
            />
            <button
              onClick={() => onComplete("journaling")}
              disabled={!note.trim()}
              className="w-full px-4 py-2 rounded-lg bg-violet-600 text-white text-sm disabled:opacity-40"
            >
              Done
            </button>
          </div>
        )}

        {(selected === "walking" || selected === "relaxation") && (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <p className="text-sm text-on-surface-variant">
              {selected === "walking"
                ? "Take a short walk whenever you're ready."
                : "Take a few minutes to relax, at your own pace."}
            </p>
            <button
              onClick={() => onComplete(selected)}
              className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm"
            >
              Mark complete
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export type ReactionKind = "feed" | "water"

const REACTION_COPY: Record<ReactionKind, { title: string; detail: string; icon: typeof Bone; color: string }> = {
  feed: { title: "Yum!", detail: "Fed today - your companion is happy.", icon: Bone, color: "text-amber-600" },
  water: { title: "Refreshed!", detail: "Watered today - growing nicely.", icon: Droplets, color: "text-sky-600" },
}

/** Brief overlay that pops up over the companion after a real feed/water
 * action - a couple of rising particles plus a one-line confirmation, gone
 * on its own so it never blocks the next action. */
export function CareReactionPanel({ kind, onDone }: { kind: ReactionKind; onDone: () => void }) {
  const { title, detail, icon: Icon, color } = REACTION_COPY[kind]

  useEffect(() => {
    const id = window.setTimeout(onDone, 1800)
    return () => window.clearTimeout(id)
  }, [onDone])

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`absolute animate-care-float ${color}`}
          style={{
            animationDelay: `${i * 140}ms`,
            left: `calc(50% + ${(i - 1) * 26}px)`,
            bottom: "42%",
          }}
        >
          <Icon size={18} />
        </span>
      ))}
      <div className="animate-care-pop bg-surface-container-lowest/95 border border-outline-variant shadow-lg rounded-xl px-4 py-2.5 flex items-center gap-2.5">
        <Icon size={18} className={color} />
        <div className="text-left">
          <p className="text-xs font-semibold text-on-surface">{title}</p>
          <p className="text-[11px] text-on-surface-variant">{detail}</p>
        </div>
      </div>
    </div>
  )
}

/**
 * The pieces above (ACTIVITIES, ActivityModal, CareReactionPanel, ReactionKind)
 * back the ONE companion stage that now lives on the AI Companion page
 * (see AICompanion.tsx) - feed/water/check-in/activity actions and the live
 * conversation reactions all drive the same avatar there, so there is a
 * single companion in the app rather than a second one on this page.
 */
