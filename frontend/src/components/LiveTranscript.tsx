import { GroqTranscriptAnalysis, TextEmotionInfo } from "../types"

const EMOJI: Record<string, string> = {
  happy: "😊",
  sad: "😢",
  angry: "😠",
  fear: "😨",
  surprise: "😲",
  neutral: "😐",
  disgust: "🤢",
}

const SENTIMENT_COLOR: Record<string, string> = {
  positive: "text-secondary",
  neutral: "text-on-surface-variant",
  negative: "text-error",
}

interface Props {
  /** Most recent SETTLED transcript lines, oldest first. Bounded by the caller. */
  lines: string[]
  /** In-progress text from the fast partial pass - provisional, shown
   * distinctly so it is never mistaken for settled output. */
  livePartial?: string
  textEmotion: TextEmotionInfo | null
  /** Groq's qualitative read of the latest SETTLED transcript segment -
   * optional, since it degrades honestly to unavailable rather than a fake
   * placeholder when Groq isn't configured or the segment was too short. */
  groqInsight?: GroqTranscriptAnalysis | null
}

export default function LiveTranscript({ lines, livePartial, textEmotion, groqInsight }: Props) {
  const hasContent = lines.length > 0 || !!livePartial
  return (
    <div className="bg-surface-container-lowest rounded-[24px] shadow-ambient-md p-stack-sm flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-label-md font-semibold text-on-surface flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[16px]">chat</span>
          Live Transcript
        </h3>
        <div className="flex items-center gap-3">
          {textEmotion?.available && textEmotion.dominant && (
            <div className="hidden sm:flex items-center gap-2 text-label-sm">
              <span className="text-on-surface-variant">Text emotion</span>
              <span className="text-on-surface font-medium capitalize">
                {EMOJI[textEmotion.dominant] ?? ""} {textEmotion.dominant}
              </span>
              {textEmotion.sentiment && (
                <span className={SENTIMENT_COLOR[textEmotion.sentiment.dominant] ?? "text-on-surface-variant"}>
                  {textEmotion.sentiment.dominant}
                </span>
              )}
            </div>
          )}
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-error opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-error" />
          </span>
        </div>
      </div>

      {!hasContent ? (
        <p className="text-label-md text-on-surface-variant italic">
          Nothing transcribed yet. Speak while voice analysis is running.
        </p>
      ) : (
        <div className="flex-grow overflow-y-auto space-y-3 pr-2" style={{ maxHeight: 220 }}>
          {lines.map((line, i) => (
            <div key={i} className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-surface-variant shrink-0 flex items-center justify-center">
                <span className="material-symbols-outlined text-[16px] text-on-surface-variant">person</span>
              </div>
              <div className="p-3 rounded-lg rounded-tl-none bg-surface-container-low">
                <p className="text-body-md text-sm text-on-surface-variant">{line}</p>
              </div>
            </div>
          ))}
          {livePartial && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-primary-container/20 shrink-0 flex items-center justify-center">
                <span className="material-symbols-outlined text-[16px] text-primary">person</span>
              </div>
              <div className="p-3 rounded-lg rounded-tl-none bg-primary-container/10">
                {/* Provisional text is visually distinct (italic) so nobody
                    mistakes it for settled output - it may still be revised. */}
                <p className="text-body-md text-sm text-on-surface italic">{livePartial}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {textEmotion?.available === false && textEmotion.error && (
        <p className="text-label-sm text-primary mt-2">{textEmotion.error}</p>
      )}

      {textEmotion?.available && textEmotion.language_supported === false && (
        <p className="text-label-sm text-primary mt-2">
          Transcript language is outside the text model's supported set — treat the text
          emotion as unreliable.
        </p>
      )}

      {textEmotion?.available && textEmotion.evidence && textEmotion.evidence.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {textEmotion.evidence.map((e, i) => (
            <li key={i} className="text-label-sm text-on-surface-variant/70">
              · {e}
            </li>
          ))}
        </ul>
      )}

      {groqInsight?.available && (
        <div className="mt-3 pt-3 border-t border-outline-variant space-y-1.5">
          <p className="text-label-sm font-semibold text-on-surface flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[14px] text-primary">auto_awesome</span>
            AURA's read
          </p>
          {groqInsight.supportive_response && (
            <p className="text-body-md text-sm text-on-surface-variant">{groqInsight.supportive_response}</p>
          )}
          {!!groqInsight.themes?.length && (
            <p className="text-label-sm text-on-surface-variant">
              <span className="text-on-surface-variant/70">Themes: </span>
              {groqInsight.themes.join(", ")}
            </p>
          )}
          {!!groqInsight.key_concerns?.length && (
            <p className="text-label-sm text-on-surface-variant">
              <span className="text-on-surface-variant/70">Concerns: </span>
              {groqInsight.key_concerns.join(", ")}
            </p>
          )}
          {!!groqInsight.practical_suggestions?.length && (
            <ul className="space-y-0.5">
              {groqInsight.practical_suggestions.map((s, i) => (
                <li key={i} className="text-label-sm text-on-surface-variant/80">
                  · {s}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
