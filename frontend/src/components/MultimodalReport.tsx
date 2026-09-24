import { Layers, AlertTriangle } from "lucide-react"
import { SessionReport } from "../types"
import EmotionDistribution from "./EmotionDistribution"

const EMOJI: Record<string, string> = {
  happy: "😊",
  sad: "😢",
  angry: "😠",
  fear: "😨",
  surprise: "😲",
  neutral: "😐",
  disgust: "🤢",
}

const AGREEMENT_COLOR: Record<string, string> = {
  high: "text-emerald-600",
  moderate: "text-amber-600",
  low: "text-rose-600",
}

/**
 * The multimodal section of the final report. Rendered inside the existing
 * SessionReportView rather than as a second report, so a session has exactly
 * one report. Returns null for face-only sessions.
 */
export default function MultimodalReport({ report }: { report: SessionReport }) {
  const mm = report.multimodal
  if (!mm) return null

  const rows = [
    { label: "Face", data: mm.face, obs: null as number | null, conf: null as number | null },
    {
      label: "Voice",
      data: mm.voice ? { dominant: mm.voice.dominant, distribution: mm.voice.distribution } : null,
      obs: mm.voice?.observations ?? null,
      conf: mm.voice?.avg_confidence ?? null,
    },
    {
      label: "Text",
      data: mm.text ? { dominant: mm.text.dominant, distribution: mm.text.distribution } : null,
      obs: mm.text?.observations ?? null,
      conf: mm.text?.avg_confidence ?? null,
    },
  ]

  const activeDominants = rows.filter((r) => r.data).map((r) => r.data!.dominant)
  const disagreement = new Set(activeDominants).size > 1

  return (
    <div className="space-y-4 pt-4 border-t border-outline-variant">
      <h3 className="text-xs uppercase tracking-wide text-on-surface-variant flex items-center gap-1.5">
        <Layers size={12} />
        Multimodal Analysis
      </h3>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {rows.map((row) => (
          <div key={row.label} className="rounded-lg bg-surface-container-low border border-outline-variant px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-on-surface-variant">{row.label}</div>
            {row.data ? (
              <>
                <div className="text-sm font-semibold text-on-surface mt-0.5 capitalize">
                  {EMOJI[row.data.dominant] ?? ""} {row.data.dominant}
                </div>
                <div className="text-[10px] text-on-surface-variant">
                  {row.conf !== null && `avg confidence ${row.conf.toFixed(0)}%`}
                  {row.obs !== null && ` · ${row.obs} obs`}
                </div>
              </>
            ) : (
              <div className="text-xs text-on-surface-variant mt-1">not captured</div>
            )}
          </div>
        ))}
      </div>

      {mm.signal_agreement !== null && (
        <div className="rounded-lg bg-surface-container-low border border-outline-variant px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-on-surface-variant">
              Signal Agreement
            </span>
            <span
              className={`text-sm font-bold ${
                AGREEMENT_COLOR[mm.agreement_label ?? ""] ?? "text-on-surface-variant"
              }`}
            >
              {mm.signal_agreement.toFixed(0)}%{" "}
              {mm.agreement_label && `(${mm.agreement_label})`}
            </span>
          </div>
          {disagreement && (
            <p className="text-[11px] text-amber-800 mt-2 flex items-start gap-1.5">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              The available modalities show different emotional patterns. The overall estimate
              therefore has reduced reliability.
            </p>
          )}
        </div>
      )}

      {(mm.voice || mm.text) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {mm.voice && (
            <div>
              <h4 className="text-[10px] uppercase tracking-wide text-on-surface-variant mb-1.5">
                Voice Emotion Distribution
              </h4>
              <EmotionDistribution scores={mm.voice.distribution} />
            </div>
          )}
          {mm.text && (
            <div>
              <h4 className="text-[10px] uppercase tracking-wide text-on-surface-variant mb-1.5">
                Text Emotion Distribution
              </h4>
              <EmotionDistribution scores={mm.text.distribution} />
            </div>
          )}
        </div>
      )}

      {mm.voice_stress_average !== null && (
        <p className="text-[11px] text-on-surface-variant">
          Average vocal-pattern composite: {(mm.voice_stress_average * 100).toFixed(0)}% — a
          descriptive summary of pitch/energy variability, speech rate and pauses, not a
          clinical stress measurement.
        </p>
      )}

      {mm.transcript_excerpt && (
        <div>
          <h4 className="text-[10px] uppercase tracking-wide text-on-surface-variant mb-1">
            Transcript (most recent)
          </h4>
          <p className="text-xs text-on-surface-variant bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 max-h-32 overflow-y-auto">
            {mm.transcript_excerpt}
          </p>
        </div>
      )}
    </div>
  )
}
