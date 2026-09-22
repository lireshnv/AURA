import { useCallback, useEffect, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  Minus,
  Info,
  ShieldCheck,
  HandHeart,
  Eye,
} from "lucide-react"
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts"
import { RiskAssessmentView, RiskHistory, fetchRiskAssessment, fetchRiskHistory, recordReview } from "../lib/riskApi"
import { CHART, BAND_COLOR, BAND_LABEL } from "../lib/chartColors"

const STATUS_STYLE: Record<string, { chip: string; bar: string; text: string }> = {
  STABLE: {
    chip: "bg-secondary-container/20 border-secondary/20 text-on-secondary-container",
    bar: "bg-secondary",
    text: "text-on-secondary-container",
  },
  IMPROVING: {
    chip: "bg-secondary-container/20 border-secondary/20 text-on-secondary-container",
    bar: "bg-secondary",
    text: "text-on-secondary-container",
  },
  CHANGING: {
    chip: "bg-amber-50 border-amber-200 text-amber-700",
    bar: "bg-amber-500",
    text: "text-amber-700",
  },
  NEEDS_REVIEW: {
    chip: "bg-error-container/20 border-error/40 text-error",
    bar: "bg-error",
    text: "text-error",
  },
  BUILDING: {
    chip: "bg-surface-container-high border-outline-variant text-on-surface-variant",
    bar: "bg-outline",
    text: "text-on-surface-variant",
  },
}

const STRENGTH_STYLE: Record<string, string> = {
  HIGH: "text-error bg-error-container/20 border-error/40",
  MEDIUM: "text-amber-700 bg-amber-50 border-amber-200",
  LOW: "text-on-surface-variant bg-surface-container-high border-outline-variant",
  NONE: "text-on-surface-variant/60 bg-surface-container-low border-outline-variant",
}

function Arrow({ direction }: { direction: string }) {
  if (direction === "up") return <ArrowUp size={12} className="text-amber-600" />
  if (direction === "down") return <ArrowDown size={12} className="text-tertiary" />
  return <Minus size={12} className="text-on-surface-variant/60" />
}

const RISK_RING_CIRCUMFERENCE = 2 * Math.PI * 54

/** The strongest visual on the page - distress signal, large, ringed and
 * color-coded by the backend's own LOW/MEDIUM/HIGH band. */
