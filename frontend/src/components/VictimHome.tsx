import { useEffect, useState } from "react"
import { TwinResponse, fetchTwin } from "../lib/auraApi"
import { TrendSeriesPoint, fetchTwinTrends } from "../lib/twinApi"

/**
 * Victim-facing home. Deliberately non-clinical:
 *
 *  - No score out of 100 is ever shown to the person themselves. They see a
 *    pattern description ("Stable", "Changing") rather than a risk number.
 *    The numeric score exists for the counsellor view only.
 *  - Language is supportive and never diagnostic.
 *  - Nothing here implies AURA knows how they feel.
 */

const PATTERN_STYLE: Record<string, string> = {
  Stable: "bg-secondary-container/20 border-secondary/20 text-on-secondary-container",
  Improving: "bg-secondary-container/20 border-secondary/20 text-on-secondary-container",
  "Changing - may be worth talking to someone": "bg-primary-container/10 border-primary/20 text-primary",
  "Still learning your usual pattern": "bg-surface-container-low border-outline-variant text-on-surface-variant",
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return "Good morning"
  if (h < 18) return "Good afternoon"
  return "Good evening"
}

function ActionTile({
  icon,
  iconBg,
  iconColor,
  title,
  body,
  onClick,
}: {
  icon: string
  iconBg: string
  iconColor: string
  title: string
  body: string
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="bg-surface-container-lowest rounded-2xl p-6 card-shadow border border-white/40 flex flex-col items-center justify-center text-center hover:-translate-y-1 transition-transform group"
    >
      <div className={`w-16 h-16 rounded-full ${iconBg} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
        <span className={`material-symbols-outlined text-3xl ${iconColor}`}>{icon}</span>
      </div>
      <h3 className="text-headline-md text-on-surface mb-2">{title}</h3>
      <p className="text-label-sm text-on-surface-variant">{body}</p>
    </button>
  )
}

function Sparkline({ series }: { series: TrendSeriesPoint[] }) {
  if (series.length < 2) {
    return <p className="text-label-sm text-on-surface-variant">Not enough information yet.</p>
  }
  const max = Math.max(...series.map((p) => p.value), 1)
  const last = series[series.length - 1]
  const first = series[0]
  const improving = last.value >= first.value
  return (
    <>
      <div className="flex items-end gap-1 w-full h-12">
        {series.slice(-6).map((p, i, arr) => {
          const isLast = i === arr.length - 1
          const heightPct = Math.max(15, (p.value / max) * 100)
          return (
            <div
              key={p.date}
              className={`w-1/6 rounded-t-sm ${isLast ? "bg-primary" : "bg-primary-container/40"}`}
              style={{ height: `${heightPct}%` }}
            />
          )
        })}
      </div>
      <p className="text-label-sm text-on-surface-variant mt-4">
        {improving ? "Steady improvement" : "Some recent change"}
      </p>
    </>
  )
}

export default function VictimHome({
  auraId,
  onOpenAnalysis,
  onOpenCheckin,
  onOpenCompanion,
  onOpenWellbeing,
  onOpenSupport,
}: {
  auraId: string
  onOpenAnalysis: () => void
  onOpenCheckin: () => void
  onOpenCompanion: () => void
  onOpenWellbeing: () => void
  onOpenSupport: () => void
}) {
  const [data, setData] = useState<TwinResponse | null>(null)
  const [wellbeingSeries, setWellbeingSeries] = useState<TrendSeriesPoint[]>([])

  useEffect(() => {
    let cancelled = false
    fetchTwin(auraId).then((d) => !cancelled && setData(d))
    fetchTwinTrends().then((t) => !cancelled && setWellbeingSeries(t?.series.self_report ?? []))
    return () => {
      cancelled = true
    }
  }, [auraId])

  const pattern = data?.pattern_label ?? "Still learning your usual pattern"
  const twin = data?.twin
  // Same underlying signal the counsellor/admin views call "escalation
  // risk", but never shown here as a score or a clinical label - just a
  // gentle, supportive nudge toward Support, matching this page's
  // deliberately non-clinical framing throughout.
  const showSupportNudge = twin?.escalation_risk.available && twin.escalation_risk.level === "high"

  return (
    <div className="flex flex-col items-center text-center gap-stack-lg -mt-stack-sm">
      {/* Hero */}
      <section className="w-full flex flex-col items-center relative pt-stack-sm">
        <div className="inline-flex items-center gap-2 bg-surface rounded-full px-4 py-2 mb-6 shadow-sm border border-white/50">
          <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          <span className="text-label-sm text-on-surface-variant">AURA is here</span>
        </div>
        <h1 className="text-display-lg-mobile md:text-display-lg text-on-surface mb-4">
          {greeting()}. You're not alone.
        </h1>
        <p className="text-body-lg text-on-surface-variant max-w-2xl mx-auto mb-8">
          Your personal space for reflection and care. Whenever you're ready — there's no rush, and
          you can skip anything.
        </p>

        <div className="relative w-full max-w-2xl aspect-[21/9] rounded-[2rem] overflow-hidden shadow-[0_10px_40px_rgba(124,58,237,0.12)] bg-gradient-to-br from-primary-container/20 via-surface-container-lowest to-secondary-container/10 border border-white/20 flex items-center justify-center">
          <div className="relative w-28 h-28">
            <div className="absolute inset-0 rounded-full bg-primary/30 blur-2xl animate-pulse" />
            <div className="absolute inset-2 rounded-full bg-gradient-to-br from-primary to-primary-fixed-dim shadow-lg animate-[breathe_4s_ease-in-out_infinite]" />
            <div className="absolute inset-[38%] rounded-full bg-white/90" />
          </div>
          <div className="absolute bottom-6 bg-surface/80 backdrop-blur-md px-6 py-3 rounded-full flex items-center gap-3 border border-white/30 shadow-sm">
            <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>
              spa
            </span>
            <span className="text-label-md text-on-surface">Actively pulsing for peace</span>
          </div>
        </div>
      </section>

      {/* Well-being pattern - never a percentage, never clinical. */}
      <section className={`w-full max-w-2xl rounded-2xl border p-5 text-left ${PATTERN_STYLE[pattern] ?? PATTERN_STYLE.Stable}`}>
        <div className="text-label-sm uppercase tracking-wide opacity-70">Recent Well-being Pattern</div>
        <div className="text-headline-md mt-0.5">{pattern}</div>
        {twin && (
          <p className="text-label-sm opacity-80 mt-1.5">
            Based on {twin.current.observations} recent check-in
            {twin.current.observations === 1 ? "" : "s"}. {data?.baseline_confidence_label}.
          </p>
        )}
        <p className="text-label-sm opacity-70 mt-2">
          This describes a pattern in what you've shared — not a judgement about you.
        </p>
      </section>

      {showSupportNudge && (
        <section className="w-full max-w-2xl rounded-2xl border border-primary/20 bg-primary-container/10 p-5 text-left flex items-center justify-between gap-4">
          <div>
            <p className="text-label-md font-semibold text-on-surface">Things have seemed a bit harder lately</p>
            <p className="text-label-sm text-on-surface-variant mt-1">
              That's okay - support is here whenever you want it, no pressure.
            </p>
          </div>
          <button
            onClick={onOpenSupport}
            className="shrink-0 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold"
          >
            Get support
          </button>
        </section>
      )}

      {/* Bento quick actions */}
      <section className="w-full grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <ActionTile
          icon="favorite"
          iconBg="bg-primary-container/10"
          iconColor="text-primary"
          title="Check-in"
          body="Log your current state"
          onClick={onOpenCheckin}
        />
        <ActionTile
          icon="psychiatry"
          iconBg="bg-secondary-container/20"
          iconColor="text-secondary"
          title="Daily Care"
          body="Your personalized routine"
          onClick={onOpenCompanion}
        />
        <ActionTile
          icon="forum"
          iconBg="bg-tertiary-container/10"
          iconColor="text-tertiary"
          title="Talk to AURA"
          body="Start a guided session"
          onClick={onOpenAnalysis}
        />
        <button
          onClick={onOpenWellbeing}
          className="bg-surface-container-lowest rounded-2xl p-6 card-shadow border border-white/40 flex flex-col justify-between hover:-translate-y-1 transition-transform text-left"
        >
          <div className="flex justify-between items-start mb-4">
            <h3 className="text-headline-md text-on-surface">Well-being</h3>
            <span className="material-symbols-outlined text-primary">trending_up</span>
          </div>
          <div className="flex-grow flex items-end">
            <Sparkline series={wellbeingSeries} />
          </div>
        </button>
      </section>

      <p className="text-label-sm text-on-surface-variant text-center">
        AURA provides supportive guidance and does not replace professional care.
      </p>

      <style>{`@keyframes breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }`}</style>
    </div>
  )
}
