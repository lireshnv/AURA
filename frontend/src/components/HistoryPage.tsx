import { useEffect, useState } from "react"
import { TrendingUp, TrendingDown, Minus, Trash2, RefreshCw, Sparkles } from "lucide-react"
import { HistoryResponse, HistorySession } from "../types"
import { clearHistory, fetchHistory } from "../lib/api"
import { SessionDistressTrendChart } from "./ui/charts"

/** Same wording discipline as the spec: describe the observed signal and its
 * direction, never a diagnosis. Built entirely from the real session-to-
 * session trend already computed server-side (history_store.compute_trend) -
 * no invented confidence score. */
function insightText(trend: HistoryResponse["trend"] | undefined): string | null {
  if (!trend || trend.direction === "insufficient") return null
  if (trend.direction === "increasing") {
    return `Observed distress-related signals have increased across your last ${trend.sessions_compared} sessions.`
  }
  if (trend.direction === "decreasing") {
    return `Observed distress-related signals have eased across your last ${trend.sessions_compared} sessions.`
  }
  return `Observed distress-related signals have stayed steady across your last ${trend.sessions_compared} sessions.`
}

const LEVEL: Record<
  string,
  { dot: string; iconBg: string; iconColor: string; icon: string; badge: string; badgeText: string; label: string }
> = {
  GREEN: {
    dot: "bg-secondary",
    iconBg: "bg-secondary-container/10",
    iconColor: "text-secondary",
    icon: "self_improvement",
    badge: "bg-secondary-container/20 text-on-secondary-container",
    badgeText: "Stable",
    label: "Low distress signal",
  },
  AMBER: {
    dot: "bg-primary",
    iconBg: "bg-primary-container/10",
    iconColor: "text-primary",
    icon: "mood",
    badge: "bg-primary-container/10 text-primary",
    badgeText: "Elevated",
    label: "Elevated distress signal",
  },
  RED: {
    dot: "bg-error",
    iconBg: "bg-error-container/20",
    iconColor: "text-error",
    icon: "warning",
    badge: "bg-error/10 text-error",
    badgeText: "High",
    label: "High distress signal",
  },
}

