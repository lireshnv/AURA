import { useCallback, useEffect, useState } from "react"
import { HeartPulse, TrendingUp, CalendarCheck, Activity, PhoneCall, AlertTriangle, Users } from "lucide-react"
import { fetchMyLinkedVictims } from "../lib/authApi"
import { fetchTwin, TwinResponse } from "../lib/auraApi"
import { fetchVictimCallHistory, IvrsCallSummary } from "../lib/ivrsApi"
import { fetchSosHistoryFor, SosEvent } from "../lib/sosApi"

function Card({ title, icon: Icon, children }: { title: string; icon: typeof HeartPulse; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-white border border-slate-200 p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 mb-3">
        <Icon size={15} className="text-violet-600" />
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

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>

  if (linkedVictims.length === 0) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Guardian Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">Authorised summary for a linked victim.</p>
        </div>
        <section className="rounded-xl bg-white border border-slate-200 p-8 text-center">
          <Users size={28} className="text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500">
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
        <h1 className="text-xl font-bold text-slate-900">Guardian Dashboard</h1>
        <p className="text-sm text-slate-500 mt-0.5">Authorised summary only - no transcripts or facial data.</p>
      </div>

      <section className="rounded-xl bg-violet-50 border border-violet-200 p-4 flex items-center gap-3">
        <Users size={18} className="text-violet-600 shrink-0" />
        <div>
          <p className="text-[11px] text-violet-600 uppercase tracking-wide">Linked victim</p>
          <p className="text-sm font-semibold text-violet-900">{victimAuraId}</p>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Current well-being signal" icon={HeartPulse}>
          {hasData && risk ? (
            <div className="flex items-center gap-4">
              <div className="text-3xl font-bold text-slate-800 tabular-nums">
                {Math.round(risk.score)}
                <span className="text-sm font-normal text-slate-400"> / 100</span>
              </div>
              <span
                className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${
                  risk.band === "RED"
                    ? "bg-rose-50 border-rose-200 text-rose-700"
                    : risk.band === "AMBER"
                    ? "bg-amber-50 border-amber-200 text-amber-700"
                    : "bg-emerald-50 border-emerald-200 text-emerald-700"
                }`}
              >
                {risk.band}
              </span>
            </div>
          ) : (
            <p className="text-sm text-slate-400">Analysis pending</p>
          )}
        </Card>

        <Card title="Distress trend" icon={TrendingUp}>
          {hasData && currentTwin ? (
            <p className="text-sm text-slate-700 capitalize">
              {currentTwin.trend.label} <span className="text-slate-400">({currentTwin.trend.direction})</span>
            </p>
          ) : (
            <p className="text-sm text-slate-400">Analysis pending</p>
          )}
        </Card>

        <Card title="Recent check-ins" icon={CalendarCheck}>
          {hasData && twin ? (
            <p className="text-sm text-slate-700">{twin.counts.checkins} recorded</p>
          ) : (
            <p className="text-sm text-slate-400">No data available</p>
          )}
        </Card>

        <Card title="Activity engagement" icon={Activity}>
          {hasData && currentTwin ? (
            <p className="text-sm text-slate-700">
              {currentTwin.engagement.checkins_last_7d} of {currentTwin.engagement.expected_last_7d} expected this
              week
            </p>
          ) : (
            <p className="text-sm text-slate-400">No data available</p>
          )}
        </Card>

        <Card title="Call history / status" icon={PhoneCall}>
          {calls.length === 0 ? (
            <p className="text-sm text-slate-400">No calls</p>
          ) : (
            <div className="space-y-1.5">
              {calls.slice(0, 5).map((c) => (
                <div key={c.id} className="flex items-center justify-between text-xs">
                  <span className="text-slate-600 capitalize">{c.reason_key.replace(/_/g, " ")}</span>
                  <span className="text-slate-400">{c.status}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="SOS status" icon={AlertTriangle}>
          {sosEvents.length === 0 ? (
            <p className="text-sm text-slate-400">No data available</p>
          ) : (
            <div className="space-y-1.5">
              {sosEvents.slice(0, 3).map((e) => (
                <p key={e.id} className="text-xs text-rose-700">
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
