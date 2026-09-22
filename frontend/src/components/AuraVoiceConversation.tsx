import { useEffect, useRef, useState } from "react"
import { Mic, Square, Pause, Play, Video, VideoOff, Lock } from "lucide-react"
import { useAuraConversation } from "../lib/useAuraConversation"
import { transcribeVoice } from "../lib/chatApi"
import { RollingAudioCapture } from "../lib/audioCapture"
import { recordOutcome } from "../lib/patternsApi"
import { CareActivityType, setConsent, submitCareAction } from "../lib/twinApi"
import { LANGUAGE_OPTIONS, getStoredLanguage, storeLanguage } from "../lib/companionLanguages"
import AvatarModule from "./AvatarModule"
import { ActivityModal } from "./DailyCare"
import { AvatarAnimationState } from "./AvatarModule/types"
import { SafetyPanel, renderMarkdown } from "./AICompanion"

type Phase = "idle" | "listening" | "thinking" | "speaking" | "paused" | "ended"
type FeelingAfter = "better" | "slightly_better" | "same" | "worse" | "not_sure"

const POLL_MS = 120
const TRANSCRIPT_PREVIEW = 4

const FOLLOWUP_MESSAGE: Record<FeelingAfter, string> = {
  better: "I'm glad things feel a little lighter.",
  slightly_better: "That's good to hear, even a little.",
  same: "That's okay. We can take another approach.",
  worse: "Let's slow down. Would you like to talk to someone you trust or get professional support?",
  not_sure: "That's okay. We don't have to decide right now.",
}

interface Props {
  cameraActive: boolean
  onToggleCamera: (on: boolean) => void
  /** Starts the same voice-signal analysis pipeline "Analyse Now" starts
   * (Distress Signal, Synchronized Signals, Multimodal Timeline) - Speak
   * with Aura IS that action for voice, combined into one interactive
   * control rather than two separate buttons to press. */
  onStartAnalysis: () => void
  onStopAnalysis: () => void
  onOpenSupport: () => void
  onOpenInsights: () => void
  /** Plain-language observation, e.g. "Increased vocal tension was detected
   * during part of the conversation." Null when nothing to report yet. */
  observationSummary: string | null
}

/**
 * "Speak with Aura" - the SAME Aura conversation engine (useAuraConversation)
 * used by the text Companion, wrapped in a voice-first, continuous-turn
 * experience. Reuses RollingAudioCapture's silence-based utterance detection
 * (already built for the live voice-tone pipeline) purely for turn-taking
 * here - a second, dedicated mic capture, but the SAME transcribe/chat/
 * speak/session/safety calls as everywhere else in the app.
 */
