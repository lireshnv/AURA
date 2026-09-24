import { useCallback, useEffect, useState } from "react"
import {
  HeartPulse,
  TrendingUp,
  TrendingDown,
  CalendarCheck,
  Activity,
  PhoneCall,
  AlertTriangle,
  Users,
  MessageSquareWarning,
  FolderLock,
  CalendarDays,
  Bell,
  ShieldCheck,
  Lock,
} from "lucide-react"
import { fetchMyLinkedVictims } from "../lib/authApi"
import { fetchTwin, TwinResponse, CaseUpdateRecord, fetchCaseUpdates } from "../lib/auraApi"
import { fetchVictimCallHistory, IvrsCallSummary } from "../lib/ivrsApi"
import { fetchSosHistoryFor, SosEvent } from "../lib/sosApi"
import { recordReview } from "../lib/riskApi"
import { CalendarEventRecord, fetchCalendarEvents } from "../lib/calendarApi"
import CaseHub from "./CaseHub"
import AuraCalendar from "./AuraCalendar"
import { SidebarGroup } from "./AppShell"

// Sidebar IA note: no "Messages" (no messaging system exists yet) and no
// separate "Documents" tab - case documents are already reachable from
// Case Hub's own Documents sub-tab, so a second entry point would just
// duplicate it.
const TABS = [
  { key: "home", label: "Home", icon: "home" },
  { key: "wellbeing", label: "Wellbeing", icon: "favorite" },
  { key: "updates", label: "Updates", icon: "notifications" },
  { key: "calendar", label: "Calendar", icon: "calendar_month" },
  { key: "support", label: "Support", icon: "volunteer_activism" },
  { key: "profile", label: "Profile & Permissions", icon: "account_circle" },
] as const
export type TabKey = (typeof TABS)[number]["key"]

// Sidebar - flat, same as the victim portal's own sidebar, since six items
// doesn't need section headers. Rendered by AppShell as this role's one
// and only sidebar (see App.tsx).
export const GUARDIAN_SIDEBAR: SidebarGroup[] = [{ items: TABS.map((t) => ({ key: t.key, label: t.label, icon: t.icon })) }]

// Same generic, non-fabricated crisis guidance used in SosButton.tsx.
const RESOURCE_REFERENCE = [
  { label: "112 — Emergency services", detail: "Immediate danger: contact 112 (police/fire/medical, nationwide)." },
  { label: "14416 — Tele-MANAS", detail: "India's national 24/7 mental health support and counselling helpline. Also 1-800-891-4416." },
]

