import { useCallback, useEffect, useState } from "react"
import { Users, ShieldCheck, Server, ScrollText, UserPlus, Link2, Loader2, Map, AlertOctagon, TrendingDown, FolderSearch, Download, Sparkles } from "lucide-react"
import {
  AdminUser,
  Assignment,
  GuardianLink,
  Role,
  adminCreateAssignment,
  adminCreateGuardianLink,
  adminCreateUser,
  adminListAssignments,
  adminListGuardianLinks,
  adminListUsers,
  adminRevokeAssignment,
  adminRevokeGuardianLink,
  adminUpdateUser,
} from "../lib/authApi"
import {
  seedDemoData,
  fetchGeoOverview,
  acknowledgeHighRiskCase,
  fetchSupportHistoryOverview,
  fetchCaseDocumentsOverview,
  GeoOverview,
  HighRiskCase,
  EscalatingCase,
  InterventionOverviewRecord,
  CaseDocumentOverviewRecord,
} from "../lib/auraApi"
import { fetchAuditLog, AuditEntryRow } from "../lib/riskApi"
import { API_BASE_URL } from "../lib/api"
import { downloadCsv } from "../lib/csvExport"
import CaseHub from "./CaseHub"
import OverviewCalendar from "./OverviewCalendar"
import InterventionPipeline from "./InterventionPipeline"
import DocumentsOverview from "./DocumentsOverview"
import RightPanel from "./ui/RightPanel"
import { DistrictRiskChart, RiskDistributionChart, StageBarChart } from "./ui/charts"
import { SidebarGroup } from "./AppShell"

type AlertSelection =
  | { kind: "high_risk"; case: HighRiskCase }
  | { kind: "escalating"; case: EscalatingCase }

/** The Alert Investigation Panel - what changed, the associated case, and a
 * suggested next action, built entirely from the same geo-overview fields
 * already on screen. Acknowledging or opening the case are the only actions
 * offered; AURA never turns the signal into an official decision itself. */
