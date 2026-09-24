import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Dot,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts"

/** Shared tooltip chrome - glassmorphic, glowing accent bar matching the
 * series colour, consistent across every chart in the professional
 * dashboards instead of Recharts' default white box. */
function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number | string; color?: string }[]; label?: string }) {
  if (!active || !payload || payload.length === 0) return null
  const accent = payload[0]?.color ?? "var(--color-primary)"
  return (
    <div
      className="rounded-xl aura-glass-strong border border-[var(--color-hairline)] px-3.5 py-2.5 shadow-2xl text-label-sm backdrop-blur-xl overflow-hidden relative"
      style={{ boxShadow: `0 0 24px -6px ${accent}` }}
    >
      <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: accent, boxShadow: `0 0 8px ${accent}` }} />
      {label && <p className="text-on-surface-variant/70 mb-1 pl-1">{label}</p>}
      {payload.map((p, i) => (
        <p key={i} className="text-on-surface font-semibold pl-1 tabular-nums" style={{ color: p.color }}>
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  )
}

/** SVG defs shared by every chart on the page: gradient fills + a soft glow
 * filter, keyed by risk band and by the two generic accent gradients (used
 * for engagement/stage charts that aren't risk-banded). Rendered once,
 * referenced by id from any chart below - this is what turns a flat filled
 * bar/slice into a glowing, depth-shaded one. */
function ChartDefs() {
  return (
    <defs>
      <linearGradient id="gradGreen" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="var(--color-secondary)" stopOpacity={1} />
        <stop offset="100%" stopColor="var(--color-secondary)" stopOpacity={0.35} />
      </linearGradient>
      <linearGradient id="gradAmber" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="var(--color-glow-amber, var(--color-primary))" stopOpacity={1} />
        <stop offset="100%" stopColor="var(--color-glow-amber, var(--color-primary))" stopOpacity={0.35} />
      </linearGradient>
      <linearGradient id="gradRed" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="var(--color-error)" stopOpacity={1} />
        <stop offset="100%" stopColor="var(--color-error)" stopOpacity={0.35} />
      </linearGradient>
      <linearGradient id="gradPrimary" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={1} />
        <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0.3} />
      </linearGradient>
      <linearGradient id="gradTertiary" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="var(--color-tertiary)" stopOpacity={1} />
        <stop offset="100%" stopColor="var(--color-tertiary)" stopOpacity={0.3} />
      </linearGradient>
      <filter id="chartGlow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="4.5" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  )
}

const BAND_COLOR: Record<string, string> = {
  GREEN: "var(--color-secondary)",
  AMBER: "var(--color-glow-amber, var(--color-primary))",
  RED: "var(--color-error)",
}
const BAND_GRADIENT: Record<string, string> = {
  GREEN: "url(#gradGreen)",
  AMBER: "url(#gradAmber)",
  RED: "url(#gradRed)",
}

const GRID_PROPS = {
  strokeDasharray: "3 6",
  stroke: "var(--color-hairline, var(--color-outline-variant))",
  strokeOpacity: 0.35,
  vertical: false,
} as const

/** Real case-count-by-risk-band composition - fed directly from
 * CaseQueue.summary, never a fabricated distribution. Glowing ring with the
 * total centred inside it. */
export function RiskDistributionChart({ green, amber, red }: { green: number; amber: number; red: number }) {
  const data = [
    { name: "Green", value: green, band: "GREEN" },
    { name: "Amber", value: amber, band: "AMBER" },
    { name: "Red", value: red, band: "RED" },
  ].filter((d) => d.value > 0)
  const total = green + amber + red

  if (data.length === 0) {
    return <p className="text-label-sm text-on-surface-variant/60 py-6 text-center">No classified cases yet.</p>
  }

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={180}>
        <PieChart>
          <ChartDefs />
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={48}
            outerRadius={72}
            paddingAngle={3}
            cornerRadius={6}
            isAnimationActive
            animationDuration={700}
          >
            {data.map((d) => (
              <Cell key={d.band} fill={BAND_COLOR[d.band]} stroke={BAND_COLOR[d.band]} strokeWidth={1} filter="url(#chartGlow)" />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-headline-md font-bold text-on-surface tabular-nums leading-none">{total}</span>
        <span className="text-label-sm text-on-surface-variant/60 mt-0.5">total</span>
      </div>
    </div>
  )
}

/** One real bar per case, height = its actual risk score, colour = its
 * actual risk band, gradient-filled and glowing. Click a bar to open that
 * case (e.g. in the right intelligence panel) - never a synthetic score. */
export function CaseRiskBarChart({
  cases,
  onSelect,
}: {
  cases: { aura_id: string; risk_score: number; risk_band: string }[]
  onSelect?: (auraId: string) => void
}) {
  const data = [...cases].sort((a, b) => b.risk_score - a.risk_score).slice(0, 12)
  if (data.length === 0) {
    return <p className="text-label-sm text-on-surface-variant/60 py-6 text-center">No cases to show.</p>
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <ChartDefs />
        <CartesianGrid {...GRID_PROPS} />
        <XAxis dataKey="aura_id" tick={{ fontSize: 10, fill: "var(--color-on-surface-variant)" }} tickFormatter={(v: string) => v.replace("AURA-", "")} interval={0} angle={-35} textAnchor="end" height={50} axisLine={{ stroke: "var(--color-hairline, var(--color-outline-variant))" }} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: "var(--color-on-surface-variant)" }} domain={[0, 100]} axisLine={false} tickLine={false} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-primary)", opacity: 0.06 }} />
        <Bar
          dataKey="risk_score"
          name="Risk score"
          radius={[6, 6, 2, 2]}
          maxBarSize={36}
          isAnimationActive
          animationDuration={600}
          onClick={(d: unknown) => {
            // Recharts' onClick payload type doesn't declare our custom data
            // fields, but the row's own fields (aura_id) are present on it
            // at runtime - confirmed via a real click during verification.
            const row = d as { aura_id?: string; payload?: { aura_id?: string } }
            const auraId = row?.aura_id ?? row?.payload?.aura_id
            if (auraId) onSelect?.(auraId)
          }}
          cursor={onSelect ? "pointer" : "default"}
        >
          {data.map((d) => (
            <Cell key={d.aura_id} fill={BAND_GRADIENT[d.risk_band] ?? "url(#gradPrimary)"} stroke={BAND_COLOR[d.risk_band] ?? "var(--color-primary)"} strokeWidth={1} filter="url(#chartGlow)" />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Real 7-day check-in engagement per case (CaseRow.checkins_last_7d) -
 * shows who is actually engaging vs going quiet, not a synthetic trend. */
export function EngagementBarChart({ cases }: { cases: { aura_id: string; checkins_last_7d: number }[] }) {
  const data = [...cases].sort((a, b) => a.checkins_last_7d - b.checkins_last_7d).slice(0, 12)
  if (data.length === 0) {
    return <p className="text-label-sm text-on-surface-variant/60 py-6 text-center">No engagement data yet.</p>
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <ChartDefs />
        <CartesianGrid {...GRID_PROPS} />
        <XAxis dataKey="aura_id" tick={{ fontSize: 10, fill: "var(--color-on-surface-variant)" }} tickFormatter={(v: string) => v.replace("AURA-", "")} interval={0} angle={-35} textAnchor="end" height={50} axisLine={{ stroke: "var(--color-hairline, var(--color-outline-variant))" }} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: "var(--color-on-surface-variant)" }} allowDecimals={false} axisLine={false} tickLine={false} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-tertiary)", opacity: 0.06 }} />
        <Bar dataKey="checkins_last_7d" name="Check-ins (7d)" fill="url(#gradTertiary)" stroke="var(--color-tertiary)" strokeWidth={1} filter="url(#chartGlow)" radius={[6, 6, 2, 2]} maxBarSize={36} isAnimationActive animationDuration={600} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Case landscape: every axis is a real, already-tracked field - x =
 * check-ins in the last 7 days (engagement), y = 100 - risk_score
 * (wellbeing, so "up" reads as "better"), bubble size = total recorded
 * check-ins + sessions (activity volume), colour = current risk band. No
 * synthetic axis - this is the same CaseRow data every other chart on this
 * page reads, just plotted as a scatter instead of bars. */
export function CaseLandscapeChart({
  cases,
  onSelect,
}: {
  cases: { aura_id: string; risk_score: number; risk_band: string; checkins_last_7d: number; counts: { checkins: number; sessions: number } }[]
  onSelect?: (auraId: string) => void
}) {
  if (cases.length === 0) {
    return <p className="text-label-sm text-on-surface-variant/60 py-6 text-center">No cases to show.</p>
  }
  const data = cases.map((c) => ({
    aura_id: c.aura_id,
    engagement: c.checkins_last_7d,
    wellbeing: Math.round(100 - c.risk_score),
    activity: Math.max(8, (c.counts.checkins + c.counts.sessions) * 6),
    band: c.risk_band,
  }))
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ScatterChart margin={{ top: 8, right: 16, left: -12, bottom: 4 }}>
        <ChartDefs />
        <CartesianGrid {...GRID_PROPS} vertical />
        <XAxis
          type="number"
          dataKey="engagement"
          name="Engagement"
          label={{ value: "Engagement (check-ins, 7d) →", position: "insideBottom", offset: -2, fontSize: 10, fill: "var(--color-on-surface-variant)" }}
          tick={{ fontSize: 10, fill: "var(--color-on-surface-variant)" }}
          axisLine={{ stroke: "var(--color-hairline, var(--color-outline-variant))" }}
          tickLine={false}
        />
        <YAxis
          type="number"
          dataKey="wellbeing"
          name="Wellbeing"
          domain={[0, 100]}
          label={{ value: "Wellbeing →", angle: -90, position: "insideLeft", fontSize: 10, fill: "var(--color-on-surface-variant)" }}
          tick={{ fontSize: 10, fill: "var(--color-on-surface-variant)" }}
          axisLine={false}
          tickLine={false}
        />
        <ZAxis type="number" dataKey="activity" range={[60, 420]} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null
            const d = payload[0].payload as { aura_id: string; engagement: number; wellbeing: number; band: string }
            return (
              <div className="rounded-xl aura-glass-strong border border-[var(--color-hairline)] px-3.5 py-2.5 shadow-2xl text-label-sm backdrop-blur-xl">
                <p className="text-on-surface font-semibold">{d.aura_id}</p>
                <p className="text-on-surface-variant">Wellbeing {d.wellbeing} · Engagement {d.engagement}/7d</p>
                <p style={{ color: BAND_COLOR[d.band] }}>{d.band}</p>
              </div>
            )
          }}
          cursor={{ strokeDasharray: "3 3", stroke: "var(--color-outline-variant)" }}
        />
        <Scatter
          data={data}
          onClick={(d: unknown) => {
            const row = d as { aura_id?: string; payload?: { aura_id?: string } }
            const auraId = row?.aura_id ?? row?.payload?.aura_id
            if (auraId) onSelect?.(auraId)
          }}
          cursor={onSelect ? "pointer" : "default"}
          isAnimationActive
          animationDuration={600}
        >
          {data.map((d) => (
            <Cell key={d.aura_id} fill={BAND_COLOR[d.band] ?? "var(--color-primary)"} fillOpacity={0.55} stroke={BAND_COLOR[d.band]} strokeWidth={1.5} filter="url(#chartGlow)" />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  )
}

/** Regional risk landscape: one bubble per district, all three axes real -
 * x = total classified cases, y = amber+red share of that district's cases
 * (risk rate, not a fabricated score), bubble size = total cases. Same
 * StateRollup/DistrictRollup fields the Districts tab table already shows,
 * just plotted instead of listed. */
export function DistrictRiskChart({
  states,
  onSelect,
}: {
  states: { state: string; districts: { district: string; total: number; green: number; amber: number; red: number }[] }[]
  onSelect?: (state: string, district: string) => void
}) {
  const rows = states.flatMap((s) => s.districts.map((d) => ({ ...d, state: s.state })))
  if (rows.length === 0) {
    return <p className="text-label-sm text-on-surface-variant/60 py-6 text-center">No classified cases yet.</p>
  }
  const data = rows.map((d) => {
    const riskRate = d.total > 0 ? Math.round(((d.amber + d.red) / d.total) * 100) : 0
    const band = d.red > 0 ? "RED" : d.amber > 0 ? "AMBER" : "GREEN"
    return { district: d.district, state: d.state, total: d.total, riskRate, band }
  })
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ScatterChart margin={{ top: 8, right: 16, left: -12, bottom: 4 }}>
        <ChartDefs />
        <CartesianGrid {...GRID_PROPS} vertical />
        <XAxis
          type="number"
          dataKey="total"
          name="Cases"
          label={{ value: "Total classified cases →", position: "insideBottom", offset: -2, fontSize: 10, fill: "var(--color-on-surface-variant)" }}
          tick={{ fontSize: 10, fill: "var(--color-on-surface-variant)" }}
          axisLine={{ stroke: "var(--color-hairline, var(--color-outline-variant))" }}
          tickLine={false}
        />
        <YAxis
          type="number"
          dataKey="riskRate"
          name="Risk rate"
          domain={[0, 100]}
          label={{ value: "Amber+red share →", angle: -90, position: "insideLeft", fontSize: 10, fill: "var(--color-on-surface-variant)" }}
          tick={{ fontSize: 10, fill: "var(--color-on-surface-variant)" }}
          axisLine={false}
          tickLine={false}
        />
        <ZAxis type="number" dataKey="total" range={[60, 420]} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null
            const d = payload[0].payload as { district: string; state: string; total: number; riskRate: number; band: string }
            return (
              <div className="rounded-xl aura-glass-strong border border-[var(--color-hairline)] px-3.5 py-2.5 shadow-2xl text-label-sm backdrop-blur-xl">
                <p className="text-on-surface font-semibold">{d.district}, {d.state}</p>
                <p className="text-on-surface-variant">{d.total} cases · {d.riskRate}% amber/red</p>
              </div>
            )
          }}
          cursor={{ strokeDasharray: "3 3", stroke: "var(--color-outline-variant)" }}
        />
        <Scatter
          data={data}
          onClick={(d: unknown) => {
            const row = d as { state?: string; district?: string; payload?: { state?: string; district?: string } }
            const state = row?.state ?? row?.payload?.state
            const district = row?.district ?? row?.payload?.district
            if (state && district) onSelect?.(state, district)
          }}
          cursor={onSelect ? "pointer" : "default"}
          isAnimationActive
          animationDuration={600}
        >
          {data.map((d) => (
            <Cell key={`${d.state}-${d.district}`} fill={BAND_COLOR[d.band] ?? "var(--color-primary)"} fillOpacity={0.55} stroke={BAND_COLOR[d.band]} strokeWidth={1.5} filter="url(#chartGlow)" />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  )
}

/** Case-stage composition (complaint → ... → closed) as a horizontal bar
 * read top-to-bottom like a funnel - real counts from the geo overview's
 * by_case_type/by_stage rollup, not an invented pipeline. */
export function StageBarChart({ stages }: { stages: { label: string; value: number }[] }) {
  const data = stages.filter((s) => s.value > 0)
  if (data.length === 0) {
    return <p className="text-label-sm text-on-surface-variant/60 py-6 text-center">No classified cases yet.</p>
  }
  return (
    <ResponsiveContainer width="100%" height={Math.max(140, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 0 }}>
        <ChartDefs />
        <CartesianGrid {...GRID_PROPS} horizontal={false} vertical />
        <XAxis type="number" tick={{ fontSize: 10, fill: "var(--color-on-surface-variant)" }} allowDecimals={false} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="label" tick={{ fontSize: 11, fill: "var(--color-on-surface)" }} width={110} axisLine={false} tickLine={false} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-primary)", opacity: 0.06 }} />
        <Bar dataKey="value" name="Cases" fill="url(#gradPrimary)" stroke="var(--color-primary)" strokeWidth={1} filter="url(#chartGlow)" radius={[2, 6, 6, 2]} maxBarSize={22} isAnimationActive animationDuration={600} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Real per-session distress score over time - every point is one actually
 * recorded "Talk to Aura"/analysis session (history_store.sessions), oldest
 * to newest, never an interpolated or synthetic trend line. Colour follows
 * each session's own recorded distress_level band. */
export function SessionDistressTrendChart({
  sessions,
}: {
  sessions: { created_at: string; distress_score: number | null; distress_level: string | null }[]
}) {
  const data = [...sessions]
    .filter((s) => s.distress_score !== null)
    .reverse() // sessions arrive newest-first; the chart reads oldest -> newest, left to right
    .map((s, i) => ({
      index: i + 1,
      date: new Date(s.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      score: Math.round(s.distress_score as number),
      band: s.distress_level ?? "GREEN",
    }))

  if (data.length < 2) {
    return <p className="text-label-sm text-on-surface-variant/60 py-6 text-center">Not enough scored sessions yet to show a trend.</p>
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
        <ChartDefs />
        <CartesianGrid {...GRID_PROPS} />
        <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--color-on-surface-variant)" }} axisLine={{ stroke: "var(--color-hairline, var(--color-outline-variant))" }} tickLine={false} />
        <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--color-on-surface-variant)" }} axisLine={false} tickLine={false} />
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--color-primary)", strokeDasharray: "3 3" }} />
        <Area
          type="monotone"
          dataKey="score"
          name="Distress score"
          stroke="var(--color-primary)"
          strokeWidth={2}
          fill="url(#gradPrimary)"
          fillOpacity={0.35}
          isAnimationActive
          animationDuration={700}
          dot={(props: { cx?: number; cy?: number; payload?: { band?: string } }) => {
            const { cx, cy, payload } = props
            if (cx == null || cy == null) return <g key={`${cx}-${cy}`} />
            const color = BAND_COLOR[payload?.band ?? "GREEN"] ?? "var(--color-primary)"
            return <Dot key={`${cx}-${cy}`} cx={cx} cy={cy} r={4} fill={color} stroke="var(--color-void, #0a0714)" strokeWidth={1.5} />
          }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
