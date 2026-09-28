import { useCallback, useEffect, useMemo, useState } from "react"
import { Trash2, Download } from "lucide-react"
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts"
import { CHART, CHART_AXIS_TICK, CHART_TOOLTIP_STYLE } from "../lib/chartColors"
import {
  BaselineQuestion,
  CheckinEntry,
  ConsentScope,
  PrivacyInfo,
  TrendsResponse,
  TwinView,
  deleteAllTwinData,
  exportTwinData,
  fetchBaselineQuestions,
  fetchCheckins,
  fetchPrivacy,
  fetchTwinTrends,
  fetchTwinView,
  setConsent,
  submitBaseline,
  submitCheckin,
} from "../lib/twinApi"

export type Tab = "overview" | "baseline" | "checkin" | "trends" | "privacy"

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "baseline", label: "Build My Baseline" },
  { key: "checkin", label: "Check-in" },
  { key: "trends", label: "Trends" },
  { key: "privacy", label: "Privacy" },
]

const CONSENT_LABELS: Record<ConsentScope, string> = {
  baseline: "Store my baseline answers",
  checkins: "Store my daily check-ins",
  emotion_signals: "Store derived signals from camera/voice sessions",
  session_history: "Keep past sessions so trends can be shown",
  companion_care: "Store Companion daily-care actions (feed/water/activity)",
}

function ConfidenceDots({ filled }: { filled: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`Confidence ${filled} of 5`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={`w-2 h-2 rounded-full ${i < filled ? "bg-primary" : "bg-outline-variant"}`} />
      ))}
    </span>
  )
}

function StatusRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-surface-container-high last:border-0">
      <span className="text-label-sm text-on-surface-variant">{label}</span>
      <span className={`text-label-sm font-medium ${muted ? "text-on-surface-variant/60" : "text-on-surface"}`}>
        {value}
      </span>
    </div>
  )
}