function AlertInvestigationPanel({
  alert,
  acknowledged,
  onAcknowledge,
  onOpenCaseHub,
}: {
  alert: AlertSelection
  acknowledged: boolean
  onAcknowledge: () => void
  onOpenCaseHub: () => void
}) {
  const c = alert.case
  const location = [c.district, c.state].filter(Boolean).join(", ") || "Unspecified location"
  return (
    <div className="flex flex-col gap-stack-sm">
      <div>
        <p className="text-label-sm font-semibold text-on-surface-variant uppercase tracking-wide mb-1">What changed</p>
        <p className="text-label-md text-on-surface">
          {alert.kind === "high_risk"
            ? `Risk score reached ${Math.round(alert.case.risk_score)}, entering the RED band.`
            : alert.case.rationale}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-surface-container-lowest border border-outline-variant px-3 py-2.5">
          <div className="text-label-sm uppercase tracking-wide text-on-surface-variant">Case type</div>
          <div className="text-label-md text-on-surface capitalize">{c.case_type.replace(/_/g, " ")}</div>
        </div>
        <div className="rounded-xl bg-surface-container-lowest border border-outline-variant px-3 py-2.5">
          <div className="text-label-sm uppercase tracking-wide text-on-surface-variant">Priority</div>
          <div className="text-label-md text-on-surface">{c.priority}</div>
        </div>
      </div>
      <div>
        <p className="text-label-sm font-semibold text-on-surface-variant uppercase tracking-wide mb-1">Location</p>
        <p className="text-label-md text-on-surface">{location}</p>
      </div>
      <div>
        <p className="text-label-sm font-semibold text-on-surface-variant uppercase tracking-wide mb-1">Status</p>
        <p className={`text-label-md font-semibold ${acknowledged ? "text-secondary" : "text-error"}`}>
          {acknowledged ? "Acknowledged" : "New — not yet reviewed"}
        </p>
      </div>
      <div>
        <p className="text-label-sm font-semibold text-on-surface-variant uppercase tracking-wide mb-2">Actions</p>
        <div className="flex flex-col gap-1.5">
          <button onClick={onOpenCaseHub} className="w-full text-left px-3 py-2 rounded-lg bg-primary text-on-primary text-label-md font-semibold">
            Open Case Hub
          </button>
          {alert.kind === "high_risk" && !acknowledged && (
            <button onClick={onAcknowledge} className="w-full text-left px-3 py-2 rounded-lg border border-error/30 text-error text-label-md font-medium">
              Acknowledge
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const STAFF_ROLES: { value: Role; label: string }[] = [
  { value: "counsellor", label: "Counsellor" },
  { value: "admin", label: "Administrator" },
  { value: "guardian", label: "Guardian" },
]

// Sidebar IA note: no separate "Victims" or "Services" item - this app has
// no person-profile data beyond the case itself, and no service-provider
// directory (locations/capacity) exists to back a Services module honestly.
const TABS = [
  { key: "overview", label: "Command Center" },
  { key: "alerts", label: "Risk & Alerts" },
  { key: "casehub", label: "Case Hub" },
  { key: "districts", label: "Districts" },
  { key: "counsellors", label: "Counsellors" },
  { key: "interventions", label: "Interventions" },
  { key: "calendar", label: "Calendar" },
  { key: "documents", label: "Documents" },
  { key: "reports", label: "Reports" },
  { key: "access", label: "Users & Access" },
  { key: "audit", label: "Audit & Security" },
  { key: "system", label: "System Health" },
] as const
export type TabKey = (typeof TABS)[number]["key"]

// Sidebar grouping of the same tabs above, rendered by AppShell itself as
// this role's one and only sidebar (see App.tsx).
export const ADMIN_SIDEBAR: SidebarGroup[] = [
  { items: [{ key: "overview", label: "Command Center", icon: "dashboard" }] },
  { heading: "Cases & Risk", items: [
    { key: "alerts", label: "Risk & Alerts", icon: "warning" },
    { key: "casehub", label: "Case Hub", icon: "topic" },
    { key: "interventions", label: "Interventions", icon: "support_agent" },
  ] },
  { heading: "Regions & Staff", items: [
    { key: "districts", label: "Districts", icon: "map" },
    { key: "counsellors", label: "Counsellors", icon: "groups" },
  ] },
  { heading: "Scheduling & Records", items: [
    { key: "calendar", label: "Calendar", icon: "calendar_month" },
    { key: "documents", label: "Documents", icon: "description" },
    { key: "reports", label: "Reports", icon: "bar_chart" },
  ] },
  { heading: "Administration", items: [
    { key: "access", label: "Users & Access", icon: "admin_panel_settings" },
    { key: "audit", label: "Audit & Security", icon: "shield" },
    { key: "system", label: "System Health", icon: "monitor_heart" },
  ] },
]

function Card({
  title,
  icon: Icon,
  className = "",
  children,
}: {
  title?: string
  icon?: typeof Users
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={`rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow ${className}`}>
      {title && (
        <h2 className="text-headline-md text-on-surface flex items-center gap-2 mb-4">
          {Icon && <Icon size={18} className="text-primary" />}
          {title}
        </h2>
      )}
      {children}
    </section>
  )
}

export default function AdminDashboard({
  tab,
  onTabChange: setTab,
  onAlertCountChange,
}: {
  tab: TabKey
  onTabChange: (tab: TabKey) => void
  onAlertCountChange?: (count: number) => void
}) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [auditEntries, setAuditEntries] = useState<AuditEntryRow[]>([])
  const [systemStatus, setSystemStatus] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  const [newEmail, setNewEmail] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [newName, setNewName] = useState("")
  const [newRole, setNewRole] = useState<Role>("counsellor")
  const [creating, setCreating] = useState(false)
  const [createMessage, setCreateMessage] = useState<string | null>(null)

  const [assignCounsellor, setAssignCounsellor] = useState("")
  const [assignVictimAuraId, setAssignVictimAuraId] = useState("")
  const [assigning, setAssigning] = useState(false)

  const [guardianLinks, setGuardianLinks] = useState<GuardianLink[]>([])
  const [linkGuardian, setLinkGuardian] = useState("")
  const [linkVictimAuraId, setLinkVictimAuraId] = useState("")
  const [linking, setLinking] = useState(false)

  const [seeding, setSeeding] = useState(false)
  const [seedMessage, setSeedMessage] = useState<string | null>(null)

  const [geo, setGeo] = useState<GeoOverview | null>(null)
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({})

  const [caseHubId, setCaseHubId] = useState("")
  const [openCaseHubId, setOpenCaseHubId] = useState("")
  const [alertSelection, setAlertSelection] = useState<AlertSelection | null>(null)
  const [interventions, setInterventions] = useState<InterventionOverviewRecord[] | null>(null)
  const [documents, setDocuments] = useState<CaseDocumentOverviewRecord[] | null>(null)
  const [selectedCounsellorId, setSelectedCounsellorId] = useState<string | null>(null)

  const acknowledge = async (auraId: string) => {
    const res = await acknowledgeHighRiskCase(auraId)
    if (res.success) setAcknowledged((p) => ({ ...p, [auraId]: true }))
  }

  const reload = useCallback(async () => {
    const [u, a, g, audit, geoData, interventionData, documentData] = await Promise.all([
      adminListUsers(),
      adminListAssignments(),
      adminListGuardianLinks(),
      fetchAuditLog(50),
      fetchGeoOverview(),
      fetchSupportHistoryOverview(),
      fetchCaseDocumentsOverview(),
    ])
    setUsers(u)
    setAssignments(a)
    setGuardianLinks(g)
    setAuditEntries(audit?.entries ?? [])
    setGeo(geoData)
    setInterventions(interventionData?.interventions ?? [])
    setDocuments(documentData?.documents ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    reload()
    fetch(`${API_BASE_URL}/api/system/status`)
      .then((r) => r.json())
      .then(setSystemStatus)
      .catch(() => setSystemStatus(null))
  }, [reload])

  const createStaff = async () => {
    setCreateMessage(null)
    if (!newEmail.trim() || newPassword.length < 12) {
      setCreateMessage("Enter an email and a password of at least 12 characters.")
      return
    }
    setCreating(true)
    const res = await adminCreateUser(newEmail.trim(), newPassword, newRole as "counsellor" | "admin" | "guardian", newName.trim() || undefined)
    setCreating(false)
    if (res.success) {
      setCreateMessage(`${STAFF_ROLES.find((r) => r.value === newRole)?.label} account created.`)
      setNewEmail("")
      setNewPassword("")
      setNewName("")
      reload()
    } else {
      setCreateMessage(res.error ?? "Could not create the account.")
    }
  }

  const toggleActive = async (user: AdminUser) => {
    await adminUpdateUser(user.id, { is_active: !user.is_active })
    reload()
  }

  const assignVictim = async () => {
    if (!assignCounsellor || !assignVictimAuraId.trim()) return
    setAssigning(true)
    await adminCreateAssignment(assignCounsellor, assignVictimAuraId.trim())
    setAssigning(false)
    setAssignVictimAuraId("")
    reload()
  }

  const revoke = async (id: string) => {
    await adminRevokeAssignment(id)
    reload()
  }

  const linkVictim = async () => {
    if (!linkGuardian || !linkVictimAuraId.trim()) return
    setLinking(true)
    await adminCreateGuardianLink(linkGuardian, linkVictimAuraId.trim())
    setLinking(false)
    setLinkVictimAuraId("")
    reload()
  }

  const revokeLink = async (id: string) => {
    await adminRevokeGuardianLink(id)
    reload()
  }

  const runSeedDemoData = async () => {
    setSeeding(true)
    setSeedMessage(null)
    const res = await seedDemoData()
    setSeeding(false)
    setSeedMessage(res.success ? res.note ?? "Demo data seeded." : res.error ?? "Could not seed demo data.")
  }

  const openCaseHub = (auraId: string) => {
    setOpenCaseHubId(auraId)
    setAlertSelection(null)
    setTab("casehub")
  }

  const counsellors = users.filter((u) => u.role === "counsellor")
  const guardians = users.filter((u) => u.role === "guardian")
  const alertCount = geo ? geo.high_risk_cases.length + geo.escalating_cases.length : 0
  useEffect(() => onAlertCountChange?.(alertCount), [alertCount, onAlertCountChange])

  if (loading) {
    return <p className="text-body-md text-on-surface-variant">Loading admin dashboard…</p>
  }

  return (
    <div className="flex flex-col gap-stack-lg">
      <header>
        <h1 className="text-display-lg-mobile text-on-surface">Admin Dashboard</h1>
        <p className="text-body-lg text-on-surface-variant mt-1">
          Case oversight, accounts, authorization and system health - one shared Case Hub and Calendar behind every view.
        </p>
      </header>

      {tab === "overview" && (() => {
        const combinedAlerts = [
          ...(geo?.high_risk_cases.map((c) => ({ kind: "high_risk" as const, case: c })) ?? []),
          ...(geo?.escalating_cases.map((c) => ({ kind: "escalating" as const, case: c })) ?? []),
        ].sort((a, b) => b.case.priority - a.case.priority)
        const topEscalating = geo?.escalating_cases.length
          ? [...geo.escalating_cases].sort((a, b) => b.priority - a.priority)[0]
          : null
        const workload = counsellors
          .map((c) => ({ label: c.email.split("@")[0], value: assignments.filter((a) => a.counsellor_user_id === c.id && a.active).length }))
          .filter((c) => c.value > 0)
          .sort((a, b) => b.value - a.value)
          .slice(0, 8)

        return (
        <div className="flex flex-col gap-stack-md">
          {/* Compact operational strip: one hero number + dense stat chips. */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="sm:w-64 shrink-0 rounded-[24px] bg-gradient-to-br from-error-container/25 to-transparent border border-error/20 px-5 py-4 flex flex-col justify-center">
              <span className="text-label-sm uppercase tracking-wide text-error font-semibold">Requires attention</span>
              <span className="text-display-lg text-error tabular-nums leading-none mt-1">{(geo?.national.amber ?? 0) + (geo?.national.red ?? 0)}</span>
              <span className="text-label-sm text-on-surface-variant mt-1">amber + red, of {geo?.national.total ?? 0} classified cases</span>
            </div>
            <div className="flex-1 flex flex-wrap gap-2 items-center rounded-[24px] bg-surface-container-lowest border border-outline-variant px-4 py-3">
              {[
                ["Total", geo?.national.total ?? 0, "text-on-surface"],
                ["Green", geo?.national.green ?? 0, "text-secondary"],
                ["Amber", geo?.national.amber ?? 0, "text-primary"],
                ["Red", geo?.national.red ?? 0, "text-error"],
                ["Unassessed", geo?.national.unassessed ?? 0, "text-on-surface"],
                ["States", geo?.states.length ?? 0, "text-on-surface"],
                ["High-risk", geo?.high_risk_cases.length ?? 0, "text-error"],
                ["Escalating", geo?.escalating_cases.length ?? 0, "text-primary"],
              ].map(([label, value, tone]) => (
                <div key={label as string} className="flex items-baseline gap-1.5 px-3 py-1 rounded-full bg-surface-container">
                  <span className={`text-label-lg font-bold tabular-nums ${tone}`}>{value}</span>
                  <span className="text-label-sm text-on-surface-variant">{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Regional risk landscape (7) + combined alerts (5). */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter">
            <Card className="lg:col-span-7" title="Regional risk landscape" icon={Map}>
              <p className="text-label-sm text-on-surface-variant/70 mb-2">
                Every district · size = case volume, height = amber+red share · click to open Districts
              </p>
              {!geo || geo.states.length === 0 ? (
                <p className="text-label-md text-on-surface-variant/60 py-6 text-center">No classified cases yet.</p>
              ) : (
                <DistrictRiskChart states={geo.states} onSelect={() => setTab("districts")} />
              )}
            </Card>
            <Card className="lg:col-span-5 flex flex-col" title="Needs attention" icon={AlertOctagon}>
              {combinedAlerts.length === 0 ? (
                <p className="text-label-md text-on-surface-variant/60 py-4">Nothing needs attention right now.</p>
              ) : (
                <div className="space-y-1.5 flex-1 overflow-y-auto max-h-[300px] pr-0.5">
                  {combinedAlerts.slice(0, 8).map((a) => (
                    <button
                      key={a.case.aura_id}
                      onClick={() => setAlertSelection(a)}
                      className={`w-full flex items-center justify-between gap-3 rounded-xl border-l-4 ${
                        a.kind === "high_risk" ? "border-error" : "border-primary"
                      } bg-surface-container px-3 py-2 text-left hover:bg-surface-container-low transition-colors`}
                    >
                      <div className="min-w-0">
                        <span className="text-label-md font-semibold text-on-surface">{a.case.aura_id}</span>
                        <p className="text-label-sm text-on-surface-variant truncate">
                          {[a.case.district, a.case.state].filter(Boolean).join(", ") || "Unspecified location"}
                        </p>
                      </div>
                      <span className={`shrink-0 text-label-sm font-semibold ${a.kind === "high_risk" ? "text-error" : "text-primary"}`}>
                        {a.kind === "high_risk" ? "RED" : "Escalating"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* By case type (7) + AURA Insight (5). */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter">
            <Card className="lg:col-span-7">
              <h3 className="text-label-md font-semibold text-on-surface mb-1">By case type</h3>
              <p className="text-label-sm text-on-surface-variant/70 mb-2">National rollup, real classifications only</p>
              {!geo || Object.keys(geo.by_case_type).length === 0 ? (
                <p className="text-label-md text-on-surface-variant/60 py-6 text-center">No classified cases yet.</p>
              ) : (
                <StageBarChart stages={Object.entries(geo.by_case_type).map(([type, count]) => ({ label: type.replace(/_/g, " "), value: count }))} />
              )}
            </Card>
            <Card className="lg:col-span-5">
              <h3 className="text-label-md font-semibold text-on-surface flex items-center gap-1.5 mb-1">
                <Sparkles size={14} className="text-primary" />
                AURA Insight
              </h3>
              {!topEscalating ? (
                <p className="text-label-sm text-on-surface-variant/70 py-3">No cases trending toward escalation right now.</p>
              ) : (
                <div className="text-label-sm space-y-2 mt-2">
                  <p className="text-on-surface">
                    <span className="font-semibold">{topEscalating.aura_id}</span> is trending toward escalation.
                  </p>
                  <div>
                    <span className="text-on-surface-variant/70 uppercase tracking-wide text-[10px] font-semibold">Observed</span>
                    <p className="text-on-surface">{topEscalating.rationale}</p>
                  </div>
                  <div>
                    <span className="text-on-surface-variant/70 uppercase tracking-wide text-[10px] font-semibold">Location</span>
                    <p className="text-on-surface">{[topEscalating.district, topEscalating.state].filter(Boolean).join(", ") || "Unspecified"}</p>
                  </div>
                  <button onClick={() => setAlertSelection({ kind: "escalating", case: topEscalating })} className="mt-1 text-label-sm text-primary font-semibold hover:underline">
                    Open case →
                  </button>
                </div>
              )}
            </Card>
          </div>

          {/* Case distribution (5) + counsellor workload (7). */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter">
            <Card className="lg:col-span-5">
              <h3 className="text-label-md font-semibold text-on-surface mb-1">Risk composition</h3>
              <p className="text-label-sm text-on-surface-variant/70 mb-2">By current risk band</p>
              {!geo || geo.national.total === 0 ? (
                <p className="text-label-md text-on-surface-variant/60 py-6 text-center">No classified cases yet.</p>
              ) : (
                <RiskDistributionChart green={geo.national.green} amber={geo.national.amber} red={geo.national.red} />
              )}
            </Card>
            <Card className="lg:col-span-7">
              <h3 className="text-label-md font-semibold text-on-surface mb-1">Counsellor workload</h3>
              <p className="text-label-sm text-on-surface-variant/70 mb-2">Active caseload per counsellor · see Counsellors for the full directory</p>
              {workload.length === 0 ? (
                <p className="text-label-md text-on-surface-variant/60 py-6 text-center">No active assignments yet.</p>
              ) : (
                <StageBarChart stages={workload} />
              )}
            </Card>
          </div>
        </div>
        )
      })()}

      {tab === "districts" && (
        <Card title="Districts" icon={Map}>
          <p className="text-label-sm text-on-surface-variant mb-4">
            State → district rollup of every classified case. Click through Case Hub above to open
            any individual case.
          </p>
          {!geo || geo.states.length === 0 ? (
            <p className="text-label-md text-on-surface-variant/60">No classified cases yet.</p>
          ) : (
            <div className="space-y-2">
              {geo.states.map((s) => (
                <div key={s.state} className="rounded-lg border border-outline-variant p-3">
                  <div className="flex justify-between text-label-md font-medium text-on-surface">
                    <span>{s.state}</span>
                    <span className="text-label-sm text-on-surface-variant">
                      {s.total} case{s.total === 1 ? "" : "s"} · {s.red} red · {s.amber} amber
                    </span>
                  </div>
                  <div className="mt-1.5 pl-3 space-y-1">
                    {s.districts.map((d) => (
                      <div key={d.district} className="flex justify-between text-label-sm text-on-surface-variant">
                        <span>{d.district}</span>
                        <span>
                          {d.total} · {d.red} red · {d.amber} amber
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === "counsellors" && (
        <Card title="Counsellor directory" icon={Users}>
          <p className="text-label-sm text-on-surface-variant mb-4">
            Every counsellor account and their active caseload - the real assignment count, not an
            invented capacity/availability figure this app doesn't track.
          </p>
          {counsellors.length === 0 ? (
            <p className="text-label-md text-on-surface-variant/60">No counsellor accounts yet.</p>
          ) : (
            <div className="space-y-1.5">
              {counsellors.map((c) => {
                const caseload = assignments.filter((a) => a.counsellor_user_id === c.id && a.active).length
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelectedCounsellorId(c.id)}
                    className="w-full flex items-center justify-between gap-3 text-left py-2.5 px-2 rounded-lg border-b border-surface-container-high last:border-0 hover:bg-surface-container-low"
                  >
                    <div className="min-w-0">
                      <p className="text-label-md text-on-surface truncate">{c.email}</p>
                      <p className="text-label-sm text-on-surface-variant">{c.is_active ? "Active" : "Deactivated"}</p>
                    </div>
                    <span className="shrink-0 text-label-sm px-2.5 py-1 rounded-full bg-primary-container/10 text-primary font-semibold">
                      {caseload} case{caseload === 1 ? "" : "s"}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </Card>
      )}

      {tab === "alerts" && (
        <div className="flex flex-col gap-stack-md">
          <Card title={`High-risk cases (${geo?.high_risk_cases.length ?? 0})`} icon={AlertOctagon}>
            {!geo || geo.high_risk_cases.length === 0 ? (
              <p className="text-label-md text-on-surface-variant/60">No RED-band cases right now.</p>
            ) : (
              <div className="space-y-1">
                {geo.high_risk_cases.map((c) => (
                  <div key={c.aura_id} className="flex items-center justify-between gap-3 text-label-sm py-2 border-b border-surface-container-high last:border-0">
                    <button onClick={() => setAlertSelection({ kind: "high_risk", case: c })} className="min-w-0 text-left hover:underline">
                      <span className="text-on-surface">
                        {c.aura_id} <span className="text-on-surface-variant capitalize">({c.case_type.replace(/_/g, " ")})</span>
                      </span>
                      <span className="text-on-surface-variant block">
                        {[c.district, c.state].filter(Boolean).join(", ") || "Unspecified location"} · score {Math.round(c.risk_score)}
                      </span>
                    </button>
                    {acknowledged[c.aura_id] ? (
                      <span className="shrink-0 text-label-sm text-secondary font-medium">Acknowledged</span>
                    ) : (
                      <button
                        onClick={() => acknowledge(c.aura_id)}
                        className="shrink-0 px-2.5 py-1 rounded-full border border-error/30 text-error text-label-sm font-medium hover:bg-error-container/10"
                      >
                        Acknowledge
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title={`Predicted to escalate (${geo?.escalating_cases.length ?? 0})`} icon={TrendingDown}>
            <p className="text-label-sm text-on-surface-variant/70 mb-2">
              Not yet RED, but a sustained decline and/or unusual swing across recent check-ins -
              a heuristic projection (see rationale per case), not a trained prediction model.
            </p>
            {!geo || geo.escalating_cases.length === 0 ? (
              <p className="text-label-sm text-on-surface-variant/60">No cases trending toward escalation right now.</p>
            ) : (
              <div className="space-y-1">
                {geo.escalating_cases.map((c) => (
                  <button key={c.aura_id} onClick={() => setAlertSelection({ kind: "escalating", case: c })} className="w-full text-left text-label-sm py-2 border-b border-surface-container-high last:border-0 hover:bg-surface-container-low rounded-lg px-1.5">
                    <div className="flex justify-between">
                      <span className="text-on-surface">
                        {c.aura_id} <span className="text-on-surface-variant capitalize">({c.case_type.replace(/_/g, " ")})</span>
                      </span>
                      <span className="text-on-surface-variant">
                        Currently {c.current_band} · {[c.district, c.state].filter(Boolean).join(", ") || "Unspecified location"}
                      </span>
                    </div>
                    <p className="text-on-surface-variant/80 mt-0.5">{c.rationale}</p>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "casehub" && (
        <div className="flex flex-col gap-stack-md">
          <Card title="Open a case" icon={FolderSearch}>
            <div className="flex gap-2">
              <input
                value={caseHubId}
                onChange={(e) => setCaseHubId(e.target.value)}
                placeholder="Case AURA-ID (e.g. AURA-XXXXXXXXXXXX)"
                className="flex-1 rounded-lg border border-outline-variant px-3 py-2 text-sm"
              />
              <button
                onClick={() => setOpenCaseHubId(caseHubId.trim())}
                disabled={!caseHubId.trim()}
                className="px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold disabled:opacity-50"
              >
                Open
              </button>
            </div>
          </Card>
          {openCaseHubId ? (
            <CaseHub auraId={openCaseHubId} showTrustedContacts={false} showCounsellorLookup={false} />
          ) : (
            <Card title="No case open" icon={FolderSearch}>
              <p className="text-label-md text-on-surface-variant/60">
                Enter a case ID above, or open one from Alerts, to view its full Case Hub - the same
                journey, documents, people and updates the victim and their counsellor see.
              </p>
            </Card>
          )}
        </div>
      )}

      {tab === "interventions" && (
        <Card title="Interventions pipeline" icon={ShieldCheck}>
          <div className="flex items-center justify-between gap-2 mb-3">
            <p className="text-label-sm text-on-surface-variant">
              Every recorded support decision across every case, by outcome.
            </p>
            <button
              onClick={() =>
                downloadCsv(
                  `aura-interventions-${new Date().toISOString().slice(0, 10)}.csv`,
                  (interventions ?? []).map((i) => ({
                    aura_id: i.aura_id,
                    pathway: i.pathway,
                    status: i.status,
                    reason: i.reason ?? "",
                    decided_by: i.decided_by ?? "",
                    decided_at: i.decided_at ?? "",
                    created_at: i.created_at,
                  }))
                )
              }
              disabled={!interventions || interventions.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-outline-variant text-label-sm text-on-surface hover:bg-surface-container-low disabled:opacity-50 shrink-0"
            >
              <Download size={13} /> Export (CSV)
            </button>
          </div>
          <InterventionPipeline interventions={interventions} onOpenCase={openCaseHub} />
        </Card>
      )}

      {tab === "calendar" && <OverviewCalendar onOpenCase={openCaseHub} />}

      {tab === "documents" && (
        <Card title="Documents" icon={FolderSearch}>
          <p className="text-label-sm text-on-surface-variant mb-3">
            Every tracked file across every case. Uploading happens from a case's own Case Hub.
          </p>
          <DocumentsOverview documents={documents} onOpenCase={openCaseHub} />
        </Card>
      )}

      {tab === "reports" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-gutter">
          <Card title="Intervention outcomes" icon={ShieldCheck}>
            <p className="text-label-sm text-on-surface-variant mb-3">Every recorded support decision, by outcome.</p>
            <button
              onClick={() =>
                downloadCsv(
                  `aura-interventions-${new Date().toISOString().slice(0, 10)}.csv`,
                  (interventions ?? []).map((i) => ({
                    aura_id: i.aura_id,
                    pathway: i.pathway,
                    status: i.status,
                    reason: i.reason ?? "",
                    decided_by: i.decided_by ?? "",
                    decided_at: i.decided_at ?? "",
                    created_at: i.created_at,
                  }))
                )
              }
              disabled={!interventions || interventions.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-outline-variant text-label-sm text-on-surface hover:bg-surface-container-low disabled:opacity-50"
            >
              <Download size={13} /> Export (CSV)
            </button>
          </Card>

          <Card title="Regional case rollup" icon={Map}>
            <p className="text-label-sm text-on-surface-variant mb-3">Every classified case, by state/district and risk band.</p>
            <button
              onClick={() =>
                downloadCsv(
                  `aura-regional-${new Date().toISOString().slice(0, 10)}.csv`,
                  (geo?.states ?? []).flatMap((s) =>
                    s.districts.map((d) => ({
                      state: s.state,
                      district: d.district,
                      total: d.total,
                      red: d.red,
                      amber: d.amber,
                    }))
                  )
                )
              }
              disabled={!geo || geo.states.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-outline-variant text-label-sm text-on-surface hover:bg-surface-container-low disabled:opacity-50"
            >
              <Download size={13} /> Export (CSV)
            </button>
          </Card>

          <Card title="Audit history" icon={ScrollText}>
            <p className="text-label-sm text-on-surface-variant mb-3">Every account, role and authorization change.</p>
            <button
              onClick={() =>
                downloadCsv(
                  `aura-audit-${new Date().toISOString().slice(0, 10)}.csv`,
                  auditEntries.map((e) => ({
                    action: e.action,
                    actor_role: e.actor_role,
                    aura_id: e.aura_id,
                    timestamp: e.timestamp,
                  }))
                )
              }
              disabled={auditEntries.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-outline-variant text-label-sm text-on-surface hover:bg-surface-container-low disabled:opacity-50"
            >
              <Download size={13} /> Export (CSV)
            </button>
          </Card>
        </div>
      )}

      {tab === "access" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-gutter">
          <Card title="User Management" icon={Users}>
            <div className="max-h-64 overflow-y-auto space-y-1.5 mb-4">
              {users.length === 0 ? (
                <p className="text-label-md text-on-surface-variant">No users yet.</p>
              ) : (
                users.map((u) => (
                  <div key={u.id} className="flex items-center justify-between gap-2 py-2 border-b border-surface-container-high last:border-0">
                    <div className="min-w-0">
                      <p className="text-label-md text-on-surface truncate">{u.email}</p>
                      <p className="text-label-sm text-on-surface-variant capitalize">
                        {u.role.replace("_", " ")} · {u.is_active ? "Active" : "Deactivated"}
                      </p>
                    </div>
                    <button
                      onClick={() => toggleActive(u)}
                      className={`shrink-0 px-2.5 py-1 rounded-full text-label-sm border ${
                        u.is_active
                          ? "border-error/30 text-error"
                          : "border-secondary/30 text-secondary"
                      }`}
                    >
                      {u.is_active ? "Deactivate" : "Activate"}
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="pt-3 border-t border-outline-variant">
              <h3 className="text-label-md font-semibold text-on-surface mb-2 flex items-center gap-1.5">
                <UserPlus size={14} />
                Create staff account
              </h3>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <input
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="Email"
                  className="col-span-2 rounded-lg border border-outline-variant px-3 py-2 text-sm"
                />
                <input
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  type="password"
                  placeholder="Password (12+ chars)"
                  className="col-span-2 rounded-lg border border-outline-variant px-3 py-2 text-sm"
                />
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Display name (optional)"
                  className="rounded-lg border border-outline-variant px-3 py-2 text-sm"
                />
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as Role)}
                  className="rounded-lg border border-outline-variant px-3 py-2 text-sm bg-surface-container-lowest"
                >
                  {STAFF_ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              {createMessage && <p className="text-label-sm text-primary mb-2">{createMessage}</p>}
              <button
                onClick={createStaff}
                disabled={creating}
                className="w-full py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {creating && <Loader2 size={14} className="animate-spin" />}
                Create account
              </button>
            </div>
          </Card>

          <Card title="Counsellor Authorization" icon={Link2}>
            <p className="text-label-sm text-on-surface-variant mb-3">
              Only assigned victims appear in a counsellor's case queue.
            </p>
            <div className="flex flex-col gap-2 mb-3">
              <select
                value={assignCounsellor}
                onChange={(e) => setAssignCounsellor(e.target.value)}
                className="rounded-lg border border-outline-variant px-3 py-2 text-sm bg-surface-container-lowest"
              >
                <option value="">Select a counsellor…</option>
                {counsellors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.email}
                  </option>
                ))}
              </select>
              <input
                value={assignVictimAuraId}
                onChange={(e) => setAssignVictimAuraId(e.target.value)}
                placeholder="Victim AURA-ID (e.g. AURA-XXXXXXXXXXXX)"
                className="rounded-lg border border-outline-variant px-3 py-2 text-sm"
              />
              <button
                onClick={assignVictim}
                disabled={assigning || !assignCounsellor || !assignVictimAuraId.trim()}
                className="py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold disabled:opacity-50"
              >
                Authorize access
              </button>
            </div>
            <div className="max-h-40 overflow-y-auto space-y-1.5">
              {assignments.length === 0 ? (
                <p className="text-label-md text-on-surface-variant">No assignments yet.</p>
              ) : (
                assignments.map((a) => {
                  const counsellor = users.find((u) => u.id === a.counsellor_user_id)
                  return (
                    <div key={a.id} className="flex items-center justify-between text-label-sm py-1.5 border-b border-surface-container-high last:border-0">
                      <span className="text-on-surface-variant truncate">
                        {counsellor?.email ?? a.counsellor_user_id} → {a.victim_aura_id}
                      </span>
                      {a.active && (
                        <button onClick={() => revoke(a.id)} className="text-error shrink-0 ml-2">
                          Revoke
                        </button>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </Card>

          <Card title="Guardian Authorization" icon={Link2}>
            <p className="text-label-sm text-on-surface-variant mb-3">
              A guardian sees only their linked victim's well-being summary - no transcripts or facial data.
            </p>
            <div className="flex flex-col gap-2 mb-3">
              <select
                value={linkGuardian}
                onChange={(e) => setLinkGuardian(e.target.value)}
                className="rounded-lg border border-outline-variant px-3 py-2 text-sm bg-surface-container-lowest"
              >
                <option value="">Select a guardian…</option>
                {guardians.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.email}
                  </option>
                ))}
              </select>
              <input
                value={linkVictimAuraId}
                onChange={(e) => setLinkVictimAuraId(e.target.value)}
                placeholder="Victim AURA-ID (e.g. AURA-XXXXXXXXXXXX)"
                className="rounded-lg border border-outline-variant px-3 py-2 text-sm"
              />
              <button
                onClick={linkVictim}
                disabled={linking || !linkGuardian || !linkVictimAuraId.trim()}
                className="py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold disabled:opacity-50"
              >
                Authorize access
              </button>
            </div>
            <div className="max-h-40 overflow-y-auto space-y-1.5">
              {guardianLinks.length === 0 ? (
                <p className="text-label-md text-on-surface-variant">No guardian links yet.</p>
              ) : (
                guardianLinks.map((l) => {
                  const guardian = users.find((u) => u.id === l.guardian_user_id)
                  return (
                    <div key={l.id} className="flex items-center justify-between text-label-sm py-1.5 border-b border-surface-container-high last:border-0">
                      <span className="text-on-surface-variant truncate">
                        {guardian?.email ?? l.guardian_user_id} → {l.victim_aura_id}
                      </span>
                      {l.active && (
                        <button onClick={() => revokeLink(l.id)} className="text-error shrink-0 ml-2">
                          Revoke
                        </button>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </Card>
        </div>
      )}

      {tab === "audit" && (
        <Card title="Audit & Security" icon={ScrollText}>
          <p className="text-label-sm text-on-surface-variant mb-3">
            Every account creation, role change, authorization change and case decision - the
            append-only trail. No separate "security events" feed exists beyond this log.
          </p>
          <button
            onClick={() =>
              downloadCsv(
                `aura-audit-${new Date().toISOString().slice(0, 10)}.csv`,
                auditEntries.map((e) => ({
                  action: e.action,
                  actor_role: e.actor_role,
                  aura_id: e.aura_id,
                  timestamp: e.timestamp,
                }))
              )
            }
            disabled={auditEntries.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-outline-variant text-label-sm text-on-surface hover:bg-surface-container-low disabled:opacity-50 mb-3"
          >
            <Download size={13} /> Export (CSV)
          </button>
          <div className="max-h-96 overflow-y-auto space-y-1.5">
            {auditEntries.length === 0 ? (
              <p className="text-label-md text-on-surface-variant">No audit activity yet.</p>
            ) : (
              auditEntries.map((e) => (
                <div key={e.id} className="text-label-sm py-1.5 border-b border-surface-container-high last:border-0">
                  <p className="text-on-surface">
                    <span className="font-medium capitalize">{e.action.replace(/_/g, " ")}</span>{" "}
                    <span className="text-on-surface-variant">by {e.actor_role}</span>
                    {e.aura_id && <span className="text-on-surface-variant"> · {e.aura_id}</span>}
                  </p>
                  <p className="text-on-surface-variant/70">{new Date(e.timestamp).toLocaleString()}</p>
                </div>
              ))
            )}
          </div>
        </Card>
      )}

      {tab === "system" && (
        <Card title="System Health" icon={Server}>
          {systemStatus ? (
            <div className="space-y-1.5 text-label-md">
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Environment</span>
                <span className="text-on-surface">{String(systemStatus.environment ?? "—")}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Database</span>
                <span className="text-on-surface">{String(systemStatus.database_backend ?? "—")}</span>
              </div>
              {systemStatus.integrations != null &&
                Object.entries(systemStatus.integrations as Record<string, { configured: boolean }>).map(
                  ([name, info]) => (
                    <div key={name} className="flex justify-between">
                      <span className="text-on-surface-variant capitalize">{name}</span>
                      <span className={info.configured ? "text-secondary" : "text-on-surface-variant"}>
                        {info.configured ? "Configured" : "Not configured"}
                      </span>
                    </div>
                  )
                )}
              <p className="text-label-sm text-on-surface-variant/60 pt-1">
                Uptime, latency and error-rate monitoring aren't wired up yet - this reflects
                configuration status only, not live service health.
              </p>
            </div>
          ) : (
            <p className="text-label-md text-on-surface-variant">System status unavailable.</p>
          )}

          <div className="pt-3 mt-3 border-t border-outline-variant">
            <h3 className="text-label-md font-semibold text-on-surface mb-1.5">Demo data</h3>
            <p className="text-label-sm text-on-surface-variant mb-2">
              Writes a small synthetic well-being history through the real storage path, so the
              victim dashboard, an assigned counsellor's case queue, a linked guardian's summary
              and this admin's case list all show the same connected numbers. Non-production only.
            </p>
            <button
              onClick={runSeedDemoData}
              disabled={seeding}
              className="px-3 py-1.5 rounded-full border border-outline-variant text-label-sm text-on-surface hover:bg-surface-container-low disabled:opacity-50 flex items-center gap-2"
            >
              {seeding && <Loader2 size={13} className="animate-spin" />}
              Seed synthetic demo data
            </button>
            {seedMessage && <p className="text-label-sm text-primary mt-2">{seedMessage}</p>}
          </div>
        </Card>
      )}

      <div className="rounded-[24px] bg-surface-container-low border border-outline-variant p-4 flex items-start gap-2">
        <ShieldCheck size={16} className="text-on-surface-variant mt-0.5 shrink-0" />
        <p className="text-label-sm text-on-surface-variant">
          Every account creation, role change and authorization change here is written to the
          append-only audit log above.
        </p>
      </div>

      <RightPanel
        open={!!alertSelection}
        onClose={() => setAlertSelection(null)}
        title={alertSelection?.case.aura_id ?? ""}
        subtitle={alertSelection?.kind === "high_risk" ? "High-risk alert" : "Escalation signal"}
      >
        {alertSelection && (
          <AlertInvestigationPanel
            alert={alertSelection}
            acknowledged={!!acknowledged[alertSelection.case.aura_id]}
            onAcknowledge={() => acknowledge(alertSelection.case.aura_id)}
            onOpenCaseHub={() => openCaseHub(alertSelection.case.aura_id)}
          />
        )}
      </RightPanel>

      <RightPanel
        open={!!selectedCounsellorId}
        onClose={() => setSelectedCounsellorId(null)}
        title={users.find((u) => u.id === selectedCounsellorId)?.email ?? ""}
        subtitle="Counsellor caseload"
      >
        {selectedCounsellorId && (
          <div className="flex flex-col gap-2">
            {assignments.filter((a) => a.counsellor_user_id === selectedCounsellorId && a.active).length === 0 ? (
              <p className="text-label-md text-on-surface-variant/60">No active cases assigned.</p>
            ) : (
              assignments
                .filter((a) => a.counsellor_user_id === selectedCounsellorId && a.active)
                .map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      setSelectedCounsellorId(null)
                      openCaseHub(a.victim_aura_id)
                    }}
                    className="w-full text-left px-3 py-2.5 rounded-lg border border-outline-variant hover:bg-surface-container-low text-label-md text-on-surface font-medium"
                  >
                    {a.victim_aura_id}
                  </button>
                ))
            )}
          </div>
        )}
      </RightPanel>
    </div>
  )
}
