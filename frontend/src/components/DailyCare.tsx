import { useCallback, useEffect, useState } from "react"
import { Bone, Droplets, HeartHandshake, Sparkles, X, Wind, PenLine, Footprints, Leaf } from "lucide-react"
import {
  CareActivityType,
  CareSummary,
  fetchCareToday,
  setConsent,
  submitCareAction,
  submitCheckin,
} from "../lib/twinApi"
import AvatarModule from "./AvatarModule"
import { useAvatarIdentity } from "./AvatarModule/useAvatarIdentity"
import { AvatarAnimationState } from "./AvatarModule/types"

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
      <p className="text-sm text-slate-600">{label}</p>
      <p className="text-xs text-slate-400">{cycles} cycle{cycles === 1 ? "" : "s"} completed</p>
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
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-900">
            {selected ? ACTIVITIES.find((a) => a.type === selected)?.label : "Choose an activity"}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={16} />
          </button>
        </div>

        {!selected && (
          <div className="grid grid-cols-2 gap-2">
            {ACTIVITIES.map((a) => (
              <button
                key={a.type}
                onClick={() => setSelected(a.type)}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-slate-200 p-3 hover:bg-slate-50 text-center"
              >
                <a.icon size={20} className="text-violet-600" />
                <span className="text-xs font-medium text-slate-700">{a.label}</span>
                <span className="text-[10px] text-slate-400">{a.description}</span>
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
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none"
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
            <p className="text-sm text-slate-600">
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

type ReactionKind = "feed" | "water"

const REACTION_COPY: Record<ReactionKind, { title: string; detail: string; icon: typeof Bone; color: string }> = {
  feed: { title: "Yum!", detail: "Fed today - your companion is happy.", icon: Bone, color: "text-amber-600" },
  water: { title: "Refreshed!", detail: "Watered today - growing nicely.", icon: Droplets, color: "text-sky-600" },
}

/** Brief overlay that pops up over the companion after a real feed/water
 * action - a couple of rising particles plus a one-line confirmation, gone
 * on its own so it never blocks the next action. */
function CareReactionPanel({ kind, onDone }: { kind: ReactionKind; onDone: () => void }) {
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
      <div className="animate-care-pop bg-white/95 border border-slate-200 shadow-lg rounded-xl px-4 py-2.5 flex items-center gap-2.5">
        <Icon size={18} className={color} />
        <div className="text-left">
          <p className="text-xs font-semibold text-slate-900">{title}</p>
          <p className="text-[11px] text-slate-500">{detail}</p>
        </div>
      </div>
    </div>
  )
}

/**
 * Interactive Companion daily-care panel: Feed / Water / Check-in / Activity,
 * a real Today checklist, and the SAME shared avatar (see AvatarModule) shown
 * full-size with its type/expression/customization controls - this is now
 * the one place the companion lives, since AI Companion is chat-only.
 *
 * The companion is always a pet (dog/cat/robot/custom) or a plant, never a
 * generic human avatar: Feed + streak apply to a pet, Water applies to a
 * plant, matching what the model on screen actually is.
 */
export default function DailyCare() {
  const { avatarType } = useAvatarIdentity()
  const isPlant = avatarType === "plant"

  const [summary, setSummary] = useState<CareSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [showActivity, setShowActivity] = useState(false)
  const [checkinBusy, setCheckinBusy] = useState(false)
  const [reaction, setReaction] = useState<AvatarAnimationState>("idle")
  const [carePanel, setCarePanel] = useState<ReactionKind | null>(null)

  const load = useCallback(() => {
    fetchCareToday().then((s) => {
      setSummary(s)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const greet = () => {
    setReaction("greeting")
    window.setTimeout(() => setReaction("idle"), 2200)
  }

  const enableCare = async () => {
    await setConsent("companion_care", true)
    load()
  }

  const doAction = async (kind: "feed" | "water") => {
    if (!summary?.consent) {
      await enableCare()
    }
    const result = await submitCareAction(kind)
    if (result.success) {
      setSummary(result as CareSummary)
      greet()
      setCarePanel(kind)
    }
  }

  const doCheckin = async () => {
    setCheckinBusy(true)
    await setConsent("checkins", true)
    // A neutral single-value quick check-in - the full questionnaire lives in
    // My Wellbeing; this only records that a check-in happened today.
    await submitCheckin({ mood: 5 })
    await load()
    setCheckinBusy(false)
    greet()
  }

  const completeActivity = async (type: CareActivityType) => {
    if (!summary?.consent) await enableCare()
    const result = await submitCareAction("activity", type)
    if (result.success) setSummary(result as CareSummary)
    setShowActivity(false)
    greet()
  }

  if (loading) {
    return (
      <div className="rounded-xl bg-white border border-slate-200 p-5 text-center text-sm text-slate-400">
        Loading daily care…
      </div>
    )
  }

  const today = summary?.today ?? { feed: false, water: false, checkin: false, activity: false }

  return (
    <section className="rounded-xl bg-white border border-slate-200 p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Daily Care</h2>
        {!isPlant && summary && summary.care_streak_days > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
            <Sparkles size={11} />
            {summary.care_streak_days}-day streak
          </span>
        )}
      </div>

      {!summary?.consent && (
        <div className="rounded-lg bg-violet-50 border border-violet-200 px-3 py-2 text-xs text-violet-800 flex items-center justify-between gap-3">
          <span>Turn on Daily Care to have AURA reflect your real completed actions.</span>
          <button
            onClick={enableCare}
            className="shrink-0 px-2.5 py-1 rounded-lg bg-violet-600 text-white text-[11px]"
          >
            Enable
          </button>
        </div>
      )}

      <div className="relative rounded-2xl overflow-hidden">
        <AvatarModule drivenAnimation={reaction} />
        {carePanel && <CareReactionPanel kind={carePanel} onDone={() => setCarePanel(null)} />}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {isPlant ? (
          <button
            onClick={() => doAction("water")}
            className="flex flex-col items-center gap-1 rounded-xl border border-slate-200 py-2.5 hover:bg-slate-50"
          >
            <Droplets size={17} className="text-sky-600" />
            <span className="text-[11px] text-slate-600">Water</span>
          </button>
        ) : (
          <button
            onClick={() => doAction("feed")}
            className="flex flex-col items-center gap-1 rounded-xl border border-slate-200 py-2.5 hover:bg-slate-50"
          >
            <Bone size={17} className="text-amber-600" />
            <span className="text-[11px] text-slate-600">Feed</span>
          </button>
        )}
        <button
          onClick={doCheckin}
          disabled={checkinBusy}
          className="flex flex-col items-center gap-1 rounded-xl border border-slate-200 py-2.5 hover:bg-slate-50 disabled:opacity-50"
        >
          <HeartHandshake size={17} className="text-rose-600" />
          <span className="text-[11px] text-slate-600">Check-in</span>
        </button>
        <button
          onClick={() => setShowActivity(true)}
          className="flex flex-col items-center gap-1 rounded-xl border border-slate-200 py-2.5 hover:bg-slate-50"
        >
          <Sparkles size={17} className="text-violet-600" />
          <span className="text-[11px] text-slate-600">Activity</span>
        </button>
      </div>

      <div>
        <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2">Today</h3>
        <ul className="space-y-1.5">
          {(
            [
              isPlant ? (["water", "Water"] as const) : (["feed", "Feed"] as const),
              ["checkin", "Check-in"],
              ["activity", "Activity"],
            ] as const
          ).map(([key, label]) => (
            <li key={key} className="flex items-center gap-2 text-sm">
              <span
                className={`w-4 h-4 rounded-full border flex items-center justify-center text-[10px] ${
                  today[key] ? "bg-emerald-500 border-emerald-500 text-white" : "border-slate-300 text-transparent"
                }`}
              >
                ✓
              </span>
              <span className={today[key] ? "text-slate-700" : "text-slate-400"}>{label}</span>
            </li>
          ))}
        </ul>
      </div>

      {showActivity && (
        <ActivityModal onClose={() => setShowActivity(false)} onComplete={completeActivity} />
      )}
    </section>
  )
}
