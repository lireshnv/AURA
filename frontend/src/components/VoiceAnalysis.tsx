import { useCallback, useEffect, useRef, useState } from "react"
import { Mic, MicOff, AlertTriangle } from "lucide-react"
import { VoiceCapabilities, VoiceFeature, VoiceFrame } from "../types"
import { analyzeVoiceFrame, resetVoiceSession } from "../lib/api"
import { RollingAudioCapture } from "../lib/audioCapture"

/**
 * Real-time voice analysis.
 *
 * Two request cadences run against the same microphone:
 *
 *   PARTIAL  every ~700ms, over the last 2s. Fast, provisional transcript
 *            text plus continuously updating acoustic features.
 *   FINAL    once per utterance, over the whole utterance. Slower and more
 *            accurate; its text REPLACES the partial text for that span.
 *
 * They have separate in-flight guards. A slow final pass must never block the
 * partial stream, because the partial stream is what makes the panel feel live.
 *
 * Nothing here invents a reading. When a window produces no finding the panel
 * says why - it never falls back to the previous value or to "Neutral".
 */

const PARTIAL_WINDOW_SECONDS = 2
const PARTIAL_INTERVAL_MS = 700
const UTTERANCE_SILENCE_MS = 700
const MAX_UTTERANCE_SECONDS = 20

interface Props {
  active: boolean
  capabilities: VoiceCapabilities | null
  language: string
  sessionId: string
  onFrame: (frame: VoiceFrame) => void
  onFatalError: (message: string) => void
}

const FEATURE_ROWS: Array<{ key: keyof VoiceFrame["prosody"]; label: string }> = [
  { key: "pitch", label: "Pitch" },
  { key: "energy", label: "Energy" },
  { key: "speech_rate", label: "Speech rate" },
  { key: "pause_ratio", label: "Pause ratio" },
  { key: "pitch_variation", label: "Pitch variation" },
]

// Clinical-grade voice-quality measures (Praat: jitter/shimmer/HNR). Kept as
// a separate row set since they describe vocal strain/roughness, a different
// axis from the activation-oriented prosody rows above.
const VOICE_QUALITY_ROWS: Array<{ key: keyof VoiceFrame["prosody"]; label: string }> = [
  { key: "jitter", label: "Jitter" },
  { key: "shimmer", label: "Shimmer" },
  { key: "hnr", label: "Harmonics-to-noise" },
]

function FeatureBar({ label, feature }: { label: string; feature: VoiceFeature | undefined }) {
  // Not measured is rendered as absent, never as an empty bar at 0% - a 0%
  // bar reads as "measured and low", which is a different claim.
  if (!feature?.available || feature.normalized === null) {
    return (
      <div className="flex items-center gap-2 text-[11px]">
        <span className="w-28 shrink-0 text-on-surface-variant">{label}</span>
        <span className="text-on-surface-variant italic">not measured</span>
      </div>
    )
  }
  const pct = Math.round(feature.normalized * 100)
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-28 shrink-0 text-on-surface-variant">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-surface-container-high overflow-hidden">
        <div
          className="h-full bg-violet-500 transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-9 text-right tabular-nums text-on-surface-variant">{pct}%</span>
      {feature.raw !== null && (
        <span className="w-20 text-right tabular-nums text-on-surface-variant">
          {feature.raw.toFixed(feature.unit === "Hz" ? 0 : 2)} {feature.unit}
        </span>
      )}
    </div>
  )
}

const QUALITY_TONE: Record<string, string> = {
  good: "text-emerald-600",
  high: "text-emerald-600",
  fair: "text-amber-600",
  medium: "text-amber-600",
  poor: "text-rose-600",
  low: "text-rose-600",
  none: "text-on-surface-variant",
  unavailable: "text-on-surface-variant",
}

function QualityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-on-surface-variant">{label}</span>
      <span className={`font-medium capitalize ${QUALITY_TONE[value] ?? "text-on-surface-variant"}`}>
        {value}
      </span>
    </div>
  )
}

