import { useEffect, useMemo, useState } from "react"
import { ArrowDown, ArrowUp, Minus, UserCheck, Info, AlertTriangle } from "lucide-react"
import {
  CaseQueue,
  CaseTypeOption,
  InterventionRecord,
  RiskBand,
  SupportSuggestion,
  TwinResponse,
  fetchCaseQueue,
  fetchCaseType,
  fetchCaseTypes,
  fetchSupportHistory,
  fetchSupportPathways,
  fetchTwin,
  recordSupportDecision,
  setCaseType,
} from "../lib/auraApi"
import { fetchAuditLog, recordReview, AuditEntryRow } from "../lib/riskApi"

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "cases", label: "Cases" },
  { key: "analysis", label: "Analysis" },
  { key: "action", label: "Action Required" },
  { key: "care", label: "Care Plan" },
  { key: "followup", label: "Follow-up" },
  { key: "reports", label: "Reports" },
] as const
type TabKey = (typeof TABS)[number]["key"]

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

/** A seed generated once per login session (not per render/tab-switch), so
 *  the synthetic demo values below look fresh each time a counsellor signs
 *  in, but don't jump around every time a component re-renders while they're
 *  actually reviewing a case. Cleared automatically when the browser session
 *  ends (sessionStorage), and can be forced to rotate on explicit login via
 *  resetSyntheticDataSeed(). */
const SESSION_SEED_KEY = "aura_synthetic_seed"

function getSessionSeed(): string {
  try {
    let seed = sessionStorage.getItem(SESSION_SEED_KEY)
    if (!seed) {
      seed = Math.random().toString(36).slice(2) + Date.now().toString(36)
      sessionStorage.setItem(SESSION_SEED_KEY, seed)
    }
    return seed
  } catch {
    return "fallback-seed"
  }
}

/** Call right after a successful login so each new session gets its own
 *  synthetic values instead of inheriting the previous session's seed. */
export function resetSyntheticDataSeed(): void {
  try {
    sessionStorage.setItem(
      SESSION_SEED_KEY,
      Math.random().toString(36).slice(2) + Date.now().toString(36)
    )
  } catch {
    /* sessionStorage unavailable - demo values just keep the prior seed */
  }
}

/** Deterministic pseudo-random generator seeded by aura_id + the current
 *  login session, so demo values used to fill in fields the backend doesn't
 *  track yet (care-plan goals, follow-up due dates) stay stable while
 *  browsing this session, but differ from one login to the next. */
