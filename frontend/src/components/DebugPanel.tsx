import { useState } from "react"
import { ChevronDown, ChevronUp, Bug } from "lucide-react"
import { DebugMetrics, EmotionScores } from "../types"

const EMOTION_ORDER: (keyof EmotionScores)[] = [
  "happy",
  "neutral",
  "surprise",
  "sad",
  "angry",
  "fear",
  "disgust",
]

function ScoreBars({
  scores,
  highlight,
  color,
}: {
  scores: EmotionScores
  highlight: string
  color: string
}) {
  return (
    <div className="space-y-0.5">
      {EMOTION_ORDER.map((k) => {
        const v = scores[k]
        const isTop = k === highlight
        return (
          <div key={k} className="flex items-center gap-2 text-[11px]">
            <span className={`w-16 ${isTop ? "text-on-surface font-semibold" : "text-on-surface-variant"}`}>
              {k}
            </span>
            <div className="flex-1 h-1.5 rounded-full bg-surface-container-high overflow-hidden">
              <div
                className={`h-full ${isTop ? color : "bg-slate-600"}`}
                style={{ width: `${Math.min(100, v)}%` }}
              />
            </div>
            <span className={`w-9 text-right ${isTop ? "text-on-surface" : "text-on-surface-variant"}`}>
              {v.toFixed(0)}%
            </span>
          </div>
        )
      })}
    </div>
  )
}

function SignalRows({ signals }: { signals: Record<string, number> }) {
  const entries = Object.entries(signals).filter(([, v]) => v > 0.5)
  if (entries.length === 0) {
    return (
      <p className="text-[11px] text-on-surface-variant">
        All geometric signals at baseline (face at rest).
      </p>
    )
  }
  return (
    <div className="space-y-0.5">
      {entries
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 text-[11px]">
            <span className="w-32 text-on-surface-variant">{k.replace(/_/g, " ")}</span>
            <div className="flex-1 h-1.5 rounded-full bg-surface-container-high overflow-hidden">
              <div className="h-full bg-violet-500" style={{ width: `${Math.min(100, v)}%` }} />
            </div>
            <span className="w-9 text-right text-on-surface-variant">{v.toFixed(0)}%</span>
          </div>
        ))}
    </div>
  )
}

function agoLabel(ts: number | null): string {
  if (ts === null) return "—"
  return `${((Date.now() - ts) / 1000).toFixed(1)}s ago`
}

export default function DebugPanel({ metrics }: { metrics: DebugMetrics }) {
  const [open, setOpen] = useState(false)
  const latest = metrics.latest
  const debug = latest?.debug
  const emotion = latest?.emotion

  const statusRows: [string, string][] = [
    ["Camera", metrics.cameraActive ? "CONNECTED" : "OFF"],
    ["Backend", metrics.backendConnected ? "CONNECTED" : "OFFLINE"],
    ["Resolution", `${metrics.videoWidth}×${metrics.videoHeight}`],
    ["Frame size", `${metrics.lastFrameSizeKb.toFixed(1)} KB`],
    ["Face", metrics.faceDetected ? "DETECTED" : "NOT DETECTED"],
    ["Last analysis", agoLabel(metrics.lastAnalysisAt)],
    ["API latency", metrics.lastResponseMs !== null ? `${metrics.lastResponseMs} ms` : "—"],
    ["Valid frames", String(metrics.analysisCount)],
    ["Skipped", String(metrics.skippedCount)],
    ["Model", "DeepFace emotion + Face Mesh"],
    ["Last error", metrics.lastError ?? "None"],
  ]

  return (
    <div className="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-xs uppercase tracking-wide text-on-surface-variant hover:text-on-surface"
      >
        <span className="flex items-center gap-2">
          <Bug size={13} />
          Diagnostics
          {debug?.calibrating && (
            <span className="normal-case text-[10px] text-amber-600 font-normal">
              · calibrating baseline
            </span>
          )}
        </span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4">
          {debug && emotion && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <h4 className="text-[10px] uppercase tracking-wide text-on-surface-variant mb-1.5">
                  Raw DeepFace (one signal — not the verdict)
                </h4>
                <ScoreBars
                  scores={debug.deepface_scores}
                  highlight={debug.deepface_dominant}
                  color="bg-slate-400"
                />
              </div>
              <div>
                <h4 className="text-[10px] uppercase tracking-wide text-on-surface-variant mb-1.5">
                  Final fusion (what the dashboard shows)
                </h4>
                <ScoreBars
                  scores={emotion.scores}
                  highlight={emotion.dominant}
                  color="bg-emerald-500"
                />
              </div>
            </div>
          )}

          {debug && (
            <>
              <div>
                <h4 className="text-[10px] uppercase tracking-wide text-on-surface-variant mb-1.5">
                  Geometric evidence (vs. personal baseline)
                </h4>
                <SignalRows signals={debug.signals} />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 font-mono text-[11px]">
                {[
                  ["mouth motion", `${(debug.region_motion.mouth ?? 0).toFixed(0)}%`],
                  ["eye motion", `${(debug.region_motion.eyes ?? 0).toFixed(0)}%`],
                  ["brow motion", `${(debug.region_motion.brows ?? 0).toFixed(0)}%`],
                  ["overall motion", `${(debug.region_motion.overall ?? 0).toFixed(0)}%`],
                  ["temporal stability", `${debug.temporal_stability.toFixed(0)}%`],
                  ["landmark trust", debug.landmark_trust.toFixed(2)],
                  ["yaw / pitch", `${debug.yaw_ratio.toFixed(2)} / ${debug.pitch_ratio.toFixed(2)}`],
                  ["roll", `${debug.roll_degrees.toFixed(1)}°`],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between border-b border-outline-variant py-0.5">
                    <span className="text-on-surface-variant">{label}</span>
                    <span className="text-on-surface">{value}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px] pt-1">
            {statusRows.map(([label, value]) => (
              <div key={label} className="flex justify-between border-b border-outline-variant py-0.5">
                <span className="text-on-surface-variant">{label}</span>
                <span
                  className={
                    label === "Last error" && value !== "None"
                      ? "text-rose-600 text-right max-w-[60%] truncate"
                      : "text-on-surface text-right max-w-[60%] truncate"
                  }
                  title={value}
                >
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
