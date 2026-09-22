import { useEffect, useState } from "react"
import { Wind, PhoneCall, BookOpen, AlertTriangle, MessageCircle, Users, Stethoscope, ChevronRight } from "lucide-react"
import { ACTIVITIES, ActivityModal } from "./DailyCare"
import { CareActivityType, setConsent, submitCareAction } from "../lib/twinApi"
import { fetchSupportPathways } from "../lib/auraApi"

const LEARN_TOPICS = [
  { title: "Understanding stress", body: "What stress is, how it shows up in the body, and why it isn't a weakness." },
  { title: "Anxiety, explained simply", body: "The difference between everyday worry and anxiety that needs support." },
  { title: "Emotional regulation", body: "Simple, practical ways to ride out a strong feeling without it taking over." },
  { title: "Sleep and wellbeing", body: "Why sleep and mood are so closely linked, and small changes that help." },
  { title: "Coping strategies", body: "A few grounded techniques people actually use day to day." },
]

const EMERGENCY_RESOURCES = [
  { label: "112 — Emergency services", detail: "If you are in immediate danger, contact 112 (police/fire/medical, nationwide)." },
  { label: "14416 — Tele-MANAS", detail: "India's national 24/7 mental health support and counselling helpline. Also 1-800-891-4416." },
  { label: "A person you trust", detail: "Someone who can physically be with you right now." },
  { label: "Your AURA counsellor", detail: "You can request human support from Insights at any time." },
]

interface Props {
  auraId: string
  onOpenCompanion: () => void
}

export default function Support({ auraId, onOpenCompanion }: Props) {
  const [showActivity, setShowActivity] = useState(false)
  const [pathways, setPathways] = useState<{ pathway: string; reason: string; urgency: string }[] | null>(null)

  useEffect(() => {
    if (!auraId) return
    fetchSupportPathways(auraId).then((r) => {
      if (r) setPathways(r.suggestions ?? [])
    })
  }, [auraId])

  const completeActivity = async (type: CareActivityType) => {
    await setConsent("companion_care", true)
    await submitCareAction("activity", type)
    setShowActivity(false)
  }

  return (
    <div className="flex flex-col gap-stack-lg max-w-4xl mx-auto">
      <header>
        <h1 className="text-headline-lg text-on-surface mb-1">Support</h1>
        <p className="text-body-lg text-on-surface-variant">Calm exercises, someone to talk to, and help when it matters.</p>
      </header>

      {/* Calm Now */}
      <section className="bg-surface-container-lowest rounded-[24px] shadow-ambient-md p-stack-md">
        <h2 className="text-headline-md text-on-surface mb-1 flex items-center gap-2">
          <Wind size={20} className="text-primary" /> Calm Now
        </h2>
        <p className="text-body-md text-on-surface-variant mb-4">
          A short exercise to help settle things down.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {ACTIVITIES.map((a) => (
            <button
              key={a.type}
              onClick={() => setShowActivity(true)}
              className="flex flex-col items-center gap-1.5 rounded-xl border border-outline-variant bg-surface-container-low hover:border-primary hover:bg-primary-container/10 p-3.5 text-center transition-colors"
            >
              <a.icon size={20} className="text-primary" />
              <span className="text-label-md font-medium text-on-surface">{a.label}</span>
              <span className="text-label-sm text-on-surface-variant">{a.description}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Talk */}
      <section className="bg-surface-container-lowest rounded-[24px] shadow-ambient-md p-stack-md">
        <h2 className="text-headline-md text-on-surface mb-1 flex items-center gap-2">
          <MessageCircle size={20} className="text-primary" /> Talk
        </h2>
        <p className="text-body-md text-on-surface-variant mb-4">Talk it through, on your terms.</p>
        <div className="flex flex-col divide-y divide-outline-variant">
          <button
            onClick={onOpenCompanion}
            className="flex items-center justify-between py-3.5 text-left hover:text-primary"
          >
            <span className="flex items-center gap-3 text-body-md text-on-surface font-medium">
              <MessageCircle size={17} className="text-on-surface-variant" /> Aura Companion
            </span>
            <ChevronRight size={16} className="text-on-surface-variant" />
          </button>
          <div className="flex items-center justify-between py-3.5">
            <span className="flex items-center gap-3 text-body-md text-on-surface font-medium">
              <Users size={17} className="text-on-surface-variant" /> Trusted contact
            </span>
            <span className="text-label-sm text-on-surface-variant">Use SOS to reach someone now</span>
          </div>
          <div className="flex items-center justify-between py-3.5">
            <span className="flex items-center gap-3 text-body-md text-on-surface font-medium">
              <Stethoscope size={17} className="text-on-surface-variant" /> Professional support
            </span>
            <span className="text-label-sm text-on-surface-variant">
              {pathways === null ? "Checking…" : pathways.length > 0 ? "Suggested for you" : "None suggested right now"}
            </span>
          </div>
        </div>
        {pathways && pathways.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {pathways.map((p, i) => (
              <div key={i} className="rounded-xl bg-primary-container/10 border border-primary/20 px-4 py-3">
                <p className="text-label-md font-semibold text-on-surface capitalize">{p.pathway.replace(/_/g, " ")}</p>
                <p className="text-label-sm text-on-surface-variant mt-0.5">{p.reason}</p>
                <p className="text-label-sm text-outline mt-1">A human reviews this before anything happens.</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Learn */}
      <section className="bg-surface-container-lowest rounded-[24px] shadow-ambient-md p-stack-md">
        <h2 className="text-headline-md text-on-surface mb-1 flex items-center gap-2">
          <BookOpen size={20} className="text-primary" /> Learn
        </h2>
        <p className="text-body-md text-on-surface-variant mb-4">A little context, in plain language.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {LEARN_TOPICS.map((t) => (
            <div key={t.title} className="rounded-xl border border-outline-variant bg-surface-container-low p-4">
              <p className="text-label-md font-semibold text-on-surface mb-1">{t.title}</p>
              <p className="text-label-sm text-on-surface-variant">{t.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Emergency */}
      <section className="bg-error-container/30 border border-error/30 rounded-[24px] p-stack-md">
        <h2 className="text-headline-md text-on-error-container mb-1 flex items-center gap-2">
          <AlertTriangle size={20} /> Emergency Support
        </h2>
        <p className="text-body-md text-on-error-container mb-4">
          If you're in immediate danger, use the SOS button in the bottom-right corner of the screen at any time —
          it works from every page.
        </p>
        <ul className="flex flex-col gap-1.5">
          {EMERGENCY_RESOURCES.map((r) => (
            <li key={r.label} className="text-label-sm text-on-error-container flex items-start gap-2">
              <PhoneCall size={14} className="mt-0.5 shrink-0" />
              <span><span className="font-semibold">{r.label}</span> — {r.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      {showActivity && (
        <ActivityModal onClose={() => setShowActivity(false)} onComplete={completeActivity} />
      )}
    </div>
  )
}
