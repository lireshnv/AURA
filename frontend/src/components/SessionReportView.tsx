import { FileText, X } from "lucide-react"
import { SessionReport } from "../types"
import EmotionDistribution from "./EmotionDistribution"
import SentimentChart from "./SentimentChart"
import MultimodalReport from "./MultimodalReport"

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
}

export default function SessionReportView({
  report,
  onClose,
}: {
  report: SessionReport
  onClose: () => void
}) {
  if (report.insufficient_data) {
    return (
      <div className="rounded-xl bg-surface-container-lowest border border-outline-variant p-6 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-on-surface flex items-center gap-2">
            <FileText size={15} /> Insufficient Data
          </h2>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface">
            <X size={16} />
          </button>
        </div>
        <p className="text-sm text-on-surface-variant">{report.message}</p>
      </div>
    )
  }

  const {
    session,
    dominant_emotion,
    overall_reaction,
    expression_intensity,
    emotion_distribution,
    sentiment,
    distress,
    emotional_stability,
    transitions,
    key_observations,
    distress_reasons,
    reliability_summary,
  } = report

  return (
    <div className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-on-surface flex items-center gap-2">
          <FileText size={15} /> AURA Emotion Analysis Report
        </h2>
        <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface">
          <X size={16} />
        </button>
      </div>

      <p className="text-[11px] text-on-surface-variant -mt-3">
        Expression-based estimates derived from this session's observations. Not a medical or
        psychological diagnosis.
      </p>

      {overall_reaction && <p className="text-sm text-on-surface">{overall_reaction}</p>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Session Duration", value: formatDuration(session!.duration_seconds) },
          { label: "Valid Observations", value: `${session!.valid_observations} / ${session!.total_observations}` },
          { label: "Analysis Quality", value: `${session!.analysis_quality.toFixed(0)}%` },
          { label: "Dominant Expression", value: dominant_emotion! },
          ...(expression_intensity
            ? [
                {
                  label: "Expression Intensity",
                  value: `avg ${expression_intensity.average.toFixed(0)} / peak ${expression_intensity.peak.toFixed(0)}`,
                },
              ]
            : []),
        ].map((item) => (
          <div key={item.label} className="rounded-lg bg-surface-container-low border border-outline-variant px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-on-surface-variant">{item.label}</div>
            <div className="text-sm font-semibold text-on-surface mt-0.5 capitalize truncate">{item.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-lg bg-surface-container-low border border-outline-variant px-4 py-3">
          <div className="text-[10px] uppercase tracking-wide text-on-surface-variant mb-1">
            {distress!.label ?? "Expression-Based Distress Estimate"}
          </div>
          <div className="text-2xl font-bold text-on-surface">
            {distress!.score} <span className="text-xs font-normal text-on-surface-variant">/ 100</span>
          </div>
          <div className="text-xs text-on-surface-variant mt-0.5">
            Level: {distress!.level} · Confidence {distress!.confidence.toFixed(0)}%
          </div>
        </div>
        <div className="rounded-lg bg-surface-container-low border border-outline-variant px-4 py-3">
          <div className="text-[10px] uppercase tracking-wide text-on-surface-variant mb-1">Emotional Stability</div>
          <div className="text-2xl font-bold text-on-surface">
            {emotional_stability} <span className="text-xs font-normal text-on-surface-variant">/ 100</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <h3 className="text-xs uppercase tracking-wide text-on-surface-variant mb-2">Emotion Distribution</h3>
          <EmotionDistribution scores={emotion_distribution} />
        </div>
        <div>
          <h3 className="text-xs uppercase tracking-wide text-on-surface-variant mb-2">Sentiment</h3>
          <SentimentChart
            sentiment={{
              dominant: sentiment!.dominant as "positive" | "neutral" | "negative",
              scores: { positive: sentiment!.positive, neutral: sentiment!.neutral, negative: sentiment!.negative },
            }}
          />
        </div>
      </div>

      {transitions && transitions.length > 0 && (
        <div>
          <h3 className="text-xs uppercase tracking-wide text-on-surface-variant mb-2">Most Frequent Transitions</h3>
          <div className="space-y-1">
            {transitions.map((t) => (
              <div key={t.transition} className="flex justify-between text-xs text-on-surface-variant">
                <span className="capitalize">{t.transition}</span>
                <span className="font-semibold">{t.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Voice / speech / multimodal sections - render only when captured. */}
      <MultimodalReport report={report} />

      <div>
        <h3 className="text-xs uppercase tracking-wide text-on-surface-variant mb-2">Key Observations</h3>
        <ul className="space-y-1 text-xs text-on-surface-variant list-disc list-inside">
          {key_observations?.map((obs, i) => (
            <li key={i}>{obs}</li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-wide text-on-surface-variant mb-2">Distress Reasons (Observed Contributors)</h3>
        <ul className="space-y-1 text-xs text-on-surface-variant list-decimal list-inside">
          {distress_reasons?.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-wide text-on-surface-variant mb-2">Reliability Summary</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <div className="text-on-surface-variant">Overall Reliability</div>
            <div className="text-on-surface font-semibold">{reliability_summary!.overall_reliability.toFixed(0)}%</div>
          </div>
          <div>
            <div className="text-on-surface-variant">High-quality obs.</div>
            <div className="text-on-surface font-semibold">{reliability_summary!.high_quality_observations}</div>
          </div>
          <div>
            <div className="text-on-surface-variant">Low-quality obs.</div>
            <div className="text-on-surface font-semibold">{reliability_summary!.low_quality_observations}</div>
          </div>
          <div>
            <div className="text-on-surface-variant">Avg. Face Quality</div>
            <div className="text-on-surface font-semibold">{reliability_summary!.average_face_quality}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
