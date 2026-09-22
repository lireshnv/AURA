import { useCallback, useEffect, useState } from "react"
import { HeartPulse, TrendingUp, CalendarCheck, Activity, PhoneCall, AlertTriangle, Users } from "lucide-react"
import { fetchMyLinkedVictims } from "../lib/authApi"
import { fetchTwin, TwinResponse } from "../lib/auraApi"
import { fetchVictimCallHistory, IvrsCallSummary } from "../lib/ivrsApi"
import { fetchSosHistoryFor, SosEvent } from "../lib/sosApi"

function Card({ title, icon: Icon, children }: { title: string; icon: typeof HeartPulse; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-on-surface mb-3">
        <Icon size={15} className="text-primary" />
        {title}
      </h2>
      {children}
    </section>
  )
}

/**
 * Guardian dashboard - shows ONLY what an admin-created GuardianVictimLink
 * actually authorises, enforced server-side on every fetch below (not just
 * hidden by this UI). No raw transcripts, facial data or private
 * conversations are ever requested here - every endpoint used returns the
 * same non-sensitive summary shape a counsellor sees, scoped to this
 * guardian's one linked victim.
 */
export default function GuardianDashboard() {
  const [linkedVictims, setLinkedVictims] = useState<string[]>([])
  const [twin, setTwin] = useState<TwinResponse | null>(null)
  const [calls, setCalls] = useState<IvrsCallSummary[]>([])
  const [sosEvents, setSosEvents] = useState<SosEvent[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const victims = await fetchMyLinkedVictims()
    setLinkedVictims(victims)
    if (victims.length > 0) {
      const [t, c, s] = await Promise.all([
        fetchTwin(victims[0]),
        fetchVictimCallHistory(victims[0]),
        fetchSosHistoryFor(victims[0]),
      ])
      setTwin(t)
      setCalls(c)
      setSosEvents(s)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (loading) return <p className="text-sm text-on-surface-variant">Loading…</p>

  if (linkedVictims.length === 0) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-headline-md text-on-surface">Guardian Dashboard</h1>
          <p className="text-body-md text-on-surface-variant mt-0.5">Authorised summary for a linked victim.</p>
        </div>
        <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-8 text-center">
          <Users size={28} className="text-on-surface-variant/50 mx-auto mb-2" />
          <p className="text-sm text-on-surface-variant">
            No linked victim yet. An administrator authorises this relationship.
          </p>
        </section>
      </div>
    )
  }

  const victimAuraId = linkedVictims[0]
  const hasData = !!twin?.has_data
  const risk = twin?.risk
  const currentTwin = twin?.twin

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-headline-md text-on-surface">Guardian Dashboard</h1>
        <p className="text-body-md text-on-surface-variant mt-0.5">Authorised summary only - no transcripts or facial data.</p>
      </div>

      <section className="rounded-xl bg-primary-container/10 border border-primary/20 p-4 flex items-center gap-3">
        <Users size={18} className="text-primary shrink-0" />
        <div>
          <p className="text-[11px] text-primary uppercase tracking-wide">Linked victim</p>
          <p className="text-sm font-semibold text-on-primary-container">{victimAuraId}</p>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Current well-being signal" icon={HeartPulse}>
          {hasData && risk ? (
            <div className="flex items-center gap-4">
              <div className="text-3xl font-bold text-on-surface tabular-nums">
                {Math.round(risk.score)}
                <span className="text-sm font-normal text-on-surface-variant"> / 100</span>
              </div>
              <span
                className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${
                  risk.band === "RED"
                    ? "bg-error-container/20 border-error/40 text-error"
                    : risk.band === "AMBER"
                    ? "bg-primary-container/10 border-primary/20 text-primary"
                    : "bg-secondary-container/20 border-secondary/20 text-on-secondary-container"
                }`}
              >
                {risk.band}
              </span>
            </div>
          ) : (
            <p className="text-sm text-on-surface-variant">Analysis pending</p>
          )}
        </Card>

        <Card title="Distress trend" icon={TrendingUp}>
          {hasData && currentTwin ? (
            <p className="text-sm text-on-surface-variant capitalize">
              {currentTwin.trend.label} <span className="text-on-surface-variant/70">({currentTwin.trend.direction})</span>
            </p>
          ) : (
            <p className="text-sm text-on-surface-variant">Analysis pending</p>
          )}
        </Card>

        <Card title="Recent check-ins" icon={CalendarCheck}>
          {hasData && twin ? (
            <p className="text-sm text-on-surface-variant">{twin.counts.checkins} recorded</p>
          ) : (
            <p className="text-sm text-on-surface-variant">No data available</p>
          )}
        </Card>

        <Card title="Activity engagement" icon={Activity}>
          {hasData && currentTwin ? (
            <p className="text-sm text-on-surface-variant">
              {currentTwin.engagement.checkins_last_7d} of {currentTwin.engagement.expected_last_7d} expected this
              week
            </p>
          ) : (
            <p className="text-sm text-on-surface-variant">No data available</p>
          )}
        </Card>

        <Card title="Call history / status" icon={PhoneCall}>
          {calls.length === 0 ? (
            <p className="text-sm text-on-surface-variant">No calls</p>
          ) : (
            <div className="space-y-1.5">
              {calls.slice(0, 5).map((c) => (
                <div key={c.id} className="flex items-center justify-between text-xs">
                  <span className="text-on-surface-variant capitalize">{c.reason_key.replace(/_/g, " ")}</span>
                  <span className="text-on-surface-variant/70">{c.status}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="SOS status" icon={AlertTriangle}>
          {sosEvents.length === 0 ? (
            <p className="text-sm text-on-surface-variant">No data available</p>
          ) : (
            <div className="space-y-1.5">
              {sosEvents.slice(0, 3).map((e) => (
                <p key={e.id} className="text-xs text-error">
                  SOS triggered {new Date(e.timestamp).toLocaleString()}
                </p>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
