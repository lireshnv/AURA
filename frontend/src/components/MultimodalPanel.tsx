import { Layers, AlertTriangle } from "lucide-react"
import { MultimodalResponse } from "../types"

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
  unknown: "text-on-surface-variant",
}

interface Props {
  fusion: MultimodalResponse | null
  faceDominant: string | null
  faceConfidence: number | null
  voiceDominant: string | null
  voiceConfidence: number | null
  textDominant: string | null
  textConfidence: number | null
}

function ModalityCell({
  label,
  emotion,
  confidence,
  weight,
}: {
  label: string
  emotion: string | null
  confidence: number | null
  weight?: number
}) {
  const inactive = !emotion
  return (
    <div className="rounded-lg bg-surface-container-low border border-outline-variant px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-on-surface-variant flex items-center justify-between">
        <span>{label}</span>
        {weight !== undefined && <span className="text-on-surface-variant">{weight.toFixed(0)}%</span>}
      </div>
      {inactive ? (
        <div className="text-xs text-on-surface-variant mt-1">not active</div>
      ) : (
        <>
          <div className="text-sm font-semibold text-on-surface mt-0.5 capitalize truncate">
            {EMOJI[emotion] ?? ""} {emotion}
          </div>
          {confidence !== null && (
            <div className="text-[10px] text-on-surface-variant">{confidence.toFixed(0)}%</div>
          )}
        </>
      )}
    </div>
  )
}

export default function MultimodalPanel({
  fusion,
  faceDominant,
  faceConfidence,
  voiceDominant,
  voiceConfidence,
  textDominant,
  textConfidence,
}: Props) {
  const weights = fusion?.effective_weights ?? {}

  return (
    <div className="rounded-xl bg-surface-container-lowest border border-outline-variant p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wide text-on-surface-variant flex items-center gap-1.5">
          <Layers size={12} />
          Multimodal Estimate
        </h2>
        {fusion && (
          <div className="text-[11px]">
            <span className="text-on-surface-variant">Signal agreement </span>
            <span className={`font-semibold ${AGREEMENT_COLOR[fusion.agreement.label]}`}>
              {fusion.agreement.score.toFixed(0)}% ({fusion.agreement.label})
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <ModalityCell
          label="Face"
          emotion={faceDominant}
          confidence={faceConfidence}
          weight={weights.face}
        />
        <ModalityCell
          label="Voice"
          emotion={voiceDominant}
          confidence={voiceConfidence}
          weight={weights.voice}
        />
        <ModalityCell
          label="Text"
          emotion={textDominant}
          confidence={textConfidence}
          weight={weights.text}
        />
        <div className="rounded-lg bg-violet-50 border border-violet-200 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-violet-700">Overall</div>
          {fusion ? (
            <>
              <div className="text-sm font-semibold text-on-surface mt-0.5 capitalize truncate">
                {EMOJI[fusion.emotion.dominant] ?? ""} {fusion.emotion.dominant}
              </div>
              <div className="text-[10px] text-violet-600">
                {fusion.emotion.confidence.toFixed(0)}% · rel{" "}
                {fusion.emotion.reliability.toFixed(0)}%
              </div>
            </>
          ) : (
            <div className="text-xs text-on-surface-variant mt-1">—</div>
          )}
        </div>
      </div>

      {/* Disagreement is surfaced, never hidden behind a unified answer. */}
      {fusion?.agreement.disagreement && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-700">
            <AlertTriangle size={11} />
            Mixed signals
          </div>
          <p className="text-[11px] text-amber-800 mt-1">
            The available modalities indicate different emotional patterns, so the overall
            estimate carries reduced reliability.
          </p>
        </div>
      )}

      {fusion?.notes && fusion.notes.length > 0 && (
        <ul className="space-y-0.5">
          {fusion.notes.map((note, i) => (
            <li key={i} className="text-[10px] text-on-surface-variant">
              · {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
