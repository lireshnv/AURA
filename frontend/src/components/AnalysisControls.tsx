import { Play, Square, FileText, Loader2 } from "lucide-react"
import { PerformanceMode, PipelineStatus } from "../types"

const MODES: { key: PerformanceMode; label: string; sub: string }[] = [
  { key: "fast", label: "Fast", sub: "~1s" },
  { key: "balanced", label: "Balanced", sub: "~2s" },
  { key: "power_saving", label: "Power Saving", sub: "~3s" },
]

const LANGUAGE_NAMES: Record<string, string> = {
  auto: "Auto-detect",
  en: "English",
  hi: "Hindi",
  ta: "Tamil",
  te: "Telugu",
  ml: "Malayalam",
  kn: "Kannada",
}

/** Colour + label for each pipeline stage indicator. */
const STAGE_STYLE: Record<string, { dot: string; text: string }> = {
  off: { dot: "bg-outline-variant", text: "text-on-surface-variant" },
  idle: { dot: "bg-outline-variant", text: "text-on-surface-variant" },
  none: { dot: "bg-outline-variant", text: "text-on-surface-variant" },
  starting: { dot: "bg-primary animate-pulse", text: "text-primary" },
  active: { dot: "bg-secondary animate-pulse", text: "text-secondary" },
  detected: { dot: "bg-secondary", text: "text-secondary" },
  speech: { dot: "bg-secondary", text: "text-secondary" },
  receiving: { dot: "bg-secondary", text: "text-secondary" },
  not_detected: { dot: "bg-primary", text: "text-primary" },
  silence: { dot: "bg-outline", text: "text-on-surface-variant" },
  error: { dot: "bg-error", text: "text-error" },
}

const STAGE_LABELS: Record<string, string> = {
  off: "Off",
  idle: "Idle",
  none: "None",
  starting: "Starting",
  active: "Active",
  detected: "Detected",
  not_detected: "Not detected",
  speech: "Speech",
  silence: "Silence",
  receiving: "Receiving",
  error: "Error",
}

function StageDot({ label, state }: { label: string; state: string }) {
  const style = STAGE_STYLE[state] ?? STAGE_STYLE.idle
  return (
    <span className="flex items-center gap-1.5 text-label-sm">
      <span className={`w-2 h-2 rounded-full ${style.dot}`} />
      <span className="text-on-surface-variant">{label}</span>
      <span className={style.text}>{STAGE_LABELS[state] ?? state}</span>
    </span>
  )
}

interface Props {
  running: boolean
  analysing: boolean
  status: PipelineStatus
  mode: PerformanceMode
  language: string
  languages: string[]
  canGenerateReport: boolean
  onToggle: () => void
  onModeChange: (mode: PerformanceMode) => void
  onLanguageChange: (language: string) => void
  onGenerateReport: () => void
}

/**
 * One prominent ANALYSE NOW button. A single click starts camera, microphone,
 * face analysis, voice analysis, transcription and fusion together - the user
 * never starts these separately.
 */
export default function AnalysisControls({
  running,
  analysing,
  status,
  mode,
  language,
  languages,
  canGenerateReport,
  onToggle,
  onModeChange,
  onLanguageChange,
  onGenerateReport,
}: Props) {
  return (
    <div className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow space-y-4">
      {/* Consent notice, shown BEFORE analysis begins. */}
      {!running && (
        <div className="flex items-start gap-2 rounded-xl bg-surface-container-low border border-outline-variant px-3 py-2.5">
          <span className="material-symbols-outlined text-primary text-[16px] mt-0.5 shrink-0">verified_user</span>
          <p className="text-label-sm text-on-surface-variant leading-relaxed">
            Your camera and microphone will be analysed with your permission. Video and audio
            are processed for the active session only — raw video and audio are never stored,
            and only structured scores and timestamps are retained.
          </p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <button
          onClick={onToggle}
          className={`flex items-center justify-center gap-2.5 px-8 py-4 rounded-full text-body-lg font-bold tracking-wide transition-colors shadow-lg ${
            running
              ? "bg-error hover:bg-error/90 text-on-error shadow-error/20"
              : "bg-primary hover:bg-primary-fixed-dim text-on-primary shadow-primary/20"
          }`}
        >
          {analysing && !running ? (
            <Loader2 size={18} className="animate-spin" />
          ) : running ? (
            <Square size={18} />
          ) : (
            <Play size={18} />
          )}
          {running ? "STOP ANALYSIS" : "ANALYSE NOW"}
        </button>

        <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5">
          <StageDot label="Camera" state={status.camera} />
          <StageDot label="Microphone" state={status.microphone} />
          <StageDot label="Face" state={status.face} />
          <StageDot label="Voice" state={status.voice} />
          <StageDot label="Transcript" state={status.transcript} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-outline-variant">
        <select
          value={mode}
          onChange={(e) => onModeChange(e.target.value as PerformanceMode)}
          className="bg-surface-container-low border border-outline-variant text-label-sm text-on-surface rounded-full px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {MODES.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label} — {m.sub}
            </option>
          ))}
        </select>

        <select
          value={language}
          onChange={(e) => onLanguageChange(e.target.value)}
          title="Spoken language for transcription"
          className="bg-surface-container-low border border-outline-variant text-label-sm text-on-surface rounded-full px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {languages.map((code) => (
            <option key={code} value={code}>
              {LANGUAGE_NAMES[code] ?? code}
            </option>
          ))}
        </select>

        <button
          onClick={onGenerateReport}
          disabled={!canGenerateReport}
          title={canGenerateReport ? undefined : "At least 15 valid observations are needed"}
          className="flex items-center gap-2 px-3 py-1.5 rounded-full text-label-sm font-semibold border border-outline-variant text-on-surface-variant hover:bg-surface-container-low disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <FileText size={13} />
          Generate Final Report
        </button>
      </div>
    </div>
  )
}
