import { Sparkles, AlertTriangle, UserCheck, Info } from "lucide-react"
import { AuraAnalysis } from "../types"

const EMOJI: Record<string, string> = {
  happy: "😊",
  sad: "😢",
  angry: "😠",
  fear: "😨",
  surprise: "😲",
  neutral: "😐",
  disgust: "🤢",
  uncertain: "🤔",
}

const AGREEMENT_COLOR: Record<string, string> = {
  high: "text-emerald-600",
  moderate: "text-amber-600",
  low: "text-rose-600",
  unknown: "text-slate-500",
}

function SignalRow({
  label,
  signal,
  quality,
}: {
  label: string
  signal: number | null
  quality: number | null
}) {
  const unavailable = signal === null
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 text-[11px] text-slate-500">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-slate-200 overflow-hidden">
        {!unavailable && (
          <div
            className="h-full bg-violet-500"
            style={{ width: `${Math.max(0, Math.min(100, signal))}%` }}
          />
        )}
      </div>
      <span className="w-28 text-right text-[11px]">
        {unavailable ? (
          <span className="text-slate-400">insufficient signal</span>
        ) : (
          <>
            <span className="text-slate-700 font-semibold">{signal.toFixed(0)}%</span>
            {quality !== null && (
              <span className="text-slate-400"> · q{quality.toFixed(0)}</span>
            )}
          </>
        )}
      </span>
    </div>
  )
}

export default function AuraResultPanel({ result }: { result: AuraAnalysis | null }) {
  if (!result) {
    return (
      <div className="rounded-xl bg-white border border-slate-200 p-5">
        <h2 className="text-xs uppercase tracking-wide text-slate-500 flex items-center gap-1.5 mb-2">
          <Sparkles size={12} />
          AURA Multimodal Analysis
        </h2>
        <p className="text-xs text-slate-500">
          Click <span className="text-slate-600 font-semibold">ANALYSE NOW</span> to start the
          combined camera + microphone analysis.
        </p>
      </div>
    )
  }

  if (!result.success) {
    return (
      <div className="rounded-xl bg-rose-50 border border-rose-200 p-5">
        <p className="text-sm text-rose-700">{result.error ?? "Analysis failed."}</p>
      </div>
    )
  }

  const { combined, per_modality, explanation, agreement, sentiment } = result

  return (
    <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-slate-200">
        <h2 className="text-xs uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
          <Sparkles size={12} />
          AURA Multimodal Analysis
        </h2>
      </div>

      <div className="p-5 space-y-4">
        {/* Combined result */}
        <div className="flex items-start gap-4">
          <span className="text-5xl leading-none">{EMOJI[combined.dominant] ?? "🤔"}</span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">
              Dominant observed expression signal
            </div>
            <div className="text-2xl font-bold uppercase tracking-wide text-slate-900">
              {combined.dominant === "uncertain" ? "Uncertain" : combined.dominant}
              {combined.dominant !== "uncertain" && (
                <span className="text-slate-500 text-lg font-semibold ml-2">
                  {combined.signal.toFixed(0)}%
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] mt-1">
              <span className="text-slate-500">
                Confidence <span className="text-slate-700 font-semibold">
                  {combined.confidence.toFixed(0)}%
                </span>
              </span>
              <span className="text-slate-500">
                Reliability <span className="text-slate-700 font-semibold">
                  {combined.reliability.toFixed(0)}%
                </span>
              </span>
              {result.modalities_used.length > 1 && (
                <span className="text-slate-500">
                  Agreement{" "}
                  <span className={`font-semibold ${AGREEMENT_COLOR[agreement.label]}`}>
                    {agreement.score.toFixed(0)}%
                  </span>
                </span>
              )}
              <span className="text-slate-500">
                Sentiment{" "}
                <span className="text-slate-700 font-semibold capitalize">
                  {sentiment.dominant}
                </span>
              </span>
            </div>
          </div>
        </div>

        {/* Per-modality signal strengths */}
        <div className="space-y-1.5 rounded-lg bg-slate-50 border border-slate-200 px-4 py-3">
          <SignalRow
            label="Facial"
            signal={per_modality.face?.signal ?? null}
            quality={per_modality.face?.quality ?? null}
          />
          <SignalRow
            label="Voice"
            signal={per_modality.voice?.signal ?? null}
            quality={per_modality.voice?.quality ?? null}
          />
          <SignalRow
            label="Text"
            signal={per_modality.text?.signal ?? null}
            quality={per_modality.text?.quality ?? null}
          />
          <div className="pt-1.5 mt-1.5 border-t border-slate-200">
            <SignalRow label="Combined" signal={combined.signal} quality={null} />
          </div>
        </div>

        {/* WHY - every line derived from a measurement */}
        <div>
          <h3 className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">Why?</h3>
          <p className="text-xs text-slate-600 mb-2">{explanation.headline}</p>
          <ul className="space-y-1">
            {explanation.reasons.map((reason, i) => (
              <li key={i} className="text-[11px] text-slate-500 flex items-start gap-1.5">
                <span className="text-violet-600 mt-0.5">·</span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Inconsistencies - surfaced, not hidden */}
        {explanation.inconsistencies.length > 0 && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-700 mb-1">
              <AlertTriangle size={11} />
              Signal inconsistency
            </div>
            <ul className="space-y-1">
              {explanation.inconsistencies.map((item, i) => (
                <li key={i} className="text-[11px] text-amber-800">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Human review recommendation */}
        {explanation.human_review_recommended && (
          <div className="rounded-lg bg-sky-50 border border-sky-200 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-sky-700">
              <UserCheck size={11} />
              Human review recommended
            </div>
            <p className="text-[11px] text-sky-800 mt-1">
              {explanation.human_review_reason}
            </p>
          </div>
        )}

        {/* Limitations - always shown */}
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">
            <Info size={11} />
            Limitations
          </div>
          <ul className="space-y-0.5">
            {explanation.limitations.map((item, i) => (
              <li key={i} className="text-[11px] text-slate-500">
                · {item}
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-slate-400 mt-2">
            Explanation generated by: {explanation.generated_by}
          </p>
        </div>
      </div>
    </div>
  )
}
