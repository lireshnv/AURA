import { useEffect, useMemo, useState } from "react"
import { ArrowDown, ArrowUp, Download, Minus, UserCheck, Info, AlertTriangle, TrendingDown, ClipboardCheck, MessageCircle, ShieldAlert, HeartHandshake, FileUp, Sparkles } from "lucide-react"
import {
  CaseDocumentOverviewRecord,
  CaseQueue,
  CaseRow,
  CaseTypeOption,
  InterventionOverviewRecord,
  InterventionRecord,
  RiskBand,
  SupportSuggestion,
  TwinResponse,
  fetchCaseDocumentsOverview,
  fetchCaseQueue,
  fetchCaseType,
  fetchCaseTypes,
  fetchSupportHistory,
  fetchSupportHistoryOverview,
  fetchSupportPathways,
  fetchTwin,
  recordSupportDecision,
  setCaseType,
} from "../lib/auraApi"
import { fetchAuditLog, recordReview, AuditEntryRow } from "../lib/riskApi"
import { CalendarEventRecord, fetchOverviewCalendarEvents } from "../lib/calendarApi"
import { downloadCsv } from "../lib/csvExport"
import CaseDocuments from "./CaseDocuments"
import CaseHub from "./CaseHub"
import OverviewCalendar from "./OverviewCalendar"
import SessionsBoard from "./SessionsBoard"
import InterventionPipeline from "./InterventionPipeline"
import DocumentsOverview from "./DocumentsOverview"
import RightPanel from "./ui/RightPanel"
import { CaseLandscapeChart, CaseRiskBarChart, EngagementBarChart, RiskDistributionChart } from "./ui/charts"
import { SidebarGroup } from "./AppShell"
import CounsellorCallPanel from "./CounsellorCallPanel"
import HistoryProfilePage from "./HistoryProfilePage"
import { VoiceCapabilities } from "../types"

// Same generic, non-fabricated crisis guidance already used in SosButton.tsx
// and Support.tsx - no invented hotline numbers or service directory here.
const RESOURCE_REFERENCE = [
  { label: "112 — Emergency services", detail: "Immediate danger: contact 112 (police/fire/medical, nationwide)." },
  { label: "14416 — Tele-MANAS", detail: "India's national 24/7 mental health support and counselling helpline. Also 1-800-891-4416." },
]

// Sidebar IA note: "Victims" and "My Cases" would be near-duplicate lists
// with the data this app actually has (CaseRow has no separate person
// profile beyond the case itself), so there's one cases list, not two.
// "Messages" isn't included - no messaging system exists in this codebase
// yet, and this dashboard doesn't fabricate one.
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "cases", label: "My Cases" },
  { key: "casehub", label: "Case Hub" },
  { key: "analysis", label: "Wellbeing" },
  { key: "action", label: "Risk & Alerts" },
  { key: "care", label: "Care Plan" },
  { key: "sessions", label: "Sessions" },
  { key: "interventions", label: "Interventions" },
  { key: "followup", label: "Follow-up" },
  { key: "calendar", label: "Calendar" },
  { key: "documents", label: "Documents" },
  { key: "reports", label: "Reports" },
  { key: "resources", label: "Resources" },
  { key: "call", label: "AURA Call" },
  { key: "history", label: "History & Profile" },
] as const
export type TabKey = (typeof TABS)[number]["key"]

// Sidebar grouping of the same tabs above, rendered by AppShell itself as
// this role's one and only sidebar (see App.tsx) - not a second nested
// sidebar inside this page's own content.
export const COUNSELLOR_SIDEBAR: SidebarGroup[] = [
  { items: [{ key: "overview", label: "Overview", icon: "dashboard" }] },
  { heading: "Cases", items: [
    { key: "cases", label: "My Cases", icon: "folder_shared" },
    { key: "casehub", label: "Case Hub", icon: "topic" },
    { key: "followup", label: "Follow-up", icon: "event_repeat" },
  ] },
  { heading: "Wellbeing & Risk", items: [
    { key: "analysis", label: "Wellbeing", icon: "graphic_eq" },
    { key: "action", label: "Risk & Alerts", icon: "warning" },
    { key: "care", label: "Care Plan", icon: "volunteer_activism" },
  ] },
  { heading: "Scheduling", items: [
    { key: "sessions", label: "Sessions", icon: "event" },
    { key: "calendar", label: "Calendar", icon: "calendar_month" },
  ] },
  { heading: "Records", items: [
    { key: "interventions", label: "Interventions", icon: "support_agent" },
    { key: "documents", label: "Documents", icon: "description" },
  ] },
  { heading: "Reports & Resources", items: [
    { key: "reports", label: "Reports", icon: "bar_chart" },
    { key: "resources", label: "Resources", icon: "menu_book" },
  ] },
  { heading: "More", items: [
    { key: "call", label: "AURA Call", icon: "call" },
    { key: "history", label: "History & Profile", icon: "history" },
  ] },
]

/** Soonest upcoming (or most recent past) real CalendarEvent per case, keyed
 * by aura_id - replaces the earlier seededRandom placeholder due-dates in
 * Cases/Follow-up now that the shared calendar actually holds real events. */
function nextEventByCase(events: CalendarEventRecord[]): Map<string, CalendarEventRecord> {
  const now = Date.now()
  const map = new Map<string, CalendarEventRecord>()
  for (const e of events) {
    if (e.status === "cancelled") continue
    const existing = map.get(e.aura_id)
    if (!existing) {
      map.set(e.aura_id, e)
      continue
    }
    const eFuture = new Date(e.starts_at).getTime() >= now
    const exFuture = new Date(existing.starts_at).getTime() >= now
    if (eFuture && !exFuture) {
      map.set(e.aura_id, e) // any future event beats a past one
    } else if (eFuture === exFuture) {
      // Both future: keep the soonest. Both past: keep the most recent.
      const better = eFuture ? e.starts_at < existing.starts_at : e.starts_at > existing.starts_at
      if (better) map.set(e.aura_id, e)
    }
  }
  return map
}

const BAND_STYLE: Record<RiskBand, string> = {
  GREEN: "bg-secondary-container/20 text-on-secondary-container",
  AMBER: "bg-primary-container/10 text-primary",
  RED: "bg-error-container text-on-error-container",
}
const BAND_BORDER: Record<RiskBand, string> = {
  GREEN: "border-outline-variant",
  AMBER: "border-primary",
  RED: "border-error",
}
const DIRECTION_ICON = {
  up: <ArrowUp size={11} className="text-primary" />,
  down: <ArrowDown size={11} className="text-tertiary" />,
  neutral: <Minus size={11} className="text-on-surface-variant" />,
}

function StatTile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl bg-surface-container-lowest border border-outline-variant px-3 py-2.5 card-shadow">
      <div className="text-label-sm uppercase tracking-wide text-on-surface-variant">{label}</div>
      <div className={`text-headline-md tabular-nums ${tone ?? "text-on-surface"}`}>{value}</div>
    </div>
  )
}

