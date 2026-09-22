import { useEffect, useState } from "react"
import { CheckinEntry, TwinView, fetchCheckins, fetchTwinView } from "../lib/twinApi"
import { WhatHelpsEntry, fetchWhatHelps } from "../lib/patternsApi"

const DIMENSION_LABEL: Record<string, string> = {
  sleep: "Sleep",
  energy: "Energy",
  mood: "Mood",
  social_interaction: "Social connection",
  routine: "Routine",
  communication: "Communication",
}

function rangeLabel(z: number): string {
  if (z <= -0.75) return "Below your usual range"
  if (z >= 0.75) return "Above your usual range"
  return "Within your usual range"
}

export default function MyPatterns({ onStartCheckin }: { onStartCheckin: () => void }) {
  const [twin, setTwin] = useState<TwinView | null>(null)
  const [checkins, setCheckins] = useState<CheckinEntry[]>([])
  const [helps, setHelps] = useState<WhatHelpsEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.all([fetchTwinView(), fetchCheckins(30), fetchWhatHelps()]).then(([tv, ci, wh]) => {
      if (cancelled) return
      setTwin(tv)
      setCheckins(ci?.checkins ?? [])
      setHelps(wh?.ranked ?? [])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const header = (
    <div className="mb-4">
      <h2 className="text-headline-md text-on-surface">My Patterns</h2>
      <p className="text-body-md text-on-surface-variant mt-0.5">
        Understand changes in your mood, stress and daily patterns over time.
      </p>
    </div>
  )

  if (loading) {
    return (
      <section className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md">
        {header}
        <p className="text-label-sm text-on-surface-variant">Loading…</p>
      </section>
    )
  }

  const hasEnoughData = !!twin?.has_data && twin.counts.checkins >= 2

  if (!hasEnoughData) {
    return (
      <section className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md">
        {header}
        <div className="text-center py-6">
          <p className="text-body-md text-on-surface mb-1">Aura is still learning your personal patterns.</p>
          <p className="text-body-md text-on-surface-variant mb-4">
            Keep checking in and talking with Aura to build your baseline.
          </p>
          <button
            onClick={onStartCheckin}
            className="rounded-full bg-primary text-on-primary px-5 py-2.5 text-label-md font-semibold"
          >
            Start a Check-In
          </button>
        </div>
      </section>
    )
  }

  const perDimension = twin!.change.available ? twin!.change.per_dimension : {}
  const hasDimensionData = Object.keys(perDimension).length > 0

  const categoryCounts: Record<string, number> = {}
  for (const c of checkins) {
    const cats = Array.isArray((c as { categories?: unknown }).categories)
      ? ((c as { categories?: string[] }).categories as string[])
      : []
    for (const cat of cats) categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1
  }
  const topAffecting = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([c]) => c)

  return (
    <section className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md">
      {header}

      <h3 className="text-label-md font-semibold text-on-surface-variant uppercase tracking-wide mb-2">
        Recent Pattern
      </h3>
      {!hasDimensionData ? (
        <p className="text-label-sm text-on-surface-variant mb-5">
          Not enough recent check-ins yet to compare against your baseline.
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
          {Object.entries(perDimension).map(([dim, z]) => (
            <div key={dim} className="rounded-xl bg-surface-container-low border border-outline-variant p-3">
              <p className="text-label-sm font-semibold text-on-surface">{DIMENSION_LABEL[dim] ?? dim}</p>
              <p className="text-label-sm text-on-surface-variant mt-0.5">{rangeLabel(z)}</p>
            </div>
          ))}
        </div>
      )}

      {(helps.length > 0 || topAffecting.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {helps.length > 0 && (
            <div>
              <h3 className="text-label-md font-semibold text-on-surface-variant uppercase tracking-wide mb-2">
                What seems to help
              </h3>
              <ul className="flex flex-col gap-1.5">
                {helps.slice(0, 4).map((h) => (
                  <li key={h.intervention_type} className="text-body-md text-on-surface capitalize">
                    {h.intervention_type.replace(/_/g, " ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {topAffecting.length > 0 && (
            <div>
              <h3 className="text-label-md font-semibold text-on-surface-variant uppercase tracking-wide mb-2">
                What seems to affect me
              </h3>
              <ul className="flex flex-col gap-1.5">
                {topAffecting.map((cat) => (
                  <li key={cat} className="text-body-md text-on-surface">
                    {cat}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