/** Calendar-relative day label: Today / Yesterday / N days ago. */
function dayLabel(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return "Unknown date"

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const days = Math.round((startOfDay(new Date()).getTime() - startOfDay(then).getTime()) / 86_400_000)

  const time = then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  if (days <= 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  if (days < 7) return `${days} days ago, ${time}`
  return `${then.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`
}

function TrendBadge({ trend }: { trend: HistoryResponse["trend"] | undefined }) {
  if (!trend || trend.direction === "insufficient") {
    return (
      <span className="flex items-center gap-1.5 text-label-sm text-on-surface-variant">
        <Minus size={13} />
        {trend?.label ?? "Not enough sessions yet"}
      </span>
    )
  }
  const config = {
    increasing: { Icon: TrendingUp, cls: "text-primary", word: "Increasing" },
    decreasing: { Icon: TrendingDown, cls: "text-secondary", word: "Decreasing" },
    stable: { Icon: Minus, cls: "text-on-surface-variant", word: "Stable" },
  }[trend.direction] ?? { Icon: Minus, cls: "text-on-surface-variant", word: "Stable" }

  return (
    <span className={`flex items-center gap-1.5 text-label-md font-medium ${config.cls}`}>
      <config.Icon size={13} />
      {config.word}
      <span className="text-on-surface-variant font-normal">
        ({trend.delta > 0 ? "+" : ""}
        {trend.delta} across {trend.sessions_compared} sessions)
      </span>
    </span>
  )
}

function SessionCard({ session }: { session: HistorySession }) {
  const level = LEVEL[session.distress_level ?? "GREEN"] ?? LEVEL.GREEN
  const score = session.distress_score ?? 0
  const filledBars = score >= 66 ? 3 : score >= 33 ? 2 : score > 0 ? 1 : 0

  return (
    <div className="relative pl-24 mb-stack-sm group">
      <div
        className={`absolute left-6 top-6 w-5 h-5 rounded-full ${level.dot} ring-4 ring-surface shadow-sm z-10 transition-transform group-hover:scale-125 duration-300`}
      />
      <div className="bg-surface-container-lowest rounded-[24px] p-gutter card-shadow hover:shadow-[0_24px_48px_-12px_rgba(124,58,237,0.15)] transition-shadow duration-300 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border border-surface-container-low">
        <div className="flex items-center gap-gutter min-w-0">
          <div className={`w-16 h-16 rounded-full ${level.iconBg} ${level.iconColor} flex items-center justify-center shrink-0`}>
            <span className="material-symbols-outlined text-3xl">{level.icon}</span>
          </div>
          <div className="min-w-0">
            <div className="flex gap-2 items-center mb-1 flex-wrap">
              <span className="text-label-md text-on-surface-variant">{dayLabel(session.created_at)}</span>
              <span className={`px-2 py-1 rounded-full text-label-sm ${level.badge}`}>{level.badgeText}</span>
            </div>
            <h3 className="text-headline-md text-on-surface capitalize truncate">
              {session.observed_emotion ?? "Session"} recorded
              {session.emotion_confidence !== null && (
                <span className="text-on-surface-variant text-body-md font-normal">
                  {" "}
                  · {session.emotion_confidence.toFixed(0)}% confidence
                </span>
              )}
            </h3>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-body-md text-on-surface-variant mb-1">{level.label}</div>
          <div className="flex items-center gap-1 justify-end">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={`w-8 h-2 rounded-full ${
                  i < filledBars ? level.dot : "bg-surface-container-high"
                }`}
              />
            ))}
          </div>
          <div className="text-label-sm text-on-surface-variant mt-1 tabular-nums">
            {Math.floor(session.duration_seconds / 60)}:
            {String(Math.floor(session.duration_seconds % 60)).padStart(2, "0")}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function HistoryPage({
  compact = false,
  auraId,
  canClear = true,
}: {
  compact?: boolean
  /** Viewing a specific case's history as an authorized counsellor/admin/
   * guardian instead of the logged-in victim's own - same UI, just pointed
   * at someone else's (authorization-checked server-side). */
  auraId?: string
  /** Clearing history is a victim's own privacy control - never offered
   * when a staff role is looking at someone else's case. */
  canClear?: boolean
} = {}) {
  const [data, setData] = useState<HistoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmClear, setConfirmClear] = useState(false)

  const load = async () => {
    setLoading(true)
    setData(await fetchHistory(50, auraId))
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auraId])

  const handleClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    await clearHistory()
    setConfirmClear(false)
    load()
  }

  return (
    <div className="space-y-stack-md">
      <div className={`flex flex-col md:flex-row md:items-end gap-4 ${compact ? "justify-end" : "justify-between"}`}>
        {!compact && (
          <div className="max-w-2xl">
            <h1 className="text-display-lg-mobile text-on-surface mb-2">Session History</h1>
            <p className="text-body-lg text-on-surface-variant">
              Past sessions, stored as structured signals only — not a diagnostic record.
            </p>
          </div>
        )}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={load}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-outline-variant text-label-sm font-medium text-on-surface-variant hover:bg-surface-container-low"
          >
            <RefreshCw size={13} />
            Refresh
          </button>
          {canClear && data && data.sessions.length > 0 && (
            <button
              onClick={handleClear}
              onBlur={() => setConfirmClear(false)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-label-sm font-medium ${
                confirmClear
                  ? "border-error/40 bg-error-container text-on-error-container"
                  : "border-outline-variant text-on-surface-variant hover:bg-surface-container-low"
              }`}
            >
              <Trash2 size={13} />
              {confirmClear ? "Confirm clear all" : "Clear history"}
            </button>
          )}
        </div>
      </div>

      <section className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-gutter card-shadow flex items-center justify-between">
        <h2 className="text-headline-md text-on-surface">Overall trend</h2>
        <TrendBadge trend={data?.trend} />
      </section>

      {!loading && data && data.sessions.length >= 2 && (
        <section className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-gutter card-shadow">
          <h2 className="text-headline-md text-on-surface mb-1">Distress trend across sessions</h2>
          <p className="text-label-sm text-on-surface-variant/70 mb-2">
            Each point is one recorded session's distress score, oldest to newest.
          </p>
          <SessionDistressTrendChart sessions={data.sessions} />
          {insightText(data.trend) && (
            <div className="mt-3 pt-3 border-t border-outline-variant flex items-start gap-2">
              <Sparkles size={14} className="text-primary shrink-0 mt-0.5" />
              <p className="text-label-md text-on-surface">{insightText(data.trend)}</p>
            </div>
          )}
        </section>
      )}

      {loading ? (
        <p className="px-4 py-8 text-center text-body-md text-on-surface-variant">Loading history…</p>
      ) : !data || data.sessions.length === 0 ? (
        <div className="rounded-[24px] bg-surface-container-lowest border border-outline-variant px-4 py-12 text-center card-shadow">
          <span className="material-symbols-outlined text-4xl text-outline-variant mb-2 block">inbox</span>
          <p className="text-body-md font-medium text-on-surface">No sessions recorded yet</p>
          <p className="text-label-md text-on-surface-variant mt-1">
            Run an analysis and generate a report — the session will appear here.
          </p>
        </div>
      ) : (
        <div className="relative before:content-[''] before:absolute before:left-8 before:top-4 before:bottom-4 before:w-0.5 before:bg-surface-variant">
          {data.sessions.map((s) => (
            <SessionCard key={s.id} session={s} />
          ))}
        </div>
      )}
    </div>
  )
}