export default function AuraVoiceConversation({
  cameraActive,
  onToggleCamera,
  onStartAnalysis,
  onStopAnalysis,
  onOpenSupport,
  onOpenInsights,
  observationSummary,
}: Props) {
  const [language, setLanguage] = useState<string>(getStoredLanguage)
  const [phase, setPhase] = useState<Phase>("idle")
  const [transcribing, setTranscribing] = useState(false)
  const [showFullTranscript, setShowFullTranscript] = useState(false)
  const [feedback, setFeedback] = useState<FeelingAfter | null>(null)
  const [showCalmActivity, setShowCalmActivity] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)

  const { messages, safetyBlocks, sending, speaking, status, sendStreaming, interrupt, reset, greet } =
    useAuraConversation(language)

  const captureRef = useRef<RollingAudioCapture | null>(null)
  const pollRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(false)
  const busyRef = useRef(false)

  const changeLanguage = (code: string) => {
    setLanguage(code)
    storeLanguage(code)
  }

  // --- Turn loop: pull finished utterances and stream them through the same
  //     sendStreaming() the text Companion's engine exposes. Also the
  //     barge-in check: if the user starts talking while Aura is speaking,
  //     her audio (and any remaining generation) is cancelled immediately
  //     and the turn hands back, rather than waiting for her to finish. ---
  useEffect(() => {
    if (phase !== "listening" && phase !== "speaking") return
    pollRef.current = window.setInterval(async () => {
      const capture = captureRef.current
      if (!capture) return
      capture.resumeIfSuspended()

      if (speaking && capture.isSpeaking) {
        interrupt()
        return
      }
      if (pausedRef.current || busyRef.current || speaking) return

      const utterance = capture.takeUtterance()
      if (!utterance) return

      busyRef.current = true
      setTranscribing(true)
      const text = await transcribeVoice(utterance.blob)
      setTranscribing(false)
      if (text && text.trim()) await sendStreaming(text)
      busyRef.current = false
    }, POLL_MS)
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, speaking])

  // --- Waveform, visualization only ---
  useEffect(() => {
    if (phase === "idle" || phase === "ended") return
    const draw = () => {
      const capture = captureRef.current
      const canvas = canvasRef.current
      if (capture && canvas) {
        const levels = capture.getLevels()
        if (levels) {
          const ctx = canvas.getContext("2d")
          if (ctx) {
            const w = canvas.width
            const h = canvas.height
            ctx.clearRect(0, 0, w, h)
            const bars = levels.waveform.length
            const barWidth = w / bars
            for (let i = 0; i < bars; i++) {
              const amp = Math.min(1, levels.waveform[i] * 3)
              const barHeight = Math.max(2, amp * h)
              ctx.fillStyle = speaking ? "#0062d2" : amp > 0.4 ? "#630ed4" : "#d2bbff"
              ctx.fillRect(i * barWidth, (h - barHeight) / 2, Math.max(1, barWidth - 1), barHeight)
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [phase, speaking])

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [messages.length])

  const start = async () => {
    setMicError(null)
    try {
      const capture = new RollingAudioCapture(2, 700, 20)
      await capture.start()
      captureRef.current = capture
      pausedRef.current = false
      setPhase("listening")
      // One interactive control: talking to Aura also starts the same
      // voice AND face analysis "Analyse Now" would, rather than needing
      // three separate buttons.
      onStartAnalysis()
      onToggleCamera(true)
      // Aura opens the conversation immediately instead of sitting silently
      // until the user speaks first - a scripted, spoken opener, not a
      // fabricated model reply (see useAuraConversation's greet()).
      if (messages.length === 0) greet("I'm here. What's on your mind?")
    } catch (err) {
      // A silent failure here reads as "the button did nothing" - the
      // single most common shape of "microphone isn't working" reports.
      const name = (err as Error)?.name
      setMicError(
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "Microphone access was blocked. Please allow microphone access for this site and try again."
          : name === "NotFoundError" || name === "DevicesNotFoundError"
          ? "No microphone was found on this device."
          : name === "NotReadableError"
          ? "The microphone is already in use by another application or browser tab."
          : `Couldn't access the microphone: ${(err as Error)?.message || "unknown error"}.`
      )
      setPhase("idle")
    }
  }

  const stopCapture = () => {
    captureRef.current?.stop()
    captureRef.current = null
    if (pollRef.current) window.clearInterval(pollRef.current)
  }

  const pause = () => {
    pausedRef.current = true
    interrupt()
    setPhase("paused")
  }

  const resume = () => {
    pausedRef.current = false
    setPhase("listening")
  }

  const end = () => {
    interrupt()
    stopCapture()
    setPhase("ended")
    setFeedback(null)
    onStopAnalysis()
  }

  const submitFeedback = async (result: FeelingAfter) => {
    setFeedback(result)
    if (result === "not_sure") return
    await recordOutcome({
      intervention_category: "connect",
      intervention_type: "aura_companion_voice",
      result,
    })
  }

  const continueTalking = async () => {
    setPhase("idle")
    setFeedback(null)
    await start()
    greet("Of course. I'm still here.")
  }

  const completeCalmActivity = async (type: CareActivityType) => {
    await setConsent("companion_care", true)
    await submitCareAction("activity", type)
    setShowCalmActivity(false)
    greet("Well done. How are you feeling now?")
  }

  useEffect(() => stopCapture, [])

  const derivedPhase: Phase =
    phase === "ended" || phase === "paused"
      ? phase
      : speaking
      ? "speaking"
      : sending || transcribing
      ? "thinking"
      : phase === "listening"
      ? "listening"
      : "idle"

  const avatarAnimation: AvatarAnimationState =
    derivedPhase === "listening"
      ? "listening"
      : derivedPhase === "thinking"
      ? "thinking"
      : derivedPhase === "speaking"
      ? "talking"
      : "idle"

  const statusText: Record<Phase, string> = {
    idle: "I'm here whenever you're ready.",
    listening: "I'm listening…",
    thinking: "Give me a moment…",
    speaking: "Aura is speaking…",
    paused: "Conversation paused.",
    ended: "Thank you for talking with me.",
  }

  const lastAssistantIdx = [...messages].map((m, i) => ({ m, i })).reverse().find((x) => x.m.role === "assistant")?.i
  const activeSafety = lastAssistantIdx !== undefined ? safetyBlocks[lastAssistantIdx] : undefined
  const unavailable = status && !status.ready
  const visibleMessages = showFullTranscript ? messages : messages.slice(-TRANSCRIPT_PREVIEW)

  return (
    <section className="bg-surface-container-lowest rounded-[24px] shadow-ambient-lg p-stack-md">
      {phase === "idle" && (
        <div className="flex justify-end mb-2">
          <select
            value={language}
            onChange={(e) => changeLanguage(e.target.value)}
            title="Conversation language"
            className="px-2 py-1 rounded-lg border border-outline-variant text-xs text-on-surface-variant bg-surface-container-lowest hover:bg-surface-container-low"
          >
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.code} value={opt.code}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {unavailable && (
        <p className="text-label-sm text-on-surface-variant mb-4 text-center">
          Voice conversation is temporarily unavailable: {status?.note}
        </p>
      )}

      {phase !== "ended" && (
        <div className="flex flex-col items-center text-center py-6">
          {phase === "idle" && <h1 className="text-headline-lg text-on-surface mb-1">Speak with Aura</h1>}
          <div className="w-32 h-32 rounded-full overflow-hidden mb-4 bg-primary-container/10">
            <AvatarModule drivenAnimation={avatarAnimation} compact />
          </div>
          <p className="text-body-lg text-on-surface font-medium mb-1">{statusText[derivedPhase]}</p>
          {phase === "idle" && (
            <p className="text-body-md text-on-surface-variant mb-4 max-w-sm">
              You don't have to know what to say. Just start talking.
            </p>
          )}

          {phase !== "idle" && (
            <div className="w-full max-w-sm rounded-xl bg-surface-container-low border border-outline-variant p-2 mb-4">
              <canvas ref={canvasRef} width={320} height={40} className="w-full h-10" />
            </div>
          )}

          {micError && (
            <p className="text-label-sm text-error mb-3 max-w-sm">{micError}</p>
          )}

          <div className="flex items-center gap-3">
            {phase === "idle" && (
              <button
                onClick={start}
                disabled={!!unavailable}
                className="flex items-center gap-2 rounded-full bg-primary text-on-primary px-6 py-3.5 text-label-md font-semibold disabled:opacity-40 hover:bg-primary-fixed-dim"
              >
                <Mic size={18} /> Start Talking
              </button>
            )}
            {phase === "listening" && (
              <>
                <button
                  onClick={pause}
                  className="flex items-center gap-2 rounded-full border border-outline-variant px-5 py-3 text-label-md font-semibold text-on-surface hover:bg-surface-container-high"
                >
                  <Pause size={16} /> Pause
                </button>
                <button
                  onClick={end}
                  className="flex items-center gap-2 rounded-full bg-error text-on-error px-5 py-3 text-label-md font-semibold"
                >
                  <Square size={16} /> End
                </button>
              </>
            )}
            {phase === "paused" && (
              <>
                <button
                  onClick={resume}
                  className="flex items-center gap-2 rounded-full bg-primary text-on-primary px-5 py-3 text-label-md font-semibold"
                >
                  <Play size={16} /> Continue
                </button>
                <button
                  onClick={end}
                  className="flex items-center gap-2 rounded-full border border-outline-variant px-5 py-3 text-label-md font-semibold text-on-surface hover:bg-surface-container-high"
                >
                  End
                </button>
              </>
            )}
          </div>

          {phase === "idle" && (
            <div className="mt-4 flex flex-col items-center gap-1">
              <p className="flex items-center gap-1.5 text-label-sm text-on-surface-variant">
                <Lock size={12} /> Voice • Camera optional • Private
              </p>
              <details className="text-label-sm text-on-surface-variant">
                <summary className="cursor-pointer text-primary hover:underline list-none text-center">
                  Privacy details
                </summary>
                <p className="mt-2 max-w-sm text-left">
                  Camera and microphone are only active while you're talking with Aura. Raw audio and
                  video are never stored - only structured scores and timestamps are, and only with
                  your consent.
                </p>
              </details>
            </div>
          )}

          {/* Quick choices after Aura's very first reply */}
          {phase === "listening" && messages.length === 2 && (
            <div className="flex flex-wrap justify-center gap-2 mt-5">
              <button
                onClick={() => sendStreaming("Talk more")}
                className="rounded-full border border-outline-variant px-4 py-2 text-label-md text-on-surface hover:border-primary hover:bg-primary-container/10"
              >
                Talk more
              </button>
              <button
                onClick={() => setShowCalmActivity(true)}
                className="rounded-full border border-outline-variant px-4 py-2 text-label-md text-on-surface hover:border-primary hover:bg-primary-container/10"
              >
                Calm down
              </button>
              <button
                onClick={() => sendStreaming("I'm not sure")}
                className="rounded-full border border-outline-variant px-4 py-2 text-label-md text-on-surface hover:border-primary hover:bg-primary-container/10"
              >
                I'm not sure
              </button>
            </div>
          )}
        </div>
      )}

      {activeSafety && phase !== "ended" && <SafetyPanel safety={activeSafety} />}

      {phase !== "idle" && phase !== "ended" && messages.length > 0 && (
        <div className="rounded-xl bg-surface-container-low border border-outline-variant p-4 mb-4 max-h-72 overflow-y-auto">
          {!showFullTranscript && messages.length > TRANSCRIPT_PREVIEW && (
            <button
              onClick={() => setShowFullTranscript(true)}
              className="text-label-sm text-primary hover:underline mb-3"
            >
              View full transcript
            </button>
          )}
          <div className="space-y-3">
            {visibleMessages.map((m, i) => (
              <div key={i}>
                <p className="text-label-sm font-semibold text-on-surface-variant mb-0.5">
                  {m.role === "user" ? "You" : "Aura"}
                </p>
                <p
                  className="text-body-md text-on-surface"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                />
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
        </div>
      )}

      {phase !== "idle" && phase !== "ended" && (
        <div className="rounded-xl bg-surface-container-low border border-outline-variant px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-5 text-label-sm text-on-surface-variant">
              <span>
                Voice <span className="text-secondary font-medium">{phase === "paused" ? "Paused" : "Listening"}</span>
              </span>
              <span>
                Speech <span className="text-secondary font-medium">{transcribing || sending ? "Processing" : "Ready"}</span>
              </span>
              <span className="flex items-center gap-1">
                Face{" "}
                <span className={cameraActive ? "text-secondary font-medium" : "text-on-surface-variant"}>
                  {cameraActive ? "On" : "Camera off"}
                </span>
              </span>
            </div>
            <button
              onClick={() => onToggleCamera(!cameraActive)}
              className="flex items-center gap-1.5 text-label-sm text-on-surface-variant hover:text-primary"
            >
              {cameraActive ? <VideoOff size={14} /> : <Video size={14} />}
              {cameraActive ? "Turn camera off" : "Enable camera analysis"}
            </button>
          </div>
          {observationSummary && (
            <p className="text-label-sm text-on-surface-variant mt-3 pt-3 border-t border-outline-variant">
              {observationSummary}{" "}
              <span className="text-outline">Observable signal • Not a clinical diagnosis.</span>
            </p>
          )}
        </div>
      )}

      {phase === "ended" && (
        <div className="text-center py-4">
          <h3 className="text-headline-md text-on-surface mb-1">Conversation Complete</h3>
          <p className="text-body-md text-on-surface-variant mb-6">Thank you for talking with me.</p>

          {observationSummary && (
            <p className="text-label-sm text-on-surface-variant mb-6 max-w-sm mx-auto">
              {observationSummary}{" "}
              <span className="text-outline">Observable signal • Not a clinical diagnosis.</span>
            </p>
          )}

          {feedback === null ? (
            <>
              <p className="text-label-md font-semibold text-on-surface mb-3">How are you feeling now?</p>
              <div className="flex flex-wrap justify-center gap-2 mb-6">
                {(
                  [
                    ["better", "Better"],
                    ["slightly_better", "A little better"],
                    ["same", "Same"],
                    ["worse", "Worse"],
                    ["not_sure", "Not sure"],
                  ] as [FeelingAfter, string][]
                ).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => submitFeedback(value)}
                    className="rounded-full border border-outline-variant px-4 py-2 text-label-md text-on-surface hover:border-primary hover:bg-primary-container/10"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <p className="text-body-md text-on-surface mb-2 max-w-sm">{FOLLOWUP_MESSAGE[feedback]}</p>
              <p className="text-label-md font-semibold text-on-surface mb-1">What would you like to do next?</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  onClick={continueTalking}
                  className="rounded-xl bg-primary text-on-primary px-4 py-2.5 text-label-md font-semibold"
                >
                  Continue talking
                </button>
                <button
                  onClick={onOpenSupport}
                  className="rounded-xl border border-outline-variant px-4 py-2.5 text-label-md text-on-surface hover:bg-surface-container-high"
                >
                  Try something calming
                </button>
                <button
                  onClick={onOpenInsights}
                  className="rounded-xl border border-outline-variant px-4 py-2.5 text-label-md text-on-surface hover:bg-surface-container-high"
                >
                  View insights
                </button>
                <button
                  onClick={onOpenSupport}
                  className="rounded-xl border border-outline-variant px-4 py-2.5 text-label-md text-on-surface hover:bg-surface-container-high"
                >
                  Get support
                </button>
              </div>
            </div>
          )}

          <button
            onClick={() => {
              setPhase("idle")
              reset()
            }}
            className="text-label-sm text-on-surface-variant hover:text-primary mt-6"
          >
            Start a brand new conversation instead
          </button>
        </div>
      )}

      <p className="text-label-sm text-on-surface-variant text-center mt-4">
        Aura is an AI companion and does not replace professional care. If you are in danger,
        please contact your local emergency number.
      </p>

      {showCalmActivity && (
        <ActivityModal onClose={() => setShowCalmActivity(false)} onComplete={completeCalmActivity} />
      )}
    </section>
  )
}