function seededRandom(seedInput: string) {
  const seed = seedInput + "::" + getSessionSeed()
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0
  return () => {
    h = (Math.imul(h ^ (h >>> 15), 1 | h) + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 7), 61 | h)
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), 1 | t))) >>> 0
    return (t ^ (t >>> 14)) / 4294967296
  }
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
  onOpenCase,
}: {
  queue: CaseQueue | null
  audit: AuditEntryRow[]
  onOpenCase: (id: string, tab: TabKey) => void
}) {
  if (!queue || !queue.success) {
    return <Card><p className="text-body-md text-on-surface-variant">{queue?.error ?? "Loading…"}</p></Card>
  }
  const attention = queue.cases
    .filter((c) => c.risk_band !== "GREEN" || c.human_review_required)
    .sort((a, b) => b.priority - a.priority)

  return (
    <div className="flex flex-col gap-stack-md">
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <StatTile label="Total" value={queue.summary.total} />
        <StatTile label="Green" value={queue.summary.green} tone="text-secondary" />
        <StatTile label="Amber" value={queue.summary.amber} tone="text-primary" />
        <StatTile label="Red" value={queue.summary.red} tone="text-error" />
        <StatTile label="Pending review" value={queue.summary.pending_review} />
        <StatTile label="Needs follow-up" value={queue.summary.needs_followup} />
      </div>

      <Card>
        <h3 className="text-headline-md text-on-surface mb-1">What needs my attention?</h3>
        <p className="text-label-sm text-on-surface-variant/70 mb-3">
          Cases flagged amber/red or requiring human review, highest priority first.
        </p>
        {attention.length === 0 ? (
          <p className="text-body-md text-on-surface-variant py-4">Nothing needs attention right now.</p>
        ) : (
          <div className="space-y-2">
            {attention.map((c) => (
              <button
                key={c.aura_id}
                onClick={() => onOpenCase(c.aura_id, "action")}
                className={`w-full flex items-center justify-between gap-3 rounded-xl border-l-4 ${BAND_BORDER[c.risk_band]} bg-surface-container px-3 py-2.5 text-left hover:bg-surface-container-low transition-colors`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-label-md font-semibold text-on-surface">{c.aura_id}</span>
                    <span className={`text-label-sm px-2 py-0.5 rounded-full ${BAND_STYLE[c.risk_band]}`}>{c.risk_band}</span>
                    {c.human_review_required && (
                      <span className="text-label-sm text-error flex items-center gap-1">
                        <AlertTriangle size={11} /> Review required
                      </span>
                    )}
                  </div>
                  <p className="text-label-sm text-on-surface-variant truncate">{c.routing}</p>
                </div>
                <TrendChip trend={c.trend} />
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h3 className="text-headline-md text-on-surface mb-3">Recent activity</h3>
        {audit.length === 0 ? (
          <p className="text-body-md text-on-surface-variant/60 py-2">No recorded actions yet.</p>
        ) : (
          <div className="space-y-1.5">
            {audit.slice(0, 8).map((a) => (
              <div key={a.id} className="flex items-center justify-between text-label-sm border-b border-outline-variant/40 pb-1.5">
                <span className="text-on-surface">{a.action.replace(/_/g, " ")}</span>
                <span className="text-on-surface-variant">{a.aura_id}</span>
                <span className="text-on-surface-variant/70">{new Date(a.timestamp).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------
function CasesTab({
  queue,
  onOpenCase,
}: {
  queue: CaseQueue | null
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
            <th className="py-2 pr-3">Next follow-up</th>
            <th className="py-2 pr-3"></th>
          </tr>
        </thead>
        <tbody>
          {queue.cases.map((c) => {
            const rnd = seededRandom(c.aura_id)
            const dueInDays = Math.floor(rnd() * 10) - 3
            return (
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
                <td className={`py-2 pr-3 ${dueInDays < 0 ? "text-error" : "text-on-surface-variant"}`}>
                  {dueInDays < 0 ? `Overdue ${Math.abs(dueInDays)}d` : `In ${dueInDays}d`}
                </td>
                <td className="py-2 pr-3">
                  <button
                    onClick={() => onOpenCase(c.aura_id, "analysis")}
                    className="text-label-sm text-primary font-semibold hover:underline"
                  >
                    Open →
                  </button>
                </td>
              </tr>
            )
          })}
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
          className={`px-3 py-1.5 rounded-full text-label-sm font-medium border ${
            selected === c.aura_id
              ? "bg-primary text-on-primary border-primary"
              : `border-outline-variant text-on-surface-variant hover:bg-surface-container-low ${BAND_STYLE[c.risk_band]}`
          }`}
        >
          {c.aura_id}
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
          className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1 text-label-md text-on-surface disabled:opacity-50"
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
          className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1 text-label-md text-on-surface"
        />
        <input
          value={state}
          onChange={(e) => setState(e.target.value)}
          onBlur={() => save({})}
          placeholder="State"
          className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1 text-label-md text-on-surface"
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
}: {
  queue: CaseQueue | null
  selected: string | null
  onSelect: (id: string) => void
  decisions: Record<string, DecisionState>
  setDecisions: (fn: (p: Record<string, DecisionState>) => Record<string, DecisionState>) => void
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
                  <div className="flex items-center gap-3">
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
                      <div className="flex gap-2 shrink-0">
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Follow-up
// ---------------------------------------------------------------------------
function FollowUpTab({ queue, audit }: { queue: CaseQueue | null; audit: AuditEntryRow[] }) {
  if (!queue?.success) return <Card><p className="text-body-md text-on-surface-variant">Loading…</p></Card>
  const rows = queue.cases.map((c) => {
    const rnd = seededRandom(c.aura_id + ":followup")
    const dueInDays = Math.floor(rnd() * 12) - 4
    const escalatedRecently = audit.some((a) => a.aura_id === c.aura_id && a.action === "follow_up_requested")
    return { c, dueInDays, escalatedRecently }
  })
  const overdue = rows.filter((r) => r.dueInDays < 0)
  const upcoming = rows.filter((r) => r.dueInDays >= 0)
  const completed = audit.filter((a) => a.action === "risk_reviewed" || a.action === "continue_monitoring")

  return (
    <div className="flex flex-col gap-stack-md">
      <Card>
        <h3 className="text-headline-md text-error mb-2">Overdue</h3>
        {overdue.length === 0 ? <p className="text-label-md text-on-surface-variant/60">None.</p> : (
          <div className="space-y-1.5">
            {overdue.map((r) => (
              <div key={r.c.aura_id} className="flex justify-between text-label-md">
                <span>{r.c.aura_id} {r.escalatedRecently && <span className="text-error text-label-sm">(escalated)</span>}</span>
                <span className="text-error">{Math.abs(r.dueInDays)}d overdue</span>
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
                <span>{r.c.aura_id}</span>
                <span className="text-on-surface-variant">in {r.dueInDays}d</span>
              </div>
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

  return (
    <div className="flex flex-col gap-stack-md">
      <CasePicker queue={queue} selected={selected} onSelect={onSelect} />
      {!selected || !row ? (
        <Card><p className="text-body-md text-on-surface-variant">Select a case above to generate its report.</p></Card>
      ) : (
        <Card>
          <h2 className="text-headline-lg text-on-surface mb-1">Case report — {selected}</h2>
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

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export default function CounsellorDashboard() {
  const [tab, setTab] = useState<TabKey>("overview")
  const [queue, setQueue] = useState<CaseQueue | null>(null)
  const [audit, setAudit] = useState<AuditEntryRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [decisions, setDecisions] = useState<Record<string, DecisionState>>({})

  useEffect(() => {
    fetchCaseQueue().then((q) => {
      setQueue(q)
      if (q?.success && q.cases.length > 0) setSelected((s) => s ?? q.cases[0].aura_id)
    })
    fetchAuditLog(50).then((d) => setAudit(d?.entries ?? []))
  }, [])

  const openCase = (id: string, target: TabKey) => {
    setSelected(id)
    setTab(target)
  }

  const alertCount = useMemo(
    () => (queue?.success ? queue.cases.filter((c) => c.risk_band !== "GREEN" || c.human_review_required).length : 0),
    [queue]
  )

  return (
    <div className="flex flex-col gap-stack-lg">
      <header>
        <h1 className="text-headline-lg text-primary">Counsellor Portal</h1>
        <p className="text-body-md text-on-surface-variant mt-1">Review cases and act on AURA's analysis — you make the final decision.</p>
      </header>

      <div className="flex flex-wrap gap-1 border-b border-outline-variant">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-label-md font-semibold rounded-t-lg transition-colors ${
              tab === t.key
                ? "text-primary border-b-2 border-primary bg-surface-container-lowest"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {t.label}
            {t.key === "overview" && alertCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-error text-on-error text-[10px] font-bold px-1">
                {alertCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab queue={queue} audit={audit} onOpenCase={openCase} />}
      {tab === "cases" && <CasesTab queue={queue} onOpenCase={openCase} />}
      {tab === "analysis" && <AnalysisTab queue={queue} selected={selected} onSelect={setSelected} />}
      {tab === "action" && (
        <ActionRequiredTab queue={queue} selected={selected} onSelect={setSelected} decisions={decisions} setDecisions={setDecisions} />
      )}
      {tab === "care" && <CarePlanTab queue={queue} selected={selected} onSelect={setSelected} decisions={decisions} />}
      {tab === "followup" && <FollowUpTab queue={queue} audit={audit} />}
      {tab === "reports" && <ReportsTab queue={queue} selected={selected} onSelect={setSelected} decisions={decisions} audit={audit} />}

      <p className="text-label-sm text-on-surface-variant/50 text-center">
        <UserCheck size={11} className="inline mr-1 -mt-0.5" />
        Follow-up due dates shown here are illustrative placeholders — AURA does not yet store structured scheduling data. Care Plan concerns/goals/progress and recorded interventions are real, derived from this case's own signals and decisions.
      </p>
    </div>
  )
}