function TrendChip({ trend }: { trend: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    worsening: { cls: "text-error", label: "Spike" },
    improving: { cls: "text-secondary", label: "Improving" },
    stable: { cls: "text-on-surface-variant", label: "Stable" },
    insufficient: { cls: "text-on-surface-variant/60", label: "Building" },
  }
  const c = map[trend] ?? map.insufficient
  return <span className={`text-label-md font-bold ${c.cls}`}>{c.label}</span>
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-surface-container-lowest rounded-[24px] border border-outline-variant p-gutter card-shadow ${className}`}>
      {children}
    </div>
  )
}

function DeviationChart({ twin }: { twin: TwinResponse["twin"] }) {
  const dims = Object.keys(twin.deviation.per_dimension)
  if (dims.length === 0) return <p className="text-label-md text-on-surface-variant">Baseline not yet established.</p>
  return (
    <div className="space-y-1.5">
      {dims.map((dim) => {
        const z = twin.deviation.per_dimension[dim]
        const pct = Math.min(50, Math.abs(z) * 20)
        const worse = z < 0
        return (
          <div key={dim} className="flex items-center gap-2 text-label-sm">
            <span className="w-28 text-on-surface-variant capitalize">{dim.replace("_", " ")}</span>
            <div className="flex-1 h-3 relative bg-surface-container-low rounded">
              <div className="absolute inset-y-0 left-1/2 w-px bg-outline-variant" />
              <div
                className={`absolute inset-y-0.5 rounded ${worse ? "bg-primary" : "bg-secondary"}`}
                style={worse ? { right: "50%", width: `${pct}%` } : { left: "50%", width: `${pct}%` }}
              />
            </div>
            <span className={`w-12 text-right tabular-nums ${worse ? "text-primary" : "text-secondary"}`}>
              {z > 0 ? "+" : ""}
              {z.toFixed(1)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
function OverviewTab({
  queue,
  audit,
  nextEvents,
  onInspect,
}: {
  queue: CaseQueue | null
  audit: AuditEntryRow[]
  nextEvents: Map<string, CalendarEventRecord>
  onInspect: (auraId: string) => void
}) {
  if (!queue || !queue.success) {
    return <Card><p className="text-body-md text-on-surface-variant">{queue?.error ?? "Loading…"}</p></Card>
  }
  const attention = queue.cases
    .filter((c) => c.risk_band !== "GREEN" || c.human_review_required)
    .sort((a, b) => b.priority - a.priority)
  const now = new Date()
  const todayEvents = Array.from(nextEvents.values())
    .filter((e) => new Date(e.starts_at).toDateString() === now.toDateString())
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
  const upcomingEvents = Array.from(nextEvents.entries())
    .filter(([, e]) => new Date(e.starts_at) > now && new Date(e.starts_at).toDateString() !== now.toDateString())
    .sort((a, b) => new Date(a[1].starts_at).getTime() - new Date(b[1].starts_at).getTime())
    .slice(0, 3)

  // AURA Insight: the single most escalation-worthy case right now, using
  // fields already computed server-side (escalation_risk/rationale) - no
  // invented confidence score, just a pointer to what to look at first.
  const insightCase = [...queue.cases]
    .filter((c) => c.escalation_risk === "high" || c.escalation_risk === "elevated")
    .sort((a, b) => (a.escalation_risk === b.escalation_risk ? b.risk_score - a.risk_score : a.escalation_risk === "high" ? -1 : 1))[0]

  return (
    <div className="flex flex-col gap-stack-md">
      {/* Compact operational strip: one hero number + dense stat chips in a
          single row, not eight equal-weight cards. */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="sm:w-64 shrink-0 rounded-[24px] bg-gradient-to-br from-error-container/25 to-transparent border border-error/20 px-5 py-4 flex flex-col justify-center">
          <span className="text-label-sm uppercase tracking-wide text-error font-semibold">Needs attention</span>
          <span className="text-display-lg text-error tabular-nums leading-none mt-1">{attention.length}</span>
          <span className="text-label-sm text-on-surface-variant mt-1">of {queue.summary.total} assigned cases</span>
        </div>
        <div className="flex-1 flex flex-wrap gap-2 items-center rounded-[24px] bg-surface-container-lowest border border-outline-variant px-4 py-3">
          {[
            ["Green", queue.summary.green, "text-secondary"],
            ["Amber", queue.summary.amber, "text-primary"],
            ["Red", queue.summary.red, "text-error"],
            ["Today", todayEvents.length, "text-on-surface"],
            ["Pending review", queue.summary.pending_review, "text-on-surface"],
            ["Follow-up", queue.summary.needs_followup, "text-on-surface"],
            ["Improving", queue.summary.improving, "text-secondary"],
          ].map(([label, value, tone]) => (
            <div key={label as string} className="flex items-baseline gap-1.5 px-3 py-1 rounded-full bg-surface-container">
              <span className={`text-label-lg font-bold tabular-nums ${tone}`}>{value}</span>
              <span className="text-label-sm text-on-surface-variant">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Main intelligence area (7) + attention list (5). */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter">
        <Card className="lg:col-span-7">
          <h3 className="text-label-md font-semibold text-on-surface mb-1">Case landscape</h3>
          <p className="text-label-sm text-on-surface-variant/70 mb-2">
            Wellbeing vs engagement · bubble size = recorded activity · click to open
          </p>
          <CaseLandscapeChart cases={queue.cases} onSelect={onInspect} />
        </Card>
        <Card className="lg:col-span-5 flex flex-col">
          <h3 className="text-label-md font-semibold text-on-surface mb-1">What needs my attention?</h3>
          <p className="text-label-sm text-on-surface-variant/70 mb-2">Highest priority first.</p>
          {attention.length === 0 ? (
            <p className="text-body-md text-on-surface-variant py-4">Nothing needs attention right now.</p>
          ) : (
            <div className="space-y-2 flex-1 overflow-y-auto max-h-[300px] pr-0.5">
              {attention.map((c) => (
                <button
                  key={c.aura_id}
                  onClick={() => onInspect(c.aura_id)}
                  className={`w-full flex items-center justify-between gap-3 rounded-xl border-l-4 ${BAND_BORDER[c.risk_band]} bg-surface-container px-3 py-2.5 text-left hover:bg-surface-container-low transition-colors`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-label-md font-semibold text-on-surface">{c.aura_id}</span>
                      <span className={`text-label-sm px-2 py-0.5 rounded-full ${BAND_STYLE[c.risk_band]}`}>{c.risk_band}</span>
                    </div>
                    <p className="text-label-sm text-on-surface-variant truncate">{c.routing}</p>
                  </div>
                  <TrendChip trend={c.trend} />
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Risk by case (7) + Today/Upcoming (5). */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter">
        <Card className="lg:col-span-7">
          <h3 className="text-label-md font-semibold text-on-surface mb-1">Risk by case</h3>
          <p className="text-label-sm text-on-surface-variant/70 mb-2">Click a bar to open that case</p>
          <CaseRiskBarChart cases={queue.cases} onSelect={onInspect} />
        </Card>
        <Card className="lg:col-span-5">
          <h3 className="text-label-md font-semibold text-on-surface mb-2">Today</h3>
          {todayEvents.length === 0 ? (
            <p className="text-label-sm text-on-surface-variant/60 py-2">Nothing scheduled today.</p>
          ) : (
            <div className="space-y-1.5 mb-3">
              {todayEvents.map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-label-sm border-b border-outline-variant/40 pb-1.5">
                  <span className="tabular-nums text-on-surface font-semibold w-12 shrink-0">
                    {new Date(e.starts_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="text-on-surface-variant truncate">{e.event_type.replace(/_/g, " ")}</span>
                  <span className="text-on-surface-variant/60 ml-auto shrink-0">{e.aura_id}</span>
                </div>
              ))}
            </div>
          )}
          {upcomingEvents.length > 0 && (
            <>
              <h4 className="text-label-sm font-semibold text-on-surface-variant uppercase tracking-wide mt-1 mb-1.5">Upcoming</h4>
              <div className="space-y-1">
                {upcomingEvents.map(([auraId, e]) => (
                  <div key={e.id} className="flex items-center gap-2 text-label-sm">
                    <span className="text-on-surface-variant/70 tabular-nums shrink-0">
                      {new Date(e.starts_at).toLocaleDateString([], { month: "short", day: "numeric" })}
                    </span>
                    <span className="text-on-surface truncate">{e.event_type.replace(/_/g, " ")}</span>
                    <span className="text-on-surface-variant/60 ml-auto shrink-0">{auraId}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* Case distribution (5) + AURA Insight (7). */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter">
        <Card className="lg:col-span-5">
          <h3 className="text-label-md font-semibold text-on-surface mb-1">Case distribution</h3>
          <p className="text-label-sm text-on-surface-variant/70 mb-2">By current risk band</p>
          <RiskDistributionChart green={queue.summary.green} amber={queue.summary.amber} red={queue.summary.red} />
        </Card>
        <Card className="lg:col-span-7">
          <h3 className="text-label-md font-semibold text-on-surface flex items-center gap-1.5 mb-1">
            <Sparkles size={14} className="text-primary" />
            AURA Insight
          </h3>
          {!insightCase ? (
            <p className="text-label-sm text-on-surface-variant/70 py-3">No notable change detected across your caseload right now.</p>
          ) : (
            <div className="text-label-sm space-y-2 mt-2">
              <p className="text-on-surface">
                <span className="font-semibold">{insightCase.aura_id}</span> shows a change worth reviewing.
              </p>
              <div>
                <span className="text-on-surface-variant/70 uppercase tracking-wide text-[10px] font-semibold">Observed</span>
                <p className="text-on-surface">{insightCase.escalation_rationale || "Escalation risk elevated based on recent signals."}</p>
              </div>
              <div>
                <span className="text-on-surface-variant/70 uppercase tracking-wide text-[10px] font-semibold">Suggested review</span>
                <p className="text-on-surface">Open the case in Risk &amp; Alerts to confirm and decide next steps.</p>
              </div>
              <button
                onClick={() => onInspect(insightCase.aura_id)}
                className="mt-1 text-label-sm text-primary font-semibold hover:underline"
              >
                Open case →
              </button>
            </div>
          )}
        </Card>
      </div>

      <Card>
        <h3 className="text-label-md font-semibold text-on-surface mb-1">Engagement</h3>
        <p className="text-label-sm text-on-surface-variant/70 mb-2">Check-ins in the last 7 days, lowest first</p>
        <EngagementBarChart cases={queue.cases} />
      </Card>

      <Card>
        <h3 className="text-headline-md text-on-surface mb-3">Recent activity</h3>
        {audit.length === 0 ? (
          <p className="text-body-md text-on-surface-variant/60 py-2">No recorded actions yet.</p>
        ) : (
          <div className="space-y-1">
            {audit.slice(0, 8).map((a) => {
              const Icon = a.action.includes("review")
                ? ClipboardCheck
                : a.action.includes("escalat")
                ? ShieldAlert
                : a.action.includes("support") || a.action.includes("intervention")
                ? HeartHandshake
                : a.action.includes("document")
                ? FileUp
                : MessageCircle
              return (
                <div key={a.id} className="flex items-center gap-2.5 text-label-sm border-b border-outline-variant/40 py-1.5 last:border-0">
                  <Icon size={13} className="text-on-surface-variant/70 shrink-0" />
                  <span className="text-on-surface capitalize">{a.action.replace(/_/g, " ")}</span>
                  <span className="text-on-surface-variant">{a.aura_id}</span>
                  <span className="text-on-surface-variant/60 ml-auto shrink-0">{new Date(a.timestamp).toLocaleString()}</span>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------
/** Renders a real CalendarEvent's date, or "None scheduled" - never a
 * placeholder. `overdue` styling only applies to a genuinely past event. */
function NextEventCell({ event }: { event: CalendarEventRecord | undefined }) {
  if (!event) return <span className="text-on-surface-variant/60">None scheduled</span>
  const days = Math.round((new Date(event.starts_at).getTime() - Date.now()) / 86400000)
  const overdue = days < 0
  return (
    <span className={overdue ? "text-error" : "text-on-surface-variant"} title={event.title}>
      {overdue ? `Overdue ${Math.abs(days)}d` : days === 0 ? "Today" : `In ${days}d`}
    </span>
  )
}

function CasesTab({
  queue,
  nextEvents,
  onOpenCase,
}: {
  queue: CaseQueue | null
  nextEvents: Map<string, CalendarEventRecord>
  onOpenCase: (id: string, tab: TabKey) => void
}) {
  if (!queue) return <Card><p className="text-body-md text-on-surface-variant">Loading cases…</p></Card>
  if (!queue.success) return <Card><p className="text-body-md text-error">{queue.error}</p></Card>
  if (queue.cases.length === 0) return <Card><p className="text-body-md text-on-surface-variant/60">{queue.message ?? "No data available"}</p></Card>

  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-label-md">
        <thead>
          <tr className="text-label-sm uppercase tracking-wide text-on-surface-variant text-left border-b border-outline-variant">
            <th className="py-2 pr-3">AURA ID</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Risk</th>
            <th className="py-2 pr-3">Trend</th>
            <th className="py-2 pr-3">Last contact</th>
            <th className="py-2 pr-3">Next event</th>
            <th className="py-2 pr-3"></th>
          </tr>
        </thead>
        <tbody>
          {queue.cases.map((c) => (
            <tr key={c.aura_id} className="border-b border-outline-variant/40 hover:bg-surface-container-low">
              <td className="py-2 pr-3 font-semibold text-on-surface">{c.aura_id}</td>
              <td className="py-2 pr-3">
                <span className={`text-label-sm px-2 py-0.5 rounded-full ${BAND_STYLE[c.risk_band]}`}>
                  {c.human_review_required ? "Review required" : "Monitoring"}
                </span>
              </td>
              <td className="py-2 pr-3 tabular-nums">{c.risk_score.toFixed(0)} ({c.risk_band})</td>
              <td className="py-2 pr-3"><TrendChip trend={c.trend} /></td>
              <td className="py-2 pr-3 text-on-surface-variant">
                {c.days_since_checkin === null ? "—" : `${c.days_since_checkin.toFixed(0)}d ago`}
              </td>
              <td className="py-2 pr-3"><NextEventCell event={nextEvents.get(c.aura_id)} /></td>
              <td className="py-2 pr-3 flex gap-3">
                <button
                  onClick={() => onOpenCase(c.aura_id, "casehub")}
                  className="text-label-sm text-primary font-semibold hover:underline"
                >
                  Case Hub →
                </button>
                <button
                  onClick={() => onOpenCase(c.aura_id, "analysis")}
                  className="text-label-sm text-on-surface-variant font-semibold hover:underline"
                >
                  Analysis →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Case picker used by Analysis / Action Required / Care Plan / Follow-up / Reports
// ---------------------------------------------------------------------------
function CasePicker({
  queue,
  selected,
  onSelect,
}: {
  queue: CaseQueue | null
  selected: string | null
  onSelect: (id: string) => void
}) {
  if (!queue?.success || queue.cases.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2">
      {queue.cases.map((c) => (
        <button
          key={c.aura_id}
          onClick={() => onSelect(c.aura_id)}
          title={c.escalation_risk === "high" ? c.escalation_rationale : undefined}
          className={`px-3 py-1.5 rounded-full text-label-sm font-medium border flex items-center gap-1.5 ${
            selected === c.aura_id
              ? "bg-primary text-on-primary border-primary"
              : `border-outline-variant text-on-surface-variant hover:bg-surface-container-low ${BAND_STYLE[c.risk_band]}`
          }`}
        >
          {c.aura_id}
          {c.escalation_risk === "high" && (
            <span className={selected === c.aura_id ? "text-on-primary" : "text-error"} title="Predicted to escalate">
              <TrendingDown size={12} />
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Analysis (on-demand, fetched once per selection — not live/continuously polled)
// ---------------------------------------------------------------------------
function AnalysisTab({ queue, selected, onSelect }: { queue: CaseQueue | null; selected: string | null; onSelect: (id: string) => void }) {
  const [data, setData] = useState<TwinResponse | null>(null)

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setData(null)
    fetchTwin(selected).then((d) => !cancelled && setData(d))
    return () => {
      cancelled = true
    }
  }, [selected])

  return (
    <div className="flex flex-col gap-stack-md">
      <CasePicker queue={queue} selected={selected} onSelect={onSelect} />
      {!selected ? (
        <Card><p className="text-body-md text-on-surface-variant">Select a case above to view its analysis.</p></Card>
      ) : !data ? (
        <Card><p className="text-body-md text-on-surface-variant">Loading…</p></Card>
      ) : !data.success || !data.has_data ? (
        <Card><p className="text-body-md text-on-surface-variant">{data.message ?? data.error ?? "No data available"}</p></Card>
      ) : (
        <Card>
          <div className="flex items-center justify-between gap-4 border-b border-outline-variant pb-3 mb-3">
            <div>
              <h2 className="text-headline-lg text-on-surface">{data.aura_id}</h2>
              <p className="text-body-md text-on-surface-variant">
                {data.counts.checkins} check-in(s) · {data.counts.sessions} session(s)
              </p>
            </div>
            <div className="text-right">
              <div className="text-display-lg-mobile text-on-surface tabular-nums">{data.risk.score.toFixed(0)}</div>
              <div className="text-label-sm text-on-surface-variant">confidence {data.risk.confidence.toFixed(0)}%</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-gutter">
            <div className="bg-surface-container rounded-xl p-4">
              <h4 className="text-label-md text-on-surface-variant mb-2">Well-being Digital Twin</h4>
              <DeviationChart twin={data.twin} />
            </div>
            <div className="bg-surface-container rounded-xl p-4">
              <h4 className="text-label-md text-on-surface-variant mb-2">Why this risk level? (evidence)</h4>
              <div className="space-y-1.5">
                {data.risk.contributing_factors.map((f, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-label-sm">
                    <span className="mt-0.5">{DIRECTION_ICON[f.direction]}</span>
                    <span className="text-on-surface">{f.factor}</span>
                    <span className="text-on-surface-variant">— {f.detail}</span>
                  </div>
                ))}
              </div>
              <div className="rounded-lg bg-surface-container-low border border-outline-variant px-3 py-2 mt-3">
                <div className="flex items-center gap-1.5 text-label-sm uppercase tracking-wide text-on-surface-variant mb-1">
                  <Info size={10} /> Limitations
                </div>
                {data.risk.limitations.map((l, i) => (
                  <p key={i} className="text-label-sm text-on-surface-variant/70">· {l}</p>
                ))}
              </div>
            </div>
          </div>
          <p className="text-label-sm text-on-surface-variant/60 mt-3">
            Snapshot as of {new Date(data.risk.assessed_at).toLocaleString()}. This is analysis, not a decision — AURA does not act on its own.
          </p>
        </Card>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Case-type classification (POA Act priority use cases) - drives which
// interventions support_pathways() recommends below it.
// ---------------------------------------------------------------------------
function CaseTypeSelector({ auraId, onChanged }: { auraId: string; onChanged: () => void }) {
  const [options, setOptions] = useState<CaseTypeOption[] | null>(null)
  const [value, setValue] = useState<string>("")
  const [district, setDistrict] = useState("")
  const [state, setState] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchCaseTypes().then((d) => setOptions(d?.case_types ?? []))
  }, [])

  useEffect(() => {
    setValue("")
    setDistrict("")
    setState("")
    fetchCaseType(auraId).then((d) => {
      setValue(d?.case_type ?? "")
      setDistrict(d?.district ?? "")
      setState(d?.state ?? "")
    })
  }, [auraId])

  const save = async (next: { type?: string; district?: string; state?: string }) => {
    const type = next.type ?? value
    const d = next.district ?? district
    const s = next.state ?? state
    if (next.type !== undefined) setValue(next.type)
    if (next.district !== undefined) setDistrict(next.district)
    if (next.state !== undefined) setState(next.state)
    if (!type) return
    setSaving(true)
    await setCaseType(auraId, type, { district: d || undefined, state: s || undefined })
    setSaving(false)
    onChanged()
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="text-label-sm text-on-surface-variant shrink-0 w-28">POA Act case type</span>
        <select
          value={value}
          onChange={(e) => save({ type: e.target.value })}
          disabled={!options || saving}
          className="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1 text-label-md text-on-surface disabled:opacity-50"
        >
          <option value="">Not classified yet</option>
          {(options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2.5">
        <span className="text-label-sm text-on-surface-variant shrink-0 w-28">District / State</span>
        <input
          value={district}
          onChange={(e) => setDistrict(e.target.value)}
          onBlur={() => save({})}
          placeholder="District"
          className="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1 text-label-md text-on-surface"
        />
        <input
          value={state}
          onChange={(e) => setState(e.target.value)}
          onBlur={() => save({})}
          placeholder="State"
          className="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1 text-label-md text-on-surface"
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Action Required — Accept / Modify / Dismiss / Escalate
// ---------------------------------------------------------------------------
type DecisionState = { status: "approved" | "rejected" | "escalated"; note?: string }

function ActionRequiredTab({
  queue,
  selected,
  onSelect,
  decisions,
  setDecisions,
  onDecided,
}: {
  queue: CaseQueue | null
  selected: string | null
  onSelect: (id: string) => void
  decisions: Record<string, DecisionState>
  setDecisions: (fn: (p: Record<string, DecisionState>) => Record<string, DecisionState>) => void
  onDecided?: () => void
}) {
  const [pathways, setPathways] = useState<SupportSuggestion[] | null>(null)
  const [modifyOpen, setModifyOpen] = useState<string | null>(null)
  const [modifyText, setModifyText] = useState("")
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!selected) return
    setPathways(null)
    fetchSupportPathways(selected).then((d) => setPathways(d?.suggestions ?? []))
  }, [selected, refreshKey])

  const key = (pathway: string) => `${selected}::${pathway}`

  const act = async (pathway: string, action: "approved" | "rejected" | "escalated", note?: string) => {
    if (!selected) return
    if (action === "escalated") {
      // Both: the audit-log trail other views (Follow-up) already read from,
      // and a persisted Intervention row so Care Plan's real history shows
      // it too instead of only living in this component's local state.
      await recordReview({ aura_id: selected, action: "follow_up_requested", actor_role: "counsellor", reason: note ?? `Escalated: ${pathway}` })
    }
    await recordSupportDecision({
      aura_id: selected,
      pathway,
      decision: action,
      decided_by: "counsellor",
      rationale: note ?? "Reviewed signals and case context.",
    })
    setDecisions((p) => ({ ...p, [key(pathway)]: { status: action, note } }))
    setModifyOpen(null)
    setModifyText("")
    onDecided?.()
  }

  return (
    <div className="flex flex-col gap-stack-md">
      <CasePicker queue={queue} selected={selected} onSelect={onSelect} />
      {selected && <CaseTypeSelector auraId={selected} onChanged={() => setRefreshKey((k) => k + 1)} />}
      {!selected ? (
        <Card><p className="text-body-md text-on-surface-variant">Select a case above to review recommended actions.</p></Card>
      ) : pathways === null ? (
        <Card><p className="text-body-md text-on-surface-variant">Loading…</p></Card>
      ) : pathways.length === 0 ? (
        <Card><p className="text-body-md text-on-surface-variant/60">No actions recommended for this case right now.</p></Card>
      ) : (
        <Card>
          <p className="text-label-sm text-on-surface-variant/70 mb-3">
            AURA suggests. You decide. Nothing here is actioned automatically.
          </p>
          <div className="space-y-2">
            {pathways.map((p) => {
              const d = decisions[key(p.pathway)]
              return (
                <div key={p.pathway} className="rounded-lg border border-outline-variant bg-surface-container px-3 py-2.5">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-label-md font-medium text-on-surface">
                        {p.pathway}
                        {p.urgency === "priority" && <span className="ml-2 text-label-sm font-bold text-error">PRIORITY</span>}
                      </div>
                      <div className="text-label-sm text-on-surface-variant">{p.reason}</div>
                    </div>
                    {d ? (
                      <span className={`text-label-sm font-semibold shrink-0 ${
                        d.status === "approved" ? "text-secondary" : d.status === "escalated" ? "text-error" : "text-on-surface-variant"
                      }`}>
                        {d.status === "approved" ? "Accepted" : d.status === "escalated" ? "Escalated" : "Dismissed"}
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-2 shrink-0">
                        <button onClick={() => act(p.pathway, "approved")} className="px-3 py-1 rounded-full bg-primary text-on-primary text-label-sm font-semibold">Accept</button>
                        <button onClick={() => setModifyOpen(p.pathway)} className="px-3 py-1 rounded-full border border-outline-variant text-on-surface text-label-sm font-medium">Modify</button>
                        <button onClick={() => act(p.pathway, "rejected")} className="px-3 py-1 rounded-full border border-outline-variant text-on-surface-variant text-label-sm font-medium">Dismiss</button>
                        <button onClick={() => act(p.pathway, "escalated", `Escalated: ${p.pathway}`)} className="px-3 py-1 rounded-full bg-error text-on-error text-label-sm font-semibold">Escalate</button>
                      </div>
                    )}
                  </div>
                  {modifyOpen === p.pathway && (
                    <div className="mt-2 flex gap-2">
                      <input
                        value={modifyText}
                        onChange={(e) => setModifyText(e.target.value)}
                        placeholder="Describe the modification…"
                        className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-label-md"
                      />
                      <button
                        onClick={() => act(p.pathway, "approved", `Modified: ${modifyText}`)}
                        className="px-3 py-1 rounded-full bg-primary text-on-primary text-label-sm font-semibold"
                      >
                        Save
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Care Plan
// ---------------------------------------------------------------------------
function CarePlanTab({
  queue,
  selected,
  onSelect,
  decisions,
}: {
  queue: CaseQueue | null
  selected: string | null
  onSelect: (id: string) => void
  decisions: Record<string, DecisionState>
}) {
  const [twin, setTwin] = useState<TwinResponse | null>(null)
  const [history, setHistory] = useState<InterventionRecord[] | null>(null)

  useEffect(() => {
    if (!selected) return
    setTwin(null)
    setHistory(null)
    fetchTwin(selected).then(setTwin)
    fetchSupportHistory(selected).then((d) => setHistory(d?.interventions ?? []))
  }, [selected])

  if (!selected) {
    return (
      <div className="flex flex-col gap-stack-md">
        <CasePicker queue={queue} selected={selected} onSelect={onSelect} />
        <Card><p className="text-body-md text-on-surface-variant">Select a case above to view its care plan.</p></Card>
      </div>
    )
  }

  // Real concerns/goals derived from the same twin/risk data Analysis shows -
  // no seeded flavour text. Concerns = why the risk band is what it is;
  // goals = the dimensions currently trending worse against this person's
  // own baseline, i.e. what care should actually be aimed at.
  const concerns = twin?.has_data ? twin.risk.contributing_factors.map((f) => `${f.factor} — ${f.detail}`) : []
  const goals = twin?.has_data
    ? twin.twin.deviation.worsening.map((dim) => `Bring ${dim} back toward this person's usual range`)
    : []

  // Persisted decisions (from a prior session too, not just this browser tab)
  // plus anything decided in this same visit that the history fetch above
  // predates.
  const liveOnly = Object.entries(decisions)
    .filter(([k]) => k.startsWith(`${selected}::`))
    .map(([k, v]) => ({ pathway: k.split("::")[1], status: v.status, note: v.note }))
  const historyPathways = new Set((history ?? []).map((h) => h.pathway))
  const interventions = [
    ...(history ?? []).map((h) => ({ pathway: h.pathway, status: h.status, note: h.reason ?? undefined })),
    ...liveOnly.filter((l) => !historyPathways.has(l.pathway)),
  ]

  const decided = interventions.filter((i) => i.status === "approved" || i.status === "completed").length
  const progress = interventions.length > 0 ? Math.round((decided / interventions.length) * 100) : null

  return (
    <div className="flex flex-col gap-stack-md">
      <CasePicker queue={queue} selected={selected} onSelect={onSelect} />
      <Card className="grid grid-cols-1 md:grid-cols-2 gap-gutter">
        <div>
          <h4 className="text-label-md text-on-surface-variant mb-2">Concerns</h4>
          {concerns.length === 0 ? <p className="text-label-sm text-on-surface-variant/60">None flagged.</p> : (
            <ul className="list-disc list-inside space-y-1 text-label-md text-on-surface">
              {concerns.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          )}
        </div>
        <div>
          <h4 className="text-label-md text-on-surface-variant mb-2">Goals</h4>
          {goals.length === 0 ? <p className="text-label-sm text-on-surface-variant/60">None set.</p> : (
            <ul className="list-disc list-inside space-y-1 text-label-md text-on-surface">
              {goals.map((g, i) => <li key={i}>{g}</li>)}
            </ul>
          )}
        </div>
        <div className="md:col-span-2">
          <h4 className="text-label-md text-on-surface-variant mb-2">Interventions (from Action Required)</h4>
          {interventions.length === 0 ? (
            <p className="text-label-sm text-on-surface-variant/60">No decisions recorded yet for this case.</p>
          ) : (
            <div className="space-y-1.5">
              {interventions.map((i, idx) => (
                <div key={idx} className="flex justify-between text-label-sm border-b border-outline-variant/40 pb-1">
                  <span className="text-on-surface">{i.pathway}</span>
                  <span className="text-on-surface-variant">{i.status}{i.note ? ` — ${i.note}` : ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="md:col-span-2">
          <h4 className="text-label-md text-on-surface-variant mb-1">Progress</h4>
          {progress === null ? (
            <p className="text-label-sm text-on-surface-variant/60">No interventions recorded yet.</p>
          ) : (
            <>
              <div className="h-2.5 rounded-full bg-surface-container-low overflow-hidden">
                <div className="h-full bg-primary rounded-full" style={{ width: `${progress}%` }} />
              </div>
              <p className="text-label-sm text-on-surface-variant mt-1">
                {progress}% of recorded interventions approved or completed
              </p>
            </>
          )}
        </div>
      </Card>
      <Card>
        <h4 className="text-label-md text-on-surface-variant mb-2">Case documents</h4>
        <CaseDocuments auraId={selected} />
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Follow-up
// ---------------------------------------------------------------------------
function FollowUpTab({
  queue,
  audit,
  nextEvents,
  onOpenCalendar,
}: {
  queue: CaseQueue | null
  audit: AuditEntryRow[]
  nextEvents: Map<string, CalendarEventRecord>
  onOpenCalendar: () => void
}) {
  if (!queue?.success) return <Card><p className="text-body-md text-on-surface-variant">Loading…</p></Card>
  const now = Date.now()
  const rows = queue.cases
    .map((c) => ({ c, event: nextEvents.get(c.aura_id) }))
    .filter((r): r is { c: (typeof queue.cases)[number]; event: CalendarEventRecord } => !!r.event)
  const overdue = rows.filter((r) => new Date(r.event.starts_at).getTime() < now)
  const upcoming = rows.filter((r) => new Date(r.event.starts_at).getTime() >= now)
  const unscheduled = queue.cases.filter((c) => !nextEvents.has(c.aura_id))
  const completed = audit.filter((a) => a.action === "risk_reviewed" || a.action === "continue_monitoring")

  const daysOf = (iso: string) => Math.round((new Date(iso).getTime() - now) / 86400000)

  return (
    <div className="flex flex-col gap-stack-md">
      <Card>
        <h3 className="text-headline-md text-error mb-2">Overdue</h3>
        {overdue.length === 0 ? <p className="text-label-md text-on-surface-variant/60">None.</p> : (
          <div className="space-y-1.5">
            {overdue.map((r) => (
              <div key={r.c.aura_id} className="flex justify-between text-label-md">
                <span>{r.c.aura_id} <span className="text-on-surface-variant text-label-sm">— {r.event.title}</span></span>
                <span className="text-error">{Math.abs(daysOf(r.event.starts_at))}d overdue</span>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card>
        <h3 className="text-headline-md text-on-surface mb-2">Upcoming</h3>
        {upcoming.length === 0 ? <p className="text-label-md text-on-surface-variant/60">None scheduled.</p> : (
          <div className="space-y-1.5">
            {upcoming.map((r) => (
              <div key={r.c.aura_id} className="flex justify-between text-label-md">
                <span>{r.c.aura_id} <span className="text-on-surface-variant text-label-sm">— {r.event.title}</span></span>
                <span className="text-on-surface-variant">in {daysOf(r.event.starts_at)}d</span>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-headline-md text-on-surface">Not yet scheduled</h3>
          <button onClick={onOpenCalendar} className="text-label-sm text-primary font-semibold hover:underline">
            Schedule in Calendar →
          </button>
        </div>
        {unscheduled.length === 0 ? <p className="text-label-md text-on-surface-variant/60">Every case has a next date on the calendar.</p> : (
          <div className="flex flex-wrap gap-1.5">
            {unscheduled.map((c) => (
              <span key={c.aura_id} className="text-label-sm px-2 py-1 rounded-full bg-surface-container text-on-surface-variant">
                {c.aura_id}
              </span>
            ))}
          </div>
        )}
      </Card>
      <Card>
        <h3 className="text-headline-md text-on-surface mb-2">Completed reviews</h3>
        {completed.length === 0 ? <p className="text-label-md text-on-surface-variant/60">None recorded yet.</p> : (
          <div className="space-y-1.5">
            {completed.slice(0, 10).map((a) => (
              <div key={a.id} className="flex justify-between text-label-sm text-on-surface-variant">
                <span>{a.aura_id} — {a.action.replace(/_/g, " ")}</span>
                <span>{new Date(a.timestamp).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
function ReportsTab({
  queue,
  selected,
  onSelect,
  decisions,
  audit,
}: {
  queue: CaseQueue | null
  selected: string | null
  onSelect: (id: string) => void
  decisions: Record<string, DecisionState>
  audit: AuditEntryRow[]
}) {
  const [data, setData] = useState<TwinResponse | null>(null)
  useEffect(() => {
    if (!selected) return
    setData(null)
    fetchTwin(selected).then(setData)
  }, [selected])

  const row = queue?.cases.find((c) => c.aura_id === selected)
  const caseAudit = audit.filter((a) => a.aura_id === selected)
  const interventions = Object.entries(decisions)
    .filter(([k]) => k.startsWith(`${selected}::`))
    .map(([k, v]) => ({ pathway: k.split("::")[1], ...v }))

  const exportCaseload = () => {
    if (!queue?.success) return
    downloadCsv(
      `aura-caseload-${new Date().toISOString().slice(0, 10)}.csv`,
      queue.cases.map((c) => ({
        aura_id: c.aura_id,
        risk_band: c.risk_band,
        risk_score: c.risk_score.toFixed(1),
        trend: c.trend_label,
        checkins_7d: c.checkins_last_7d,
        sessions: c.counts.sessions,
        days_since_checkin: c.days_since_checkin ?? "",
        human_review_required: c.human_review_required ? "yes" : "no",
        routing: c.routing,
      }))
    )
  }

  const exportCaseReport = () => {
    if (!row) return
    downloadCsv(`aura-case-${row.aura_id}.csv`, [
      {
        aura_id: row.aura_id,
        risk_band: row.risk_band,
        risk_score: row.risk_score.toFixed(1),
        trend: row.trend_label,
        routing: row.routing,
        checkins: row.counts.checkins,
        sessions: row.counts.sessions,
        analysis_confidence: data?.has_data ? data.risk.confidence.toFixed(0) : "",
        contributing_factors: data?.has_data ? data.risk.contributing_factors.length : "",
        actions_this_session: interventions.map((i) => `${i.pathway}:${i.status}`).join("; "),
        generated_at: new Date().toISOString(),
      },
    ])
  }

  return (
    <div className="flex flex-col gap-stack-md">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <CasePicker queue={queue} selected={selected} onSelect={onSelect} />
        <button
          onClick={exportCaseload}
          disabled={!queue?.success || queue.cases.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-outline-variant text-label-sm text-on-surface hover:bg-surface-container-low disabled:opacity-50"
        >
          <Download size={13} /> Export caseload (CSV)
        </button>
      </div>
      {!selected || !row ? (
        <Card><p className="text-body-md text-on-surface-variant">Select a case above to generate its report.</p></Card>
      ) : (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
            <h2 className="text-headline-lg text-on-surface">Case report — {selected}</h2>
            <button
              onClick={exportCaseReport}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-outline-variant text-label-sm text-on-surface hover:bg-surface-container-low shrink-0"
            >
              <Download size={13} /> Export (CSV)
            </button>
          </div>
          <p className="text-label-sm text-on-surface-variant/70 mb-4">Generated {new Date().toLocaleString()}</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-gutter">
            <div>
              <h4 className="text-label-md text-on-surface-variant mb-1">Case summary</h4>
              <p className="text-label-md text-on-surface">Risk: {row.risk_band} ({row.risk_score.toFixed(0)}) · Trend: {row.trend_label}</p>
              <p className="text-label-md text-on-surface">Routing: {row.routing}</p>
              <p className="text-label-md text-on-surface">Check-ins: {row.counts.checkins} · Sessions: {row.counts.sessions}</p>
            </div>
            <div>
              <h4 className="text-label-md text-on-surface-variant mb-1">Analysis</h4>
              {data?.has_data ? (
                <p className="text-label-md text-on-surface">
                  Confidence {data.risk.confidence.toFixed(0)}% · {data.risk.contributing_factors.length} contributing factor(s)
                </p>
              ) : (
                <p className="text-label-md text-on-surface-variant/60">No data available</p>
              )}
            </div>
            <div>
              <h4 className="text-label-md text-on-surface-variant mb-1">Actions taken</h4>
              {interventions.length === 0 ? (
                <p className="text-label-md text-on-surface-variant/60">None recorded this session.</p>
              ) : (
                interventions.map((i, idx) => (
                  <p key={idx} className="text-label-md text-on-surface">{i.pathway}: {i.status}</p>
                ))
              )}
            </div>
            <div>
              <h4 className="text-label-md text-on-surface-variant mb-1">Follow-up history</h4>
              {caseAudit.length === 0 ? (
                <p className="text-label-md text-on-surface-variant/60">No recorded history.</p>
              ) : (
                caseAudit.slice(0, 6).map((a) => (
                  <p key={a.id} className="text-label-sm text-on-surface-variant">
                    {new Date(a.timestamp).toLocaleDateString()} — {a.action.replace(/_/g, " ")}
                  </p>
                ))
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}

/** The "Aura Intelligence Panel" content for a case, opened from Overview's
 * charts/attention list without leaving the page. Every field is real data
 * already loaded for the queue/calendar - nothing fetched or fabricated
 * specially for the panel. */
function CaseInspectorPanel({
  caseRow,
  nextEvent,
  onOpenCaseHub,
  onOpenAnalysis,
  onOpenCalendar,
}: {
  caseRow: CaseRow
  nextEvent: CalendarEventRecord | undefined
  onOpenCaseHub: () => void
  onOpenAnalysis: () => void
  onOpenCalendar: () => void
}) {
  return (
    <div className="flex flex-col gap-stack-sm">
      <div className="flex items-center gap-2">
        <span className={`text-label-sm px-2 py-0.5 rounded-full ${BAND_STYLE[caseRow.risk_band]}`}>{caseRow.risk_band}</span>
        <TrendChip trend={caseRow.trend} />
        {caseRow.human_review_required && (
          <span className="text-label-sm text-error flex items-center gap-1">
            <AlertTriangle size={11} /> Review required
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <StatTile label="Risk score" value={Math.round(caseRow.risk_score)} />
        <StatTile label="Priority" value={caseRow.priority} />
        <StatTile label="Check-ins (7d)" value={caseRow.checkins_last_7d} />
        <StatTile label="Sessions" value={caseRow.counts.sessions} />
      </div>
      <div>
        <p className="text-label-sm font-semibold text-on-surface-variant uppercase tracking-wide mb-1">Routing</p>
        <p className="text-label-md text-on-surface">{caseRow.routing}</p>
      </div>
      <div>
        <p className="text-label-sm font-semibold text-on-surface-variant uppercase tracking-wide mb-1">Next event</p>
        <NextEventCell event={nextEvent} />
        {nextEvent && <p className="text-label-sm text-on-surface mt-0.5">{nextEvent.title}</p>}
      </div>
      <div>
        <p className="text-label-sm font-semibold text-on-surface-variant uppercase tracking-wide mb-2">Quick actions</p>
        <div className="flex flex-col gap-1.5">
          <button onClick={onOpenCaseHub} className="w-full text-left px-3 py-2 rounded-lg bg-primary text-on-primary text-label-md font-semibold">
            Open Case Hub
          </button>
          <button onClick={onOpenAnalysis} className="w-full text-left px-3 py-2 rounded-lg border border-outline-variant text-on-surface text-label-md">
            View analysis
          </button>
          <button onClick={onOpenCalendar} className="w-full text-left px-3 py-2 rounded-lg border border-outline-variant text-on-surface text-label-md">
            Schedule / view calendar
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export default function CounsellorDashboard({
  voiceCapabilities,
  backendOnline,
  tab,
  onTabChange: setTab,
  onAlertCountChange,
}: {
  voiceCapabilities: VoiceCapabilities | null
  backendOnline: boolean | null
  tab: TabKey
  onTabChange: (tab: TabKey) => void
  onAlertCountChange?: (count: number) => void
}) {
  const [queue, setQueue] = useState<CaseQueue | null>(null)
  const [audit, setAudit] = useState<AuditEntryRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [decisions, setDecisions] = useState<Record<string, DecisionState>>({})
  const [calendarEvents, setCalendarEvents] = useState<CalendarEventRecord[]>([])
  const [interventions, setInterventions] = useState<InterventionOverviewRecord[] | null>(null)
  const [documents, setDocuments] = useState<CaseDocumentOverviewRecord[] | null>(null)
  const [inspectId, setInspectId] = useState<string | null>(null)

  const loadCalendar = () => fetchOverviewCalendarEvents().then((r) => setCalendarEvents(r?.events ?? []))
  const loadInterventions = () => fetchSupportHistoryOverview().then((r) => setInterventions(r?.interventions ?? []))

  useEffect(() => {
    fetchCaseQueue().then((q) => {
      setQueue(q)
      if (q?.success && q.cases.length > 0) setSelected((s) => s ?? q.cases[0].aura_id)
    })
    fetchAuditLog(50).then((d) => setAudit(d?.entries ?? []))
    loadCalendar()
    loadInterventions()
    fetchCaseDocumentsOverview().then((r) => setDocuments(r?.documents ?? []))
  }, [])

  const nextEvents = useMemo(() => nextEventByCase(calendarEvents), [calendarEvents])
  const inspectRow = useMemo(() => queue?.cases.find((c) => c.aura_id === inspectId) ?? null, [queue, inspectId])

  const openCase = (id: string, target: TabKey) => {
    setSelected(id)
    setTab(target)
    setInspectId(null)
  }

  const alertCount = useMemo(
    () => (queue?.success ? queue.cases.filter((c) => c.risk_band !== "GREEN" || c.human_review_required).length : 0),
    [queue]
  )
  useEffect(() => onAlertCountChange?.(alertCount), [alertCount, onAlertCountChange])

  return (
    <div className="flex flex-col gap-stack-lg">
      <header>
        <h1 className="text-headline-lg text-primary">Counsellor Portal</h1>
        <p className="text-body-md text-on-surface-variant mt-1">Review cases and act on AURA's analysis — you make the final decision.</p>
      </header>

      {tab === "overview" && (
        <OverviewTab queue={queue} audit={audit} nextEvents={nextEvents} onInspect={setInspectId} />
      )}
      {tab === "cases" && <CasesTab queue={queue} nextEvents={nextEvents} onOpenCase={openCase} />}
      {tab === "casehub" && (
        <div className="flex flex-col gap-stack-md">
          <CasePicker queue={queue} selected={selected} onSelect={setSelected} />
          {!selected ? (
            <Card><p className="text-body-md text-on-surface-variant">Select a case above to open its Case Hub.</p></Card>
          ) : (
            <CaseHub auraId={selected} showTrustedContacts={false} showCounsellorLookup={false} />
          )}
        </div>
      )}
      {tab === "analysis" && <AnalysisTab queue={queue} selected={selected} onSelect={setSelected} />}
      {tab === "action" && (
        <ActionRequiredTab queue={queue} selected={selected} onSelect={setSelected} decisions={decisions} setDecisions={setDecisions} onDecided={loadInterventions} />
      )}
      {tab === "care" && <CarePlanTab queue={queue} selected={selected} onSelect={setSelected} decisions={decisions} />}
      {tab === "sessions" && (
        <SessionsBoard events={calendarEvents} onOpenCase={(id) => openCase(id, "casehub")} onChanged={loadCalendar} />
      )}
      {tab === "interventions" && (
        <Card>
          <h3 className="text-headline-md text-on-surface mb-1">Interventions pipeline</h3>
          <p className="text-label-sm text-on-surface-variant/70 mb-3">
            Every recorded support decision across your cases, by outcome.
          </p>
          <InterventionPipeline interventions={interventions} onOpenCase={(id) => openCase(id, "casehub")} />
        </Card>
      )}
      {tab === "followup" && (
        <FollowUpTab queue={queue} audit={audit} nextEvents={nextEvents} onOpenCalendar={() => setTab("calendar")} />
      )}
      {tab === "calendar" && (
        <OverviewCalendar
          cases={queue?.success ? queue.cases.map((c) => ({ aura_id: c.aura_id })) : []}
          onOpenCase={(id) => openCase(id, "casehub")}
          onChanged={loadCalendar}
        />
      )}
      {tab === "documents" && (
        <Card>
          <h3 className="text-headline-md text-on-surface mb-1">Documents</h3>
          <p className="text-label-sm text-on-surface-variant/70 mb-3">
            Every tracked file across your cases. Uploading happens from a case's own Case Hub.
          </p>
          <DocumentsOverview documents={documents} onOpenCase={(id) => openCase(id, "casehub")} />
        </Card>
      )}
      {tab === "reports" && <ReportsTab queue={queue} selected={selected} onSelect={setSelected} decisions={decisions} audit={audit} />}
      {tab === "resources" && (
        <Card>
          <h3 className="text-headline-md text-on-surface mb-1">Resources</h3>
          <p className="text-label-sm text-on-surface-variant/70 mb-3">
            Crisis and referral reference - the same guidance shown to victims via SOS, not a
            fabricated directory of services, addresses or capacity we don't actually track.
          </p>
          <div className="flex flex-col divide-y divide-outline-variant">
            {RESOURCE_REFERENCE.map((r) => (
              <div key={r.label} className="py-2.5">
                <p className="text-label-md font-semibold text-on-surface">{r.label}</p>
                <p className="text-label-sm text-on-surface-variant">{r.detail}</p>
              </div>
            ))}
          </div>
          <p className="text-label-sm text-on-surface-variant/60 mt-3">
            Case-specific referrals (counselling, medical, legal, protection, rehabilitation) are
            recommended and decided per case in Risk &amp; Alerts, not from a static list here.
          </p>
        </Card>
      )}
      {tab === "call" && <CounsellorCallPanel />}
      {tab === "history" && <HistoryProfilePage capabilities={voiceCapabilities} backendOnline={backendOnline} />}

      {tab !== "call" && tab !== "history" && (
        <p className="text-label-sm text-on-surface-variant/50 text-center">
          <UserCheck size={11} className="inline mr-1 -mt-0.5" />
          Next-event dates come from the shared Calendar. Care Plan concerns/goals/progress and recorded interventions are derived from this case's own signals and decisions.
        </p>
      )}

      <RightPanel
        open={!!inspectRow}
        onClose={() => setInspectId(null)}
        title={inspectRow?.aura_id ?? ""}
        subtitle="Case snapshot"
      >
        {inspectRow && (
          <CaseInspectorPanel
            caseRow={inspectRow}
            nextEvent={nextEvents.get(inspectRow.aura_id)}
            onOpenCaseHub={() => openCase(inspectRow.aura_id, "casehub")}
            onOpenAnalysis={() => openCase(inspectRow.aura_id, "analysis")}
            onOpenCalendar={() => openCase(inspectRow.aura_id, "calendar")}
          />
        )}
      </RightPanel>
    </div>
  )
}
