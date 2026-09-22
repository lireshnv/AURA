import { useState } from "react"
import { History, LineChart } from "lucide-react"
import { MultimodalTimelinePoint, Observation } from "../types"
import EmotionTimeline from "./EmotionTimeline"

type Tab = "timeline" | "patterns"

const MODALITY_LABEL: Record<string, string> = {
  face: "Face",
  voice: "Voice",
  text: "Speech",
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

/** Compact synchronized event list: one row per modality change, not a raw
 * per-tick dump - a timeline someone would actually read. */
function TimelineTab({ points }: { points: MultimodalTimelinePoint[] }) {
  if (points.length === 0) {
    return (
      <p className="text-label-sm text-on-surface-variant py-6 text-center">
        Your conversation timeline will appear here once Aura observes something.
      </p>
    )
  }

  const rows: { time: string; modality: string; label: string }[] = []
  let lastByModality: Record<string, string | null> = { face: null, voice: null, text: null }
  for (const p of points) {
    ;(["face", "voice", "text"] as const).forEach((m) => {
      const value = p[m]
      if (value && value !== lastByModality[m]) {
        rows.push({ time: timeOf(p.timestamp), modality: MODALITY_LABEL[m], label: value })
        lastByModality[m] = value
      }
    })
  }

  const shown = rows.slice(-12)
  if (shown.length === 0) {
    return (
      <p className="text-label-sm text-on-surface-variant py-6 text-center">
        No clear changes observed yet - Aura will note them here as the conversation continues.
      </p>
    )
  }

  return (
    <div className="flex flex-col divide-y divide-outline-variant">
      {shown.map((r, i) => (
        <div key={i} className="flex items-center gap-3 py-2.5">
          <span className="text-label-sm text-outline tabular-nums w-14 shrink-0">{r.time}</span>
          <span className="text-label-sm font-semibold text-on-surface-variant w-14 shrink-0">{r.modality}</span>
          <span className="text-body-md text-on-surface capitalize">{r.label}</span>
        </div>
      ))}
    </div>
  )
}

function PatternsTab({ observations }: { observations: Observation[] }) {
  if (observations.length < 6) {
    return (
      <p className="text-label-sm text-on-surface-variant py-6 text-center">
        Your conversation patterns will appear here as you continue checking in.
      </p>
    )
  }
  return <EmotionTimeline observations={observations} />
}

export default function ConversationInsights({
  points,
  observations,
}: {
  points: MultimodalTimelinePoint[]
  observations: Observation[]
}) {
  const [tab, setTab] = useState<Tab>("timeline")

  return (
    <section className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md">
      <h2 className="text-headline-md text-on-surface mb-3">Conversation Insights</h2>
      <div className="flex gap-1 border-b border-outline-variant mb-3">
        {(
          [
            ["timeline", "Timeline", History],
            ["patterns", "Patterns", LineChart],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-4 py-2 text-label-md whitespace-nowrap -mb-px border-b-2 ${
              tab === key
                ? "border-primary text-primary font-bold"
                : "border-transparent text-on-surface-variant hover:text-on-surface"
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>
      {tab === "timeline" ? <TimelineTab points={points} /> : <PatternsTab observations={observations} />}
    </section>
  )
}