function Slider({
  question,
  value,
  onChange,
}: {
  question: BaselineQuestion
  value: number | undefined
  onChange: (v: number) => void
}) {
  return (
    <div className="py-3 border-b border-surface-container-high last:border-0">
      <label className="block text-body-md text-on-surface mb-2">{question.prompt}</label>
      <input
        type="range"
        min={0}
        max={10}
        step={1}
        value={value ?? 5}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
      <div className="flex justify-between text-label-sm text-on-surface-variant mt-0.5">
        <span>{question.low}</span>
        <span className="text-on-surface font-medium">{value ?? "—"}</span>
        <span>{question.high}</span>
      </div>
    </div>
  )
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 54

/** The single largest visual on the page - baseline confidence is the
 * anchor score everything else on this dashboard is compared against. */
function BaselineRing({ percent }: { percent: number }) {
  const offset = RING_CIRCUMFERENCE * (1 - percent / 100)
  return (
    <div className="flex-grow flex items-center justify-center relative">
      <svg className="w-64 h-64 transform -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" fill="none" r="54" stroke="#f3f4f5" strokeWidth="9" />
        <circle
          cx="60"
          cy="60"
          fill="none"
          r="54"
          stroke={CHART.purple}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          strokeLinecap="round"
          strokeWidth="9"
          className="transition-all duration-1000 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[64px] font-bold text-primary leading-none tracking-tight">
          {Math.round(percent)}
        </span>
        <span className="text-label-md text-on-surface-variant mt-1">/100</span>
      </div>
    </div>
  )
}

/** Reused wherever a chart/card has too little real data to show honestly -
 * never a placeholder chart with invented values. */
function NotEnoughData({ label = "Not enough data yet." }: { label?: string }) {
  return (
    <div className="flex-grow flex items-center justify-center text-center py-10">
      <p className="text-label-md text-on-surface-variant">{label}</p>
    </div>
  )
}

function relativeDay(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  if (sameDay) return `Today, ${time}`
  if (isYesterday) return `Yesterday, ${time}`
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`
}

const MODALITY_LABEL: Record<string, string> = { face: "Face", voice: "Voice", text: "Text" }

/** Personal Baseline + Distress/Mood trends + signal status + activity
 * charts + Recent Check-ins + Suggested Activities - built entirely from
 * real stored data. Every chart shows "Not enough data yet" rather than any
 * invented value when there isn't enough real data to plot. */
function OverviewBento({
  view,
  trends,
  checkins,
  onOpenCompanion,
}: {
  view: TwinView
  trends: TrendsResponse | null
  checkins: CheckinEntry[]
  onOpenCompanion?: () => void
}) {
  const [distressWindow, setDistressWindow] = useState<7 | 30>(7)

  const distressSeries = (trends?.series.self_report ?? []).slice(-distressWindow)
  const moodSeries = (trends?.series.sentiment_negative ?? []).slice(-14)

  // Last 14 real calendar days, each paired with the actual check-ins (if
  // any) whose created_at falls on that day - zero is a real "no check-in
  // that day," never a fabricated count.
  const checkinActivity = useMemo(() => {
    const days: { date: string; count: number }[] = []
    const now = new Date()
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(now.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      const count = checkins.filter((c) => !c.skipped && c.created_at?.slice(0, 10) === key).length
      days.push({ date: key.slice(5), count })
    }
    return days
  }, [checkins])

  const engagement = view.engagement
  const weeklyCompletionPct =
    engagement.expected_last_7d > 0
      ? Math.min(100, Math.round((engagement.checkins_last_7d / engagement.expected_last_7d) * 100))
      : null

  const modalityEntries = Object.entries(view.modality_status ?? {})

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-gutter">
      {/* Personal Baseline - the largest score on the page */}
      <div className="col-span-1 md:col-span-5 bg-surface-container-lowest rounded-[24px] p-stack-md card-shadow flex flex-col justify-between min-h-[380px]">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-headline-md text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">monitor_heart</span>
              Personal Baseline
            </h2>
            <p className="text-body-md text-on-surface-variant mt-1">{view.baseline.confidence_label}</p>
          </div>
          <span className="bg-secondary-container/20 text-secondary text-label-sm px-3 py-1 rounded-full">
            {view.baseline.status_label}
          </span>
        </div>
        {view.baseline.status === "ready" ? (
          <BaselineRing percent={view.baseline.confidence} />
        ) : (
          <div className="flex-grow flex flex-col items-center justify-center text-center gap-2">
            <ConfidenceDots filled={view.baseline.confidence_dots} />
            <p className="text-body-md text-on-surface-variant">
              {view.baseline.checkins_needed > 0
                ? `${view.baseline.checkins_needed} more check-in${
                    view.baseline.checkins_needed === 1 ? "" : "s"
                  } to establish your baseline.`
                : "Baseline building…"}
            </p>
          </div>
        )}
      </div>

      {/* Wellbeing trend - 7d / 30d toggle over the real self-report series (higher is better) */}
      <div className="col-span-1 md:col-span-7 bg-surface-container-lowest rounded-[24px] p-stack-md card-shadow flex flex-col min-h-[380px]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-headline-md text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">show_chart</span>
            Wellbeing Trend
          </h2>
          <div className="flex gap-1 bg-surface-container-low rounded-full p-0.5">
            {([7, 30] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDistressWindow(d)}
                className={`px-3 py-1 rounded-full text-label-sm transition-colors ${
                  distressWindow === d ? "bg-primary text-on-primary" : "text-on-surface-variant"
                }`}
              >
                {d}D
              </button>
            ))}
          </div>
        </div>
        {distressSeries.length < 2 ? (
          <NotEnoughData />
        ) : (
          <div className="flex-grow h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={distressSeries}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                <XAxis dataKey="date" tick={CHART_AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis tick={CHART_AXIS_TICK} axisLine={false} tickLine={false} width={32} />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={CHART.purple}
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Mood/emotion trend - negative-sentiment series over recent check-ins */}
      <div className="col-span-1 md:col-span-6 bg-surface-container-lowest rounded-[24px] p-stack-md card-shadow flex flex-col min-h-[280px]">
        <h2 className="text-headline-md text-on-surface flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-secondary">mood</span>
          Negative Sentiment
        </h2>
        {moodSeries.length < 2 ? (
          <NotEnoughData />
        ) : (
          <div className="flex-grow h-40">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={moodSeries}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                <XAxis dataKey="date" tick={CHART_AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis tick={CHART_AXIS_TICK} axisLine={false} tickLine={false} width={32} />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={CHART.teal}
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Face / Voice / Text signal status */}
      <div className="col-span-1 md:col-span-6 bg-surface-container-lowest rounded-[24px] p-stack-md card-shadow flex flex-col min-h-[280px]">
        <h2 className="text-headline-md text-on-surface flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-tertiary">merge</span>
          Face · Voice · Text Signal
        </h2>
        {modalityEntries.length === 0 ? (
          <NotEnoughData />
        ) : (
          <div className="flex-grow flex flex-col justify-center gap-3">
            {modalityEntries.map(([key, status]) => {
              const available = status === "available"
              return (
                <div key={key} className="flex items-center gap-3">
                  <span className="w-14 text-label-sm text-on-surface-variant shrink-0">
                    {MODALITY_LABEL[key] ?? key}
                  </span>
                  <div className="flex-1 h-2.5 rounded-full bg-surface-container-low overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: available ? "100%" : "22%",
                        background: available ? CHART.teal : CHART.axis,
                        opacity: available ? 1 : 0.4,
                      }}
                    />
                  </div>
                  <span
                    className={`text-label-sm shrink-0 ${available ? "text-secondary" : "text-on-surface-variant/60"}`}
                  >
                    {available ? "Available" : "Insufficient"}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Check-in activity - real daily counts over the last 14 days */}
      <div className="col-span-1 md:col-span-6 bg-surface-container-lowest rounded-[24px] p-stack-md card-shadow flex flex-col min-h-[240px]">
        <h2 className="text-headline-md text-on-surface flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-primary">fact_check</span>
          Check-in Activity
        </h2>
        {checkins.length === 0 ? (
          <NotEnoughData />
        ) : (
          <div className="flex-grow h-32">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={checkinActivity}>
                <XAxis dataKey="date" tick={CHART_AXIS_TICK} axisLine={false} tickLine={false} interval={1} />
                <YAxis hide allowDecimals={false} />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                <Bar dataKey="count" fill={CHART.purple} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Weekly activity completion - real check-ins vs. expected this week */}
      <div className="col-span-1 md:col-span-6 bg-surface-container-lowest rounded-[24px] p-stack-md card-shadow flex flex-col justify-center min-h-[240px]">
        <h2 className="text-headline-md text-on-surface flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-secondary">calendar_month</span>
          Weekly Activity Completion
        </h2>
        {weeklyCompletionPct === null ? (
          <NotEnoughData />
        ) : (
          <div className="flex items-center gap-5">
            <div className="relative w-20 h-20 shrink-0">
              <svg className="w-20 h-20 transform -rotate-90" viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="17" fill="none" stroke="#f3f4f5" strokeWidth="5" />
                <circle
                  cx="20"
                  cy="20"
                  r="17"
                  fill="none"
                  stroke={CHART.teal}
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 17}
                  strokeDashoffset={2 * Math.PI * 17 * (1 - weeklyCompletionPct / 100)}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center text-label-md font-semibold text-secondary">
                {weeklyCompletionPct}%
              </div>
            </div>
            <div>
              <p className="text-body-md text-on-surface">
                {engagement.checkins_last_7d} of {engagement.expected_last_7d} expected check-ins
              </p>
              <p className="text-label-sm text-on-surface-variant mt-0.5">
                {engagement.checkin_streak > 0
                  ? `${engagement.checkin_streak}-day streak`
                  : "No active streak"}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Recent Check-ins */}
      <div className="col-span-1 md:col-span-6 bg-surface-container-lowest rounded-[24px] p-stack-md card-shadow">
        <h2 className="text-headline-md text-on-surface flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-secondary">history</span>
          Recent Check-ins
        </h2>
        {checkins.length === 0 ? (
          <p className="text-label-md text-on-surface-variant">No check-ins recorded yet.</p>
        ) : (
          <div className="space-y-3">
            {checkins.slice(-4).reverse().map((c) => (
              <div key={c.id} className="flex items-center justify-between p-4 bg-surface-container-low rounded-xl">
                <div className="flex items-center gap-4">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center ${
                      c.skipped
                        ? "bg-surface-variant text-on-surface-variant"
                        : "bg-secondary-container text-on-secondary-container"
                    }`}
                  >
                    <span className="material-symbols-outlined">{c.skipped ? "remove" : "mood"}</span>
                  </div>
                  <div>
                    <p className="text-label-md text-on-surface">{c.skipped ? "Skipped check-in" : "Check-in"}</p>
                    <p className="text-label-sm text-on-surface-variant">{relativeDay(c.created_at)}</p>
                  </div>
                </div>
                <span className="text-on-surface-variant text-label-md">{c.skipped ? "—" : "Logged"}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Suggested Activities - kept compact */}
      <div className="col-span-1 md:col-span-6 bg-surface-container-lowest rounded-[24px] p-stack-md card-shadow">
        <h2 className="text-headline-md text-on-surface flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-primary">local_activity</span>
          Suggested Activities
        </h2>
        <div className="grid grid-cols-2 gap-3">
          {[
            { icon: "self_improvement", label: "Mindful Breathing" },
            { icon: "directions_walk", label: "Short Walk" },
          ].map((a) => (
            <button
              key={a.label}
              onClick={onOpenCompanion}
              className="p-3 border border-outline-variant rounded-xl hover:border-primary transition-colors text-center group"
            >
              <span className="material-symbols-outlined text-2xl text-on-surface-variant group-hover:text-primary transition-colors mb-1 block">
                {a.icon}
              </span>
              <p className="text-label-sm text-on-surface">{a.label}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="md:col-span-12 rounded-[24px] bg-surface-container-low border border-outline-variant p-4 flex items-start gap-2">
        <span className="material-symbols-outlined text-on-surface-variant text-[16px] mt-0.5 shrink-0">info</span>
        <p className="text-label-sm text-on-surface-variant">{view.safety_note}</p>
      </div>
    </div>
  )
}

export default function MyWellbeing({
  onOpenCompanion,
  initialTab = "overview",
}: {
  onOpenCompanion?: () => void
  initialTab?: Tab
}) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [view, setView] = useState<TwinView | null>(null)
  const [trends, setTrends] = useState<TrendsResponse | null>(null)
  const [privacy, setPrivacy] = useState<PrivacyInfo | null>(null)
  const [checkins, setCheckins] = useState<CheckinEntry[]>([])
  const [questions, setQuestions] = useState<BaselineQuestion[]>([])
  const [answers, setAnswers] = useState<Record<string, number | string>>({})
  const [checkinValues, setCheckinValues] = useState<Record<string, number>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const reload = useCallback(async () => {
    const [v, t, p, c] = await Promise.all([
      fetchTwinView(),
      fetchTwinTrends(),
      fetchPrivacy(),
      fetchCheckins(30),
    ])
    setView(v)
    setTrends(t)
    setPrivacy(p)
    setCheckins(c?.checkins ?? [])
  }, [])

  useEffect(() => {
    reload()
    fetchBaselineQuestions().then((q) => q && setQuestions(q.questions))
  }, [reload])

  const toggleConsent = async (scope: ConsentScope, granted: boolean) => {
    await setConsent(scope, granted)
    reload()
  }

  const saveBaseline = async () => {
    const res = await submitBaseline(answers)
    setMessage(
      res.success
        ? "Baseline saved. It will strengthen as you complete more check-ins."
        : res.error ?? "Could not save."
    )
    reload()
  }

  const saveCheckin = async (skipped = false) => {
    const res = await submitCheckin(skipped ? { skipped: true } : checkinValues)
    setMessage(
      res.success
        ? skipped
          ? "Check-in skipped. That's completely fine."
          : "Check-in saved. Thank you."
        : res.error ?? "Could not save."
    )
    setCheckinValues({})
    reload()
  }

  const consent = view?.consent

  return (
    <div className="space-y-stack-sm">
      <div>
        <h1 className="text-display-lg-mobile text-on-surface">Well-being Overview</h1>
        <p className="text-body-lg text-on-surface-variant mt-1">
          Changes in the signals you've chosen to share, compared with your own pattern.
        </p>
      </div>

      <div className="flex gap-1 border-b border-outline-variant overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-label-md whitespace-nowrap -mb-px border-b-2 ${
              tab === t.key
                ? "border-primary text-primary font-bold"
                : "border-transparent text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {message && (
        <div className="rounded-xl bg-primary-container/10 border border-primary/20 px-4 py-2.5 text-label-md text-primary">
          {message}
        </div>
      )}

      {tab === "overview" && view && (
        <OverviewBento view={view} trends={trends} checkins={checkins} onOpenCompanion={onOpenCompanion} />
      )}

      {/* ---------------- Baseline ---------------- */}
      {tab === "baseline" && (
        <section className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow">
          <h2 className="flex items-center gap-2 text-headline-md text-on-surface">
            <span className="material-symbols-outlined text-primary">assignment</span>
            Build My Baseline
          </h2>
          <p className="text-label-md text-on-surface-variant mt-1 mb-3">
            A few questions about what's normal for you. Answer only what you'd like to.
          </p>

          {!consent?.baseline ? (
            <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
              <p className="text-label-sm text-amber-800 mb-2">
                To save your baseline, we need your consent to store these answers.
              </p>
              <button
                onClick={() => toggleConsent("baseline", true)}
                className="px-3 py-1.5 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary text-label-sm font-semibold"
              >
                I consent to storing my baseline answers
              </button>
            </div>
          ) : (
            <>
              {questions.map((q) =>
                q.type === "slider" ? (
                  <Slider
                    key={q.id}
                    question={q}
                    value={answers[q.id] as number | undefined}
                    onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
                  />
                ) : (
                  <div key={q.id} className="py-3">
                    <label className="block text-body-md text-on-surface mb-2">{q.prompt}</label>
                    <div className="flex flex-wrap gap-2">
                      {q.options?.map((opt) => (
                        <button
                          key={opt}
                          onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                          className={`px-3 py-1.5 rounded-full text-label-sm border ${
                            answers[q.id] === opt
                              ? "bg-primary border-primary text-on-primary"
                              : "border-outline-variant text-on-surface-variant hover:bg-surface-container-low"
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              )}
              <button
                onClick={saveBaseline}
                disabled={Object.keys(answers).length === 0}
                className="mt-4 px-4 py-2 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary text-label-md font-semibold disabled:opacity-40"
              >
                Save my baseline
              </button>
              <p className="text-label-sm text-on-surface-variant mt-2">
                These answers describe your normal. They are not a health assessment.
              </p>
            </>
          )}
        </section>
      )}

      {/* ---------------- Check-in ---------------- */}
      {tab === "checkin" && (
        <section className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow">
          <h2 className="text-headline-md text-on-surface">Today's Check-in</h2>
          <p className="text-label-md text-on-surface-variant mt-1 mb-3">
            Whenever you're ready. You can skip anything you'd rather not answer.
          </p>

          {!consent?.checkins ? (
            <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
              <p className="text-label-sm text-amber-800 mb-2">
                To save check-ins, we need your consent to store them.
              </p>
              <button
                onClick={() => toggleConsent("checkins", true)}
                className="px-3 py-1.5 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary text-label-sm font-semibold"
              >
                I consent to storing my check-ins
              </button>
            </div>
          ) : (
            <>
              {questions
                .filter((q) => q.type === "slider")
                .map((q) => (
                  <Slider
                    key={q.id}
                    question={{ ...q, prompt: q.prompt.replace("usually", "today") }}
                    value={checkinValues[q.id]}
                    onChange={(v) => setCheckinValues((c) => ({ ...c, [q.id]: v }))}
                  />
                ))}
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => saveCheckin(false)}
                  disabled={Object.keys(checkinValues).length === 0}
                  className="px-4 py-2 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary text-label-md font-semibold disabled:opacity-40"
                >
                  Save check-in
                </button>
                <button
                  onClick={() => saveCheckin(true)}
                  className="px-4 py-2 rounded-full border border-outline-variant text-on-surface-variant hover:bg-surface-container-low text-label-md"
                >
                  Skip today
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {/* ---------------- Trends ---------------- */}
      {tab === "trends" && trends && (
        <div className="space-y-stack-sm">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Object.entries(trends.windows).map(([name, w]) => (
              <div key={name} className="rounded-[20px] bg-surface-container-lowest border border-outline-variant p-4 card-shadow">
                <div className="text-label-sm uppercase tracking-wide text-on-surface-variant">
                  {name === "7d" ? "7 Days" : name === "30d" ? "30 Days" : name}
                </div>
                <div className="text-headline-md text-on-surface mt-0.5">
                  {w.self_report.available ? w.self_report.value?.toFixed(1) : "—"}
                </div>
                <div className="text-label-sm text-on-surface-variant/70">
                  {w.self_report.available ? `${w.checkin_count} check-in(s)` : "Not enough information yet."}
                </div>
              </div>
            ))}
          </div>

          {(
            [
              ["self_report", "Self-reported well-being", CHART.purple],
              ["sentiment_negative", "Negative sentiment", CHART.teal],
              ["engagement", "Check-ins per day", CHART.blue],
            ] as const
          ).map(([key, label, color]) => {
            const series = trends.series[key] ?? []
            return (
              <section key={key} className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow">
                <h3 className="text-headline-md text-on-surface mb-2">{label}</h3>
                {series.length < 2 ? (
                  <p className="text-label-md text-on-surface-variant py-6 text-center">Not enough information yet.</p>
                ) : (
                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={series}>
                        <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                        <XAxis dataKey="date" tick={CHART_AXIS_TICK} axisLine={false} tickLine={false} />
                        <YAxis tick={CHART_AXIS_TICK} axisLine={false} tickLine={false} width={32} />
                        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </section>
            )
          })}
          <p className="text-label-sm text-on-surface-variant">{trends.note}</p>
        </div>
      )}

      {/* ---------------- Privacy ---------------- */}
      {tab === "privacy" && privacy && (
        <div className="space-y-stack-sm">
          <section className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow">
            <h2 className="flex items-center gap-2 text-headline-md text-on-surface mb-3">
              <span className="material-symbols-outlined text-primary">verified_user</span>
              Consent
            </h2>
            {(Object.keys(CONSENT_LABELS) as ConsentScope[]).map((scope) => (
              <label
                key={scope}
                className="flex items-center justify-between py-2 border-b border-surface-container-high last:border-0 cursor-pointer"
              >
                <span className="text-label-md text-on-surface">{CONSENT_LABELS[scope]}</span>
                <input
                  type="checkbox"
                  checked={privacy.consent[scope]}
                  onChange={(e) => toggleConsent(scope, e.target.checked)}
                  className="accent-primary w-4 h-4"
                />
              </label>
            ))}
            <p className="text-label-sm text-on-surface-variant mt-2">
              You can withdraw any of these at any time. Withdrawing stops new data being stored immediately.
            </p>
          </section>

          <section className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow">
            <h2 className="text-headline-md text-on-surface mb-3">What is stored</h2>
            <StatusRow label="Check-ins" value={String(privacy.stored.checkins)} />
            <StatusRow label="Session signals" value={String(privacy.stored.signal_observations)} />
            <StatusRow label="Baseline submissions" value={String(privacy.stored.baseline_submissions)} />
            <StatusRow label="Camera video / frames" value="Never stored" muted />
            <StatusRow label="Microphone audio" value="Never stored" muted />
            <StatusRow label="Transcript text" value="Never stored" muted />

            <div className="mt-3 pt-3 border-t border-outline-variant">
              <p className="text-label-sm text-on-surface-variant mb-1">
                <span className="font-medium text-on-surface">Why:</span> {privacy.why}
              </p>
              <p className="text-label-sm text-on-surface-variant">
                <span className="font-medium text-on-surface">Who can access it:</span> {privacy.who_can_access}
              </p>
            </div>
          </section>

          <section className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow">
            <h2 className="text-headline-md text-on-surface mb-3">Your data</h2>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={async () => {
                  const data = await exportTwinData()
                  const blob = new Blob([JSON.stringify(data.export, null, 2)], { type: "application/json" })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement("a")
                  a.href = url
                  a.download = "aura-my-wellbeing-export.json"
                  a.click()
                  URL.revokeObjectURL(url)
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-outline-variant text-label-sm text-on-surface-variant hover:bg-surface-container-low"
              >
                <Download size={13} />
                Export my data
              </button>
              <button
                onClick={async () => {
                  if (!confirmDelete) {
                    setConfirmDelete(true)
                    return
                  }
                  await deleteAllTwinData()
                  setConfirmDelete(false)
                  setMessage("All of your well-being data has been permanently deleted.")
                  reload()
                }}
                onBlur={() => setConfirmDelete(false)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-label-sm font-medium ${
                  confirmDelete
                    ? "border-error/40 bg-error-container text-on-error-container"
                    : "border-outline-variant text-on-surface-variant hover:bg-surface-container-low"
                }`}
              >
                <Trash2 size={13} />
                {confirmDelete ? "Confirm permanent deletion" : "Delete all my data"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