function DistressRing({ score, band }: { score: number; band?: string }) {
  const clamped = Math.max(0, Math.min(100, score))
  const offset = RISK_RING_CIRCUMFERENCE * (1 - clamped / 100)
  const color = (band && BAND_COLOR[band]) || CHART.purple
  return (
    <div className="relative w-44 h-44 shrink-0">
      <svg className="w-44 h-44 transform -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" fill="none" r="54" stroke="var(--color-surface-container-high)" strokeWidth="9" />
        <circle
          cx="60"
          cy="60"
          fill="none"
          r="54"
          stroke={color}
          strokeDasharray={RISK_RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          strokeLinecap="round"
          strokeWidth="9"
          className="transition-all duration-1000 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-5xl font-bold tabular-nums leading-none" style={{ color }}>
          {Math.round(clamped)}
        </span>
        <span className="text-[11px] text-on-surface-variant/70 mt-1">/ 100</span>
      </div>
    </div>
  )
}

function BandBadge({ band }: { band?: string }) {
  if (!band) return null
  const color = BAND_COLOR[band] ?? "#64748b"
  const label = BAND_LABEL[band] ?? band
  return (
    <span
      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border"
      style={{ color, borderColor: `${color}40`, background: `${color}14` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

export default function RiskAndTrend() {
  const [data, setData] = useState<RiskAssessmentView | null>(null)
  const [history, setHistory] = useState<RiskHistory | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [a, h] = await Promise.all([fetchRiskAssessment(), fetchRiskHistory(7)])
    setData(a)
    setHistory(h)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const act = async (action: string, label: string) => {
    const res = await recordReview({
      action,
      actor_role: "user",
      reason: "Requested from Risk & Trend view",
    })
    setMessage(res.success ? `${label} recorded. ${res.note ?? ""}` : res.error ?? "Could not record.")
  }

  if (!data) {
    return <p className="text-sm text-on-surface-variant">Loading…</p>
  }

  const style = STATUS_STYLE[data.status] ?? STATUS_STYLE.BUILDING

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-headline-md text-on-surface">Risk &amp; Trend</h1>
        <p className="text-body-md text-on-surface-variant mt-0.5">
          Meaningful changes in your own pattern — not a prediction about you.
        </p>
      </div>

      {message && (
        <div className="rounded-lg bg-primary-container/10 border border-primary/20 px-4 py-2.5 text-xs text-primary">
          {message}
        </div>
      )}

      {/* ---- Status : the strongest visual element on this page ---- */}
      <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`inline-block px-2.5 py-1 rounded-full border text-[11px] font-bold ${style.chip}`}
              >
                {data.status.replace("_", " ")}
              </span>
              <BandBadge band={data.band} />
            </div>
            <p className="text-sm text-on-surface-variant mt-2 max-w-sm">{data.status_label}</p>
            {data.available && (
              <p className="text-[11px] text-on-surface-variant/70 mt-1">
                Confidence {data.confidence?.toFixed(0)}%
              </p>
            )}
            {!data.available && (
              <div className="mt-1">
                <div className="text-sm text-on-surface-variant/70">{data.reason}</div>
                {data.checkins_needed ? (
                  <div className="text-[11px] text-primary mt-1">
                    {data.checkins_needed} more check-in
                    {data.checkins_needed === 1 ? "" : "s"} needed
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {data.available && (
            <DistressRing score={data.distress_signal ?? 0} band={data.band} />
          )}
        </div>

        <p className="flex items-start gap-1.5 text-[10px] text-on-surface-variant mt-3 pt-3 border-t border-outline-variant">
          <Info size={11} className="mt-0.5 shrink-0" />
          {data.disclaimer}
        </p>
      </section>

      {/* ---- Why? ---- */}
      {data.available && (
        <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
          <h2 className="text-sm font-semibold text-on-surface mb-1">Why?</h2>
          <p className="text-[11px] text-on-surface-variant mb-3">
            Observed signals compared with your own recent baseline.
          </p>

          <div className="space-y-1.5 mb-4">
            {data.contributions.map((c) => (
              <div key={c.signal} className="flex items-center gap-3 text-xs">
                <span className="w-32 text-on-surface-variant">{c.signal}</span>
                <div className="flex-1 h-1.5 rounded-full bg-surface-container-high overflow-hidden">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${Math.min(100, c.value ?? 0)}%` }}
                  />
                </div>
                <span
                  className={`w-20 text-center px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
                    STRENGTH_STYLE[c.strength]
                  }`}
                >
                  {c.strength}
                </span>
                <span className="w-10 text-right text-[10px] text-on-surface-variant/70">
                  {(c.weight * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>

          {data.contributing_factors.length > 0 && (
            <ul className="space-y-1 mb-3">
              {data.contributing_factors.map((f, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[11px] text-on-surface-variant">
                  <span className="mt-0.5">
                    <Arrow direction={f.direction} />
                  </span>
                  <span>
                    {f.factor} — <span className="text-on-surface-variant/70">{f.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {data.recent_changes.length > 0 && (
            <div className="rounded-lg bg-surface-container-low border border-outline-variant px-3 py-2">
              {data.recent_changes.map((c, i) => (
                <p key={i} className="text-[11px] text-on-surface-variant">· {c}</p>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ---- Baseline vs current ---- */}
      {data.available && data.comparison.length > 0 && (
        <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
          <h2 className="text-sm font-semibold text-on-surface mb-3">
            Your baseline vs now
          </h2>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.comparison} margin={{ left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="dimension" tick={{ fill: "#64748b", fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#64748b", fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="baseline" name="Baseline" fill="#cbd5e1" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="current" name="Current" fill={CHART.purple} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[10px] text-on-surface-variant/70 mt-2">
            Compared only with your own history — never with another person.
          </p>
        </section>
      )}

      {/* ---- Face / Voice / Text contribution ---- */}
      {data.available && Object.keys(data.modalities ?? {}).length > 0 && (
        <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
          <h2 className="text-sm font-semibold text-on-surface mb-1">Face / Voice / Text contribution</h2>
          <p className="text-[11px] text-on-surface-variant mb-3">
            Each modality's confidence toward this assessment.
          </p>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={Object.entries(data.modalities).map(([modality, m]) => ({
                  modality: modality.charAt(0).toUpperCase() + modality.slice(1),
                  confidence: m.available ? m.confidence ?? 0 : 0,
                  available: m.available,
                }))}
                margin={{ left: -20 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="modality" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fill: "#64748b", fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="confidence" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {Object.entries(data.modalities).map(([modality]) => (
                    <Cell
                      key={modality}
                      fill={
                        { face: CHART.purple, voice: CHART.teal, text: CHART.blue }[modality.toLowerCase()] ??
                        CHART.purple
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            {Object.entries(data.modalities).map(([modality, m]) => (
              <span key={modality} className="text-[10px] text-on-surface-variant">
                <span className="capitalize font-medium text-on-surface-variant">{modality}</span>:{" "}
                {m.available ? `${m.observations} observation${m.observations === 1 ? "" : "s"}` : m.note || "Insufficient signal"}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ---- Risk level distribution (last 7 days) ---- */}
      {history?.available && history.points.length > 0 && (
        <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
          <h2 className="text-sm font-semibold text-on-surface mb-1">Risk level distribution</h2>
          <p className="text-[11px] text-on-surface-variant mb-3">Days at each level, last {history.points.length} days.</p>
          <div className="flex items-center gap-4">
            <div className="h-36 w-36 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={(["GREEN", "AMBER", "RED"] as const)
                      .map((band) => ({
                        band,
                        count: history.points.filter((p) => p.band === band).length,
                      }))
                      .filter((d) => d.count > 0)}
                    dataKey="count"
                    nameKey="band"
                    innerRadius={35}
                    outerRadius={55}
                    isAnimationActive={false}
                  >
                    {(["GREEN", "AMBER", "RED"] as const).map((band) => (
                      <Cell key={band} fill={BAND_COLOR[band]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-1.5">
              {(["GREEN", "AMBER", "RED"] as const).map((band) => {
                const count = history.points.filter((p) => p.band === band).length
                return (
                  <div key={band} className="flex items-center gap-2 text-xs">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: BAND_COLOR[band] }} />
                    <span className="text-on-surface-variant w-16">{BAND_LABEL[band]}</span>
                    <span className="text-on-surface-variant/70 tabular-nums">{count} day{count === 1 ? "" : "s"}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      )}

      {/* ---- Consistency ---- */}
      <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
        <h2 className="text-sm font-semibold text-on-surface mb-2">Signal consistency</h2>
        {data.consistency.available ? (
          <>
            <div className="flex flex-wrap gap-3 mb-2">
              {Object.entries(data.consistency.directions ?? {}).map(([mod, dir]) => (
                <span key={mod} className="flex items-center gap-1.5 text-xs">
                  <span className="text-on-surface-variant capitalize">{mod}</span>
                  <Arrow direction={dir === "flat" ? "neutral" : dir} />
                </span>
              ))}
            </div>
            <p
              className={`text-xs ${
                data.consistency.consistent ? "text-on-secondary-container" : "text-amber-700"
              }`}
            >
              {data.consistency.label}
            </p>
          </>
        ) : (
          <p className="text-xs text-on-surface-variant">{data.consistency.reason}</p>
        )}
      </section>

      {/* ---- 7-day graph ---- */}
      <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
        <h2 className="text-sm font-semibold text-on-surface mb-3">7-Day Timeline</h2>
        {!history?.available ? (
          <p className="text-xs text-on-surface-variant py-8 text-center">
            {history?.reason ?? "Baseline building..."}
          </p>
        ) : (
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history.points}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={30}
                />
                <Tooltip
                  contentStyle={{
                    background: "#ffffff",
                    border: "1px solid #cbd5e1",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <ReferenceLine y={30} stroke="#a7f3d0" strokeDasharray="4 4" />
                <ReferenceLine y={60} stroke="#fcd34d" strokeDasharray="4 4" />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#7c3aed"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* ---- Human review ---- */}
      {data.available && data.human_review_required && (
        <section className="rounded-xl bg-primary-container/10 border border-primary/20 p-5">
          <h2 className="text-sm font-semibold text-on-surface">
            Your recent pattern has changed.
          </h2>
          <p className="text-xs text-on-surface-variant mt-1 mb-3">
            Would you like support? Nothing happens automatically — this is your choice.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => act("support_requested", "Support request")}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:bg-primary-fixed-dim text-on-primary text-sm font-semibold"
            >
              <HandHeart size={15} />
              Request Support
            </button>
            <button
              onClick={() => act("continue_monitoring", "Continue monitoring")}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-outline-variant text-on-surface-variant hover:bg-surface-container-lowest text-sm"
            >
              <Eye size={15} />
              Continue Monitoring
            </button>
          </div>
        </section>
      )}

      {/* ---- Safety ---- */}
      <section className="rounded-xl bg-surface-container-high border border-outline-variant p-4 flex items-start gap-2">
        <ShieldCheck size={13} className="text-on-surface-variant mt-0.5 shrink-0" />
        <div className="text-[11px] text-on-surface-variant space-y-1">
          <p>{data.escalation_note ?? "Alerts stay inside the authorised dashboard."}</p>
          {data.limitations?.map((l, i) => (
            <p key={i} className="text-on-surface-variant/80">· {l}</p>
          ))}
        </div>
      </section>
    </div>
  )
}