function Card({
  title,
  icon: Icon,
  className = "",
  children,
}: {
  title: string
  icon: typeof HeartPulse
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={`rounded-xl bg-surface-container-lowest border border-outline-variant p-5 ${className}`}>
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
 * same non-sensitive summary shape a counsellor sees, scoped to whichever
 * linked victim is selected. Wellbeing/Updates/Calendar/Support all read
 * from the same shared backbone every other role reads from - Calendar and
 * Case Hub (embedded read-only under Wellbeing's "Case" link) are the real
 * shared components, not a separate guardian-only copy.
 */
export default function GuardianDashboard({
  tab,
  onTabChange: setTab,
}: {
  tab: TabKey
  onTabChange: (tab: TabKey) => void
}) {
  const [linkedVictims, setLinkedVictims] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [twin, setTwin] = useState<TwinResponse | null>(null)
  const [calls, setCalls] = useState<IvrsCallSummary[]>([])
  const [sosEvents, setSosEvents] = useState<SosEvent[]>([])
  const [updates, setUpdates] = useState<CaseUpdateRecord[] | null>(null)
  const [upcomingEvents, setUpcomingEvents] = useState<CalendarEventRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [requestingFollowUp, setRequestingFollowUp] = useState(false)
  const [followUpSent, setFollowUpSent] = useState(false)

  const load = useCallback(async () => {
    const victims = await fetchMyLinkedVictims()
    setLinkedVictims(victims)
    if (victims.length > 0) {
      setSelected((prev) => (prev && victims.includes(prev) ? prev : victims[0]))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!selected) return
    setTwin(null)
    setFollowUpSent(false)
    setUpdates(null)
    Promise.all([
      fetchTwin(selected),
      fetchVictimCallHistory(selected),
      fetchSosHistoryFor(selected),
      fetchCaseUpdates(selected),
      fetchCalendarEvents(selected, { start: new Date() }),
    ]).then(([t, c, s, u, ev]) => {
      setTwin(t)
      setCalls(c)
      setSosEvents(s)
      setUpdates(u?.updates ?? [])
      setUpcomingEvents(ev?.events ?? [])
    })
  }, [selected])

  const requestFollowUp = async () => {
    if (!selected) return
    setRequestingFollowUp(true)
    const res = await recordReview({
      aura_id: selected,
      action: "review_requested",
      actor_role: "guardian",
      reason: "Guardian flagged a concern from their dashboard.",
    })
    setRequestingFollowUp(false)
    if (res?.success) setFollowUpSent(true)
  }

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

  const hasData = !!twin?.has_data
  const risk = twin?.risk
  const currentTwin = twin?.twin
  const escalation = currentTwin?.escalation_risk
  const nextEvent = upcomingEvents[0]
  const latestUpdate = updates && updates.length > 0 ? updates[0] : null

  const wellbeingLine = hasData && risk
    ? risk.band === "RED"
      ? "Showing signs of real difficulty"
      : risk.band === "AMBER"
      ? "Some signs of difficulty - worth a check-in"
      : "Doing okay"
    : "Analysis pending"

  const victimPicker =
    linkedVictims.length > 1 ? (
      <div className="flex flex-wrap gap-2">
        {linkedVictims.map((id) => (
          <button
            key={id}
            onClick={() => setSelected(id)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium border ${
              selected === id
                ? "bg-primary text-on-primary border-primary"
                : "border-outline-variant text-on-surface-variant hover:bg-surface-container-low"
            }`}
          >
            {id}
          </button>
        ))}
      </div>
    ) : (
      <section className="rounded-xl bg-primary-container/10 border border-primary/20 p-4 flex items-center gap-3">
        <Users size={18} className="text-primary shrink-0" />
        <div>
          <p className="text-[11px] text-primary uppercase tracking-wide">Linked victim</p>
          <p className="text-sm font-semibold text-on-surface">{selected}</p>
        </div>
      </section>
    )

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-headline-md text-on-surface">Guardian Dashboard</h1>
        <p className="text-body-md text-on-surface-variant mt-0.5">Authorised summary only - no transcripts or facial data.</p>
      </div>

      {victimPicker}

      {tab === "home" && (
        <div className="flex flex-col gap-5">
          {escalation?.level === "high" && (
            <section className="rounded-xl bg-error-container/20 border border-error/30 p-4 flex items-start gap-3">
              <TrendingDown size={18} className="text-error shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-error">A concerning trend was noticed</p>
                <p className="text-xs text-on-surface-variant mt-0.5">{escalation.rationale}</p>
              </div>
            </section>
          )}

          {/* Asymmetric, deliberately calm - wellbeing gets the larger
              tile since it's the one thing a guardian checks most, the
              rest stack compactly beside it rather than three equal cards. */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <Card title="Current wellbeing" icon={HeartPulse} className="lg:col-span-7">
              <div className="flex items-center gap-3">
                <span
                  className={`w-3 h-3 rounded-full shrink-0 ${
                    !risk ? "bg-outline-variant" : risk.band === "RED" ? "bg-error" : risk.band === "AMBER" ? "bg-primary" : "bg-secondary"
                  }`}
                />
                <p className="text-sm font-medium text-on-surface">{wellbeingLine}</p>
              </div>
              {hasData && currentTwin && (
                <p className="text-xs text-on-surface-variant mt-2 capitalize">
                  {currentTwin.trend.label}
                  {currentTwin.trend.direction && currentTwin.trend.direction.toLowerCase() !== currentTwin.trend.label.toLowerCase() && (
                    <span className="text-on-surface-variant/70"> ({currentTwin.trend.direction})</span>
                  )}
                </p>
              )}
              <button onClick={() => setTab("wellbeing")} className="text-label-sm text-primary font-semibold mt-3 hover:underline">
                See details →
              </button>
            </Card>

            <div className="lg:col-span-5 flex flex-col gap-4">
              <Card title="Upcoming" icon={CalendarDays}>
                {nextEvent ? (
                  <>
                    <p className="text-sm font-medium text-on-surface">{nextEvent.title}</p>
                    <p className="text-xs text-on-surface-variant mt-0.5">
                      {new Date(nextEvent.starts_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-on-surface-variant">Nothing scheduled.</p>
                )}
                <button onClick={() => setTab("calendar")} className="text-label-sm text-primary font-semibold mt-2 hover:underline">
                  Open calendar →
                </button>
              </Card>

              <Card title="Recent update" icon={Bell}>
                {latestUpdate ? (
                  <>
                    <p className="text-sm font-medium text-on-surface">{latestUpdate.title}</p>
                    <p className="text-xs text-on-surface-variant mt-0.5">{new Date(latestUpdate.created_at).toLocaleDateString()}</p>
                  </>
                ) : (
                  <p className="text-sm text-on-surface-variant">No updates yet.</p>
                )}
                <button onClick={() => setTab("updates")} className="text-label-sm text-primary font-semibold mt-2 hover:underline">
                  See all updates →
                </button>
              </Card>
            </div>
          </div>

          <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-3">
              <MessageSquareWarning size={18} className="text-primary shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-on-surface">Concerned about something?</p>
                <p className="text-xs text-on-surface-variant mt-0.5">
                  Flags a follow-up review to the assigned counsellor. Recorded in the audit trail - not an
                  emergency line. For an emergency, use the SOS button.
                </p>
              </div>
            </div>
            {followUpSent ? (
              <span className="shrink-0 text-sm text-secondary font-medium">Sent</span>
            ) : (
              <button
                onClick={requestFollowUp}
                disabled={requestingFollowUp || !selected}
                className="shrink-0 px-4 py-2 rounded-full bg-primary text-on-primary text-sm font-semibold disabled:opacity-50"
              >
                {requestingFollowUp ? "Sending…" : "Request follow-up"}
              </button>
            )}
          </section>
        </div>
      )}

      {tab === "wellbeing" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card title="Current well-being signal" icon={HeartPulse}>
            <div className="flex items-center gap-3">
              <span
                className={`w-3 h-3 rounded-full shrink-0 ${
                  !risk ? "bg-outline-variant" : risk.band === "RED" ? "bg-error" : risk.band === "AMBER" ? "bg-primary" : "bg-secondary"
                }`}
              />
              <p className="text-sm font-medium text-on-surface">{wellbeingLine}</p>
            </div>
          </Card>

          <Card title="Distress trend" icon={TrendingUp}>
            {hasData && currentTwin ? (
              <p className="text-sm text-on-surface-variant capitalize">
                {currentTwin.trend.label}
                {currentTwin.trend.direction && currentTwin.trend.direction.toLowerCase() !== currentTwin.trend.label.toLowerCase() && (
                  <span className="text-on-surface-variant/70"> ({currentTwin.trend.direction})</span>
                )}
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
              <div>
                <div className="h-2.5 rounded-full bg-surface-container-low overflow-hidden">
                  <div
                    className="h-full bg-secondary rounded-full"
                    style={{
                      width: `${Math.min(
                        100,
                        currentTwin.engagement.expected_last_7d > 0
                          ? (currentTwin.engagement.checkins_last_7d / currentTwin.engagement.expected_last_7d) * 100
                          : 0
                      )}%`,
                    }}
                  />
                </div>
                <p className="text-sm text-on-surface-variant mt-2">Checking in as expected this week</p>
              </div>
            ) : (
              <p className="text-sm text-on-surface-variant">No data available</p>
            )}
          </Card>
        </div>
      )}

      {tab === "updates" && (
        <Card title="Case updates" icon={Bell}>
          {updates === null ? (
            <p className="text-sm text-on-surface-variant">Loading…</p>
          ) : updates.length === 0 ? (
            <p className="text-sm text-on-surface-variant">No updates recorded yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-outline-variant">
              {updates.map((u) => (
                <div key={u.id} className="py-3">
                  <p className="text-sm font-medium text-on-surface">{u.title}</p>
                  {u.body && <p className="text-xs text-on-surface-variant mt-0.5">{u.body}</p>}
                  <p className="text-xs text-on-surface-variant/70 mt-1">{new Date(u.created_at).toLocaleString()} · {u.author_role}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === "calendar" &&
        (selected ? (
          <AuraCalendar auraId={selected} readOnly />
        ) : (
          <Card title="No calendar" icon={CalendarDays}>
            <p className="text-sm text-on-surface-variant">Select a linked victim above.</p>
          </Card>
        ))}

      {tab === "support" && (
        <div className="flex flex-col gap-4">
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

          <Card title="Crisis resources" icon={ShieldCheck}>
            <div className="flex flex-col divide-y divide-outline-variant">
              {RESOURCE_REFERENCE.map((r) => (
                <div key={r.label} className="py-2">
                  <p className="text-sm font-semibold text-on-surface">{r.label}</p>
                  <p className="text-xs text-on-surface-variant">{r.detail}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-on-surface-variant/60 mt-3">
              Guardians aren't shown the assigned counsellor's direct contact details - that
              relationship stays between the victim and their counsellor. Use "Request follow-up"
              on Home to flag a concern for review instead.
            </p>
          </Card>

          {selected && (
            <details className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
              <summary className="cursor-pointer text-sm font-semibold text-on-surface flex items-center gap-2">
                <FolderLock size={15} className="text-primary" /> Full case record (read-only)
              </summary>
              <div className="mt-4">
                <CaseHub auraId={selected} showTrustedContacts={false} showCounsellorLookup={false} readOnly />
              </div>
            </details>
          )}
        </div>
      )}

      {tab === "profile" && (
        <div className="flex flex-col gap-4">
          <Card title="Linked victim" icon={Users}>
            {linkedVictims.length === 0 ? (
              <p className="text-sm text-on-surface-variant">No linked victim.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {linkedVictims.map((id) => (
                  <p key={id} className="text-sm text-on-surface font-medium">{id}</p>
                ))}
              </div>
            )}
            <p className="text-xs text-on-surface-variant/60 mt-2">
              This relationship is created and can only be revoked by an administrator.
            </p>
          </Card>

          <Card title="What you can see" icon={Lock}>
            <ul className="text-sm text-on-surface-variant space-y-1.5 list-disc list-inside">
              <li>Wellbeing summary and distress trend (a plain-language signal, not raw scores or transcripts)</li>
              <li>Case timeline updates</li>
              <li>The shared calendar (read-only)</li>
              <li>Call history status and SOS activity</li>
            </ul>
            <p className="text-label-sm font-semibold text-on-surface mt-4 mb-1.5">What you cannot see</p>
            <ul className="text-sm text-on-surface-variant space-y-1.5 list-disc list-inside">
              <li>Conversation transcripts or facial analysis</li>
              <li>The assigned counsellor's private contact details</li>
              <li>Anything outside this one linked case</li>
            </ul>
          </Card>
        </div>
      )}
    </div>
  )
}
