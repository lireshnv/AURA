import { useEffect, useRef, useState } from "react"
import { Mic, Square, Pause, Play, ChevronDown, ChevronUp, Video, VideoOff } from "lucide-react"
import { useAuraConversation } from "../lib/useAuraConversation"
import { transcribeVoice } from "../lib/chatApi"
import { RollingAudioCapture } from "../lib/audioCapture"
import { recordOutcome } from "../lib/patternsApi"
import { LANGUAGE_OPTIONS, getStoredLanguage, storeLanguage } from "../lib/companionLanguages"
import AvatarModule from "./AvatarModule"
import { AvatarAnimationState } from "./AvatarModule/types"
import { SafetyPanel, renderMarkdown } from "./AICompanion"

type Phase = "idle" | "listening" | "thinking" | "speaking" | "paused" | "ended"
type FeelingAfter = "better" | "slightly_better" | "same" | "worse"

const POLL_MS = 250

interface Props {
  cameraActive: boolean
  onToggleCamera: (on: boolean) => void
  onOpenSupport: () => void
  onOpenInsights: () => void
  onOpenSafetyPlan: () => void
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
  onOpenSupport,
  onOpenInsights,
  onOpenSafetyPlan,
}: Props) {
  const [language, setLanguage] = useState<string>(getStoredLanguage)
  const [phase, setPhase] = useState<Phase>("idle")
  const [transcribing, setTranscribing] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [feedback, setFeedback] = useState<FeelingAfter | null>(null)

  const {
    messages,
    safetyBlocks,
    sending,
    speaking,
    status,
    send,
    reset,
  } = useAuraConversation(language)

  const captureRef = useRef<RollingAudioCapture | null>(null)
  const pollRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pausedRef = useRef(false)
  const busyRef = useRef(false)

  const changeLanguage = (code: string) => {
    setLanguage(code)
    storeLanguage(code)
  }

  // --- Turn loop: pull finished utterances and run them through the exact
  //     same send() the text Companion uses. Paused while Aura is speaking so
  //     her own voice is never picked back up as a new turn. ---
  useEffect(() => {
    if (phase !== "listening" && phase !== "speaking") return
    pollRef.current = window.setInterval(async () => {
      const capture = captureRef.current
      if (!capture || pausedRef.current || busyRef.current || speaking) return
      const utterance = capture.takeUtterance()
      if (!utterance) return

      busyRef.current = true
      setTranscribing(true)
      const text = await transcribeVoice(utterance.blob)
      setTranscribing(false)
      if (text && text.trim()) await send(text)
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

  const start = async () => {
    try {
      const capture = new RollingAudioCapture(2, 700, 20)
      await capture.start()
      captureRef.current = capture
      pausedRef.current = false
      setPhase("listening")
    } catch {
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
    setPhase("paused")
  }

  const resume = () => {
    pausedRef.current = false
    setPhase("listening")
  }

  const end = () => {
    stopCapture()
    setPhase("ended")
    setFeedback(null)
  }

  const submitFeedback = async (result: FeelingAfter) => {
    setFeedback(result)
    await recordOutcome({
      intervention_category: "connect",
      intervention_type: "aura_companion_voice",
      result,
    })
  }

  const continueTalking = () => {
    setPhase("idle")
    setFeedback(null)
    start()
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

  return (
    <section className="bg-surface-container-lowest rounded-[24px] shadow-ambient-lg p-stack-md">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-headline-lg text-on-surface">Speak with Aura</h2>
          <p className="text-body-md text-on-surface-variant mt-0.5">
            You don't have to know what to say. Just start talking.
          </p>
        </div>
        {phase === "idle" && (
          <select
            value={language}
            onChange={(e) => changeLanguage(e.target.value)}
            title="Conversation language"
            className="px-2 py-1.5 rounded-lg border border-outline-variant text-xs text-on-surface-variant bg-surface-container-lowest hover:bg-surface-container-low shrink-0"
          >
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.code} value={opt.code}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {unavailable && (
        <p className="text-label-sm text-on-surface-variant mb-4">
          Voice conversation is temporarily unavailable: {status?.note}
        </p>
      )}

      {phase !== "ended" && (
        <div className="flex flex-col items-center text-center py-6">
          <div className="w-32 h-32 rounded-full overflow-hidden mb-4 bg-primary-container/10">
            <AvatarModule drivenAnimation={avatarAnimation} />
          </div>
          <p className="text-body-lg text-on-surface font-medium mb-4">{statusText[derivedPhase]}</p>

          {phase !== "idle" && (
            <div className="w-full max-w-sm rounded-xl bg-surface-container-low border border-outline-variant p-2 mb-4">
              <canvas ref={canvasRef} width={320} height={40} className="w-full h-10" />
            </div>
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
                  <Square size={16} /> End Conversation
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

          {messages.length === 0 && phase === "idle" && (
            <p className="text-label-sm text-on-surface-variant mt-4 max-w-sm">
              Voice conversation works without camera analysis. Camera-based analysis is optional.
            </p>
          )}

          {/* Quick choices after Aura's very first reply */}
          {phase === "listening" && messages.length === 2 && (
            <div className="flex flex-wrap justify-center gap-2 mt-5">
              {["Talk about it", "Calm down", "I'm not sure"].map((choice) => (
                <button
                  key={choice}
                  onClick={() => send(choice)}
                  className="rounded-full border border-outline-variant px-4 py-2 text-label-md text-on-surface hover:border-primary hover:bg-primary-container/10"
                >
                  {choice}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {activeSafety && phase !== "ended" && <SafetyPanel safety={activeSafety} />}

      {phase !== "idle" && phase !== "ended" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface-container-low border border-outline-variant px-4 py-3 mb-4">
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
            {cameraActive ? "Turn camera off" : "Add camera (optional)"}
          </button>
        </div>
      )}

      {phase !== "idle" && phase !== "ended" && messages.length > 0 && (
        <div className="mb-2">
          <button
            onClick={() => setShowTranscript((v) => !v)}
            className="flex items-center gap-1.5 text-label-md text-on-surface-variant hover:text-primary"
          >
            {showTranscript ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            {showTranscript ? "Hide transcript" : "Live Transcript"}
          </button>
          {showTranscript && (
            <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-outline-variant bg-surface-container-low p-4 space-y-3">
              {messages.map((m, i) => (
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
            </div>
          )}
        </div>
      )}

      {phase === "ended" && (
        <div className="text-center py-4">
          <h3 className="text-headline-md text-on-surface mb-1">Conversation Complete</h3>
          <p className="text-body-md text-on-surface-variant mb-6">Thank you for talking with me.</p>

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
                  View my patterns
                </button>
                <button
                  onClick={onOpenSafetyPlan}
                  className="rounded-xl border border-outline-variant px-4 py-2.5 text-label-md text-on-surface hover:bg-surface-container-high"
                >
                  Create a plan
                </button>
                <button
                  onClick={onOpenSupport}
                  className="rounded-xl border border-outline-variant px-4 py-2.5 text-label-md text-on-surface hover:bg-surface-container-high"
                >
                  Get human support
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
    </section>
  )
}