export default function VoiceAnalysis({
  active,
  capabilities,
  language,
  sessionId,
  onFrame,
  onFatalError,
}: Props) {
  const captureRef = useRef<RollingAudioCapture | null>(null)
  const partialBusy = useRef(false)
  const finalBusy = useRef(false)
  const intervalRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const languageRef = useRef(language)
  const onFrameRef = useRef(onFrame)

  const [listening, setListening] = useState(false)
  const [statusMessage, setStatusMessage] = useState("")
  const [frame, setFrame] = useState<VoiceFrame | null>(null)
  const [finalText, setFinalText] = useState("")
  const [partialText, setPartialText] = useState("")
  const [rms, setRms] = useState(0)
  const [persistentError, setPersistentError] = useState("")
  const consecutiveFailures = useRef(0)

  // After this many back-to-back failed requests, "retrying automatically"
  // stops being an honest description - something is actually broken (wrong
  // API base URL, backend down, CORS) and the person deserves to be told
  // that plainly rather than watching a spinner-adjacent message forever.
  const PERSISTENT_ERROR_THRESHOLD = 5

  // Kept in refs so changing the language or the handler does not tear down
  // and restart the capture loop mid-session.
  useEffect(() => {
    languageRef.current = language
  }, [language])
  useEffect(() => {
    onFrameRef.current = onFrame
  }, [onFrame])

  const stopCapture = useCallback(() => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    abortRef.current?.abort()
    captureRef.current?.stop()
    captureRef.current = null
    partialBusy.current = false
    finalBusy.current = false
    consecutiveFailures.current = 0
    setListening(false)
    setStatusMessage("")
    setPersistentError("")
    setRms(0)
    setFrame(null)
    setFinalText("")
    setPartialText("")
  }, [])

  /** Applies a returned frame. Final text supersedes partial text. */
  const applyFrame = useCallback((f: VoiceFrame, isFinal: boolean) => {
    // A frame actually came back from the server, so whatever request
    // trouble preceded it is over - clear any persistent-failure banner.
    consecutiveFailures.current = 0
    setPersistentError("")

    setFrame(f)
    onFrameRef.current(f)

    const text = f.transcript?.display_text || f.transcript?.text || ""
    if (isFinal) {
      if (text) {
        setFinalText((prev) => (prev ? `${prev} ${text}` : text))
        setPartialText("")
      }
    } else {
      setPartialText(text)
    }

    if (f.error) setStatusMessage(f.error)
    else if (!f.analysis_used) setStatusMessage(f.message ?? "Collecting more speech...")
    else setStatusMessage("")
  }, [])

  /** Shared failure bookkeeping for both the partial and final request loops. */
  const recordRequestFailure = useCallback((err: unknown, context: "partial" | "final") => {
    if ((err as Error)?.name === "AbortError") return
    console.error(`[VoiceAnalysis] ${context} voice analysis request failed:`, err)
    consecutiveFailures.current += 1
    if (consecutiveFailures.current >= PERSISTENT_ERROR_THRESHOLD) {
      setPersistentError(
        "Voice analysis keeps failing. Check that the backend is reachable and reload if this continues."
      )
    } else {
      setStatusMessage("Voice analysis unavailable. Retrying automatically...")
    }
  }, [])

  /** Fast provisional pass over the most recent window. */
  const runPartial = useCallback(async () => {
    const capture = captureRef.current
    if (!capture || partialBusy.current) return
    const wav = capture.encodeWindow()
    if (!wav) return

    partialBusy.current = true
    const controller = new AbortController()
    abortRef.current = controller
    const end = capture.elapsedSeconds
    try {
      const f = await analyzeVoiceFrame(wav, {
        sessionId,
        windowStart: Math.max(0, end - PARTIAL_WINDOW_SECONDS),
        windowEnd: end,
        isFinal: false,
        language: languageRef.current === "auto" ? undefined : languageRef.current,
        signal: controller.signal,
      })
      applyFrame(f, false)
    } catch (err) {
      recordRequestFailure(err, "partial")
    } finally {
      partialBusy.current = false
    }
  }, [applyFrame, recordRequestFailure, sessionId])

  /** Accurate pass over a completed utterance. */
  const runFinal = useCallback(async () => {
    const capture = captureRef.current
    if (!capture || finalBusy.current) return
    const utterance = capture.takeUtterance()
    if (!utterance) return

    finalBusy.current = true
    try {
      const f = await analyzeVoiceFrame(utterance.blob, {
        sessionId,
        windowStart: utterance.startSeconds,
        windowEnd: utterance.endSeconds,
        isFinal: true,
        language: languageRef.current === "auto" ? undefined : languageRef.current,
      })
      applyFrame(f, true)
    } catch (err) {
      // A dropped final pass loses accuracy for that utterance only; the
      // partial text for it is already on screen. Still logged/counted so a
      // systemic outage (not just one bad utterance) surfaces to the user.
      recordRequestFailure(err, "final")
    } finally {
      finalBusy.current = false
    }
  }, [applyFrame, recordRequestFailure, sessionId])

  // --- Microphone lifecycle ---
  useEffect(() => {
    if (!active) {
      stopCapture()
      return
    }

    let cancelled = false
    const capture = new RollingAudioCapture(
      PARTIAL_WINDOW_SECONDS,
      UTTERANCE_SILENCE_MS,
      MAX_UTTERANCE_SECONDS
    )

    // A new session must not inherit the previous speaker's vocal baseline.
    resetVoiceSession(sessionId)

    capture
      .start()
      .then(() => {
        if (cancelled) {
          capture.stop()
          return
        }
        captureRef.current = capture
        setListening(true)
        setStatusMessage("Listening...")
      })
      .catch((err: Error) => {
        if (cancelled) return
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          onFatalError("Microphone access is required for voice analysis.")
        } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
          onFatalError("No microphone device was detected.")
        } else if (err.name === "NotReadableError") {
          onFatalError("The microphone is in use by another application.")
        } else {
          onFatalError(`Unable to access the microphone: ${err.message}`)
        }
      })

    return () => {
      cancelled = true
      capture.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId])

  // --- Both cadences on one timer. Each has its own in-flight guard, so a
  //     slow final pass never delays the partial stream. ---
  useEffect(() => {
    if (!active || !listening) return
    intervalRef.current = window.setInterval(() => {
      runPartial()
      runFinal()
    }, PARTIAL_INTERVAL_MS)
    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [active, listening, runPartial, runFinal])

  // --- Waveform: visualization only, never used for prediction ---
  useEffect(() => {
    if (!listening) return
    const draw = () => {
      const capture = captureRef.current
      const canvas = canvasRef.current
      if (capture && canvas) {
        const levels = capture.getLevels()
        if (levels) {
          setRms(levels.rms)
          const ctx = canvas.getContext("2d")
          if (ctx) {
            const w = canvas.width
            const h = canvas.height
            ctx.clearRect(0, 0, w, h)
            const bars = levels.waveform.length
            const barWidth = w / bars
            for (let i = 0; i < bars; i++) {
              const amp = Math.min(1, levels.waveform[i] * 3)
              const barHeight = Math.max(1, amp * h)
              ctx.fillStyle = amp > 0.5 ? "#8b5cf6" : amp > 0.15 ? "#a78bfa" : "#e2e8f0"
              ctx.fillRect(i * barWidth, (h - barHeight) / 2, Math.max(1, barWidth - 1), barHeight)
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [listening])

  useEffect(() => stopCapture, []) // cleanup on unmount

  const unavailable: string[] = []
  if (capabilities) {
    if (!capabilities.speech_to_text) unavailable.push("speech-to-text")
    if (!capabilities.voice_emotion) unavailable.push("voice emotion")
  }

  const signal = frame?.analysis_used ? frame.voice_signal : null
  const transcriptConfidence = frame?.transcript?.confidence ?? null
  const lowConfidence = frame?.analysis_used === true && frame.confidence < 35

  return (
    <div className="rounded-xl bg-surface-container-lowest border border-outline-variant p-4 space-y-4">
      {/* --- Header --- */}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-on-surface">
          Voice Analysis
        </h2>
        <div className="flex items-center gap-1.5 text-[11px] font-medium">
          {listening ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <Mic size={12} className="text-emerald-600" />
              <span className="text-emerald-600">Microphone Active</span>
            </>
          ) : (
            <>
              <MicOff size={12} className="text-on-surface-variant" />
              <span className="text-on-surface-variant">Microphone Off</span>
            </>
          )}
        </div>
      </div>

      <div className="rounded-lg bg-surface-container-low border border-outline-variant p-2">
        <canvas ref={canvasRef} width={320} height={32} className="w-full h-8" />
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] uppercase tracking-wide text-on-surface-variant">level</span>
          <div className="flex-1 h-1 rounded-full bg-surface-container-high overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-[width] duration-100"
              style={{ width: `${Math.min(100, rms * 300)}%` }}
            />
          </div>
        </div>
      </div>

      {/* --- Live transcript --- */}
      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant mb-1.5">
          Live Transcript
        </h3>
        <div className="rounded-lg bg-surface-container-low border border-outline-variant p-3 min-h-[56px] text-sm leading-relaxed">
          {finalText || partialText ? (
            <p className="text-on-surface">
              {finalText}
              {finalText && partialText ? " " : ""}
              {/* Provisional text is visually distinct so nobody mistakes it
                  for settled output. */}
              {partialText && <span className="text-on-surface-variant italic">{partialText}</span>}
            </p>
          ) : (
            <p className="text-on-surface-variant text-xs">
              {listening ? "Nothing transcribed yet. Speak to begin." : "Not listening."}
            </p>
          )}
        </div>
        {transcriptConfidence !== null && (
          <p className="text-[11px] text-on-surface-variant mt-1">
            Transcript confidence: {transcriptConfidence.toFixed(0)}%
          </p>
        )}
      </section>

      {/* --- Voice signal: observation first, interpretation clearly apart --- */}
      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant mb-1.5">
          Voice Signal
        </h3>
        {signal ? (
          <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-violet-900">
                Observed: {signal.observed}
              </span>
              <span className="text-[11px] tabular-nums text-violet-700 shrink-0">
                {signal.confidence.toFixed(0)}%
              </span>
            </div>
            {signal.contributing_features.length > 0 && (
              <p className="text-[10px] text-violet-700/80">
                From: {signal.contributing_features.join(", ").replace(/_/g, " ")}
              </p>
            )}
            {signal.emotion && signal.emotion_confidence !== null && (
              <div className="pt-1.5 mt-1 border-t border-violet-200">
                <p className="text-[11px] text-violet-800">
                  Possible tone:{" "}
                  <span className="font-medium capitalize">{signal.emotion}</span>{" "}
                  ({signal.emotion_confidence.toFixed(0)}%)
                </p>
              </div>
            )}
            <p className="text-[10px] text-violet-700/70 leading-snug pt-0.5">
              {signal.interpretation_note}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
            <p className="text-xs text-on-surface-variant">
              {statusMessage || (listening ? "Collecting more speech..." : "Not listening.")}
            </p>
          </div>
        )}
        {lowConfidence && (
          <p className="text-[11px] text-amber-600 mt-1">
            Low confidence — treat this reading as weak evidence.
          </p>
        )}
        {persistentError && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 mt-2">
            <p className="text-xs text-red-700 font-medium">{persistentError}</p>
          </div>
        )}
      </section>

      {/* --- Vocal features --- */}
      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant mb-1.5">
          Vocal Features
        </h3>
        {frame?.analysis_used ? (
          <div className="space-y-1.5">
            {FEATURE_ROWS.map((row) => (
              <FeatureBar key={row.key} label={row.label} feature={frame.prosody?.[row.key]} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-on-surface-variant">No features measured in this window.</p>
        )}
      </section>

      {/* --- Voice quality (jitter/shimmer/HNR) --- */}
      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant mb-1.5">
          Voice Quality
        </h3>
        {frame?.analysis_used ? (
          <div className="space-y-1.5">
            {VOICE_QUALITY_ROWS.map((row) => (
              <FeatureBar key={row.key} label={row.label} feature={frame.prosody?.[row.key]} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-on-surface-variant">No features measured in this window.</p>
        )}
      </section>

      {/* --- Signal quality --- */}
      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant mb-1.5">
          Signal Quality
        </h3>
        <div className="space-y-1">
          <QualityRow label="Audio" value={frame?.quality?.audio ?? "unavailable"} />
          <QualityRow label="Speech" value={frame?.quality?.speech ?? "none"} />
          <QualityRow label="Transcript" value={frame?.quality?.transcript ?? "none"} />
        </div>
        {frame?.latency && frame.analysis_used && (
          <p className="text-[10px] text-on-surface-variant mt-1.5 tabular-nums">
            {frame.latency.total_ms.toFixed(0)}ms
            {/* Surfaced because a silent regression to sequential execution is
                otherwise invisible and costs roughly double the latency. */}
            {frame.latency.overlap_saved_ms > 0 &&
              ` · ${frame.latency.overlap_saved_ms.toFixed(0)}ms saved by overlap`}
          </p>
        )}
      </section>

      {unavailable.length > 0 && (
        <div className="flex items-start gap-1.5 text-[11px] text-amber-600">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span>Unavailable in this environment: {unavailable.join(", ")}.</span>
        </div>
      )}
    </div>
  )
}
