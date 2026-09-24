import { useEffect, useRef, useState } from "react"
import { Mic, Square, Pause, Play, Video, VideoOff, Lock, Zap } from "lucide-react"
import { useAuraConversation } from "../lib/useAuraConversation"
import { useRealtimeVoiceConversation } from "../lib/useRealtimeVoiceConversation"
import { transcribeVoice } from "../lib/chatApi"
import { WordTiming } from "../lib/streamingSpeech"
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

const POLL_MS = 80
const TRANSCRIPT_PREVIEW = 4

const FOLLOWUP_MESSAGE: Record<FeelingAfter, string> = {
  better: "I'm glad things feel a little lighter.",
  slightly_better: "That's good to hear, even a little.",
  same: "That's okay. We can take another approach.",
  worse: "Let's slow down. Would you like to talk to someone you trust or get professional support?",
  not_sure: "That's okay. We don't have to decide right now.",
}

interface Props {
  /** Omitted entirely on a standalone surface (e.g. AI Companion's "Talk to
   * Aura" tab) that has no face/voice-signal analysis or camera concept -
   * every analysis-page-only prop below is optional and simply unused when
   * absent, rather than this being a second component. */
  cameraActive?: boolean
  onToggleCamera?: (on: boolean) => void
  /** Starts the same voice-signal analysis pipeline "Analyse Now" starts
   * (Distress Signal, Synchronized Signals, Multimodal Timeline) - Speak
   * with Aura IS that action for voice, combined into one interactive
   * control rather than two separate buttons to press. */
  onStartAnalysis?: () => void
  onStopAnalysis?: () => void
  onOpenSupport?: () => void
  onOpenInsights?: () => void
  /** Plain-language observation, e.g. "Increased vocal tension was detected
   * during part of the conversation." Null/omitted when nothing to report. */
  observationSummary?: string | null
  /** Keeps this surface's session/history independent from any other
   * useAuraConversation instance on the page (e.g. AI Companion's separate
   * Chat tab) - same backend, its own conversation. */
  sessionKey?: string
}

/**
 * "Speak with Aura" / "Talk to Aura" - realtime, full-duplex, instantaneous
 * audio-to-audio (Gemini Live) whenever it's configured, which is the
 * default everywhere this component is used. Falls back automatically,
 * with no user action needed, to the legacy STT-then-LLM-then-TTS engine
 * (useAuraConversation + RollingAudioCapture's silence-based utterance
 * detection) if Gemini isn't configured or a realtime session fails to
 * start - see useRealtimeVoiceConversation.ts and the `useRealtimeMode`/
 * `forcedLegacy` wiring below for exactly how that fallback works.
 */
export default function AuraVoiceConversation({
  cameraActive,
  onToggleCamera,
  onStartAnalysis,
  onStopAnalysis,
  onOpenSupport,
  onOpenInsights,
  observationSummary,
  sessionKey,
}: Props) {
  const [language, setLanguage] = useState<string>(getStoredLanguage)
  const [phase, setPhase] = useState<Phase>("idle")
  const [transcribing, setTranscribing] = useState(false)
  const [showFullTranscript, setShowFullTranscript] = useState(false)
  const [feedback, setFeedback] = useState<FeelingAfter | null>(null)
  const [showCalmActivity, setShowCalmActivity] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)

  const {
    messages,
    safetyBlocks,
    sending,
    speaking,
    status,
    sendStreaming,
    interrupt,
    reset,
    greet,
    getSpeechProgress,
    getAmplitude,
  } = useAuraConversation(language, sessionKey)

  // Realtime (Gemini Live, full-duplex, instantaneous audio-to-audio) is now
  // THE "Talk to Aura"/"Speak with Aura" engine everywhere this component is
  // used - automatic, not a toggle the user has to find. The legacy
  // STT-then-LLM-then-TTS engine above stays fully intact underneath it as
  // an automatic fallback: if Gemini isn't configured, or a realtime session
  // fails to start, this silently drops to the legacy path rather than
  // leaving the user stuck on a broken "Beta" feature.
  const realtime = useRealtimeVoiceConversation()
  const realtimeAvailable = realtime.status?.ready ?? false
  const [forcedLegacy, setForcedLegacy] = useState(false)
  const useRealtimeMode = realtimeAvailable && !forcedLegacy

  // Unified view over whichever engine is active, so the rest of this
  // component (JSX, waveform, turn loop) doesn't need to branch everywhere.
  const activeMessages = useRealtimeMode ? realtime.messages : messages
  const activeSafetyBlocks = useRealtimeMode ? realtime.safetyBlocks : safetyBlocks
  const activeSpeaking = useRealtimeMode ? realtime.speaking : speaking
  const activeSending = useRealtimeMode ? realtime.connecting : sending
  const activeMicError = useRealtimeMode ? realtime.micError : micError
  const activeGetAmplitude = useRealtimeMode ? realtime.getAmplitude : getAmplitude
  const activeGetSpeechProgress = useRealtimeMode ? realtime.getSpeechProgress : getSpeechProgress
  const activeInterrupt = useRealtimeMode ? realtime.interrupt : interrupt
  const activeGreet = useRealtimeMode ? realtime.greet : greet
  const activeReset = useRealtimeMode ? realtime.reset : reset

  const [amplitude, setAmplitude] = useState(0)
  const [liveCaption, setLiveCaption] = useState<{ words: WordTiming[]; activeIndex: number } | null>(null)

  const captureRef = useRef<RollingAudioCapture | null>(null)
  const pollRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const frameCountRef = useRef(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(false)
  const busyRef = useRef(false)
  const speakingSinceRef = useRef(0)
  const loudStreakRef = useRef(0)

  useEffect(() => {
    if (activeSpeaking) speakingSinceRef.current = performance.now()
    else loudStreakRef.current = 0
  }, [activeSpeaking])

  const changeLanguage = (code: string) => {
    setLanguage(code)
    storeLanguage(code)
  }

  // --- Turn loop: pull finished utterances and stream them through the same
  //     sendStreaming() the text Companion's engine exposes. Also the
  //     barge-in check: if the user starts talking while Aura is speaking,
  //     her audio (and any remaining generation) is cancelled immediately
  //     and the turn hands back, rather than waiting for her to finish.
  //
  //     Two guards keep Aura's OWN voice (leaking back through the mic when
  //     echo cancellation isn't perfect, e.g. no headphones) or a brief
  //     ambient noise spike from being mistaken for the user interrupting:
  //     a short grace window right as she starts speaking (echo is loudest
  //     and least cancelled at onset), and requiring the mic's speech gate
  //     to stay tripped across consecutive polls rather than a single 80ms
  //     blip before committing to a barge-in. ---
  const BARGE_IN_GRACE_MS = 600
  const BARGE_IN_STREAK_REQUIRED = 3

  useEffect(() => {
    // Realtime mode needs none of this: Gemini's own server-side VAD handles
    // turn-taking and interruption, and useRealtimeVoiceConversation's
    // ContinuousMicStream streams audio to it directly - there is no client
    // utterance-capture/transcribe/send loop to run here.
    if (useRealtimeMode) return
    if (phase !== "listening" && phase !== "speaking") return
    pollRef.current = window.setInterval(async () => {
      const capture = captureRef.current
      if (!capture) return
      capture.resumeIfSuspended()

      if (speaking) {
        const withinGrace = performance.now() - speakingSinceRef.current < BARGE_IN_GRACE_MS
        if (capture.isSpeaking && !withinGrace) {
          loudStreakRef.current += 1
          if (loudStreakRef.current >= BARGE_IN_STREAK_REQUIRED) {
            loudStreakRef.current = 0
            interrupt()
          }
        } else {
          loudStreakRef.current = 0
        }
        return
      }
      if (pausedRef.current || busyRef.current) return

      const utterance = capture.takeUtterance()
      if (!utterance) return

      const t0 = performance.now()
      busyRef.current = true
      setTranscribing(true)
      const text = await transcribeVoice(utterance.blob)
      setTranscribing(false)
      if (import.meta.env?.DEV) {
        console.debug(`[latency] transcript_received: ${(performance.now() - t0).toFixed(0)}ms`)
      }
      if (text && text.trim()) await sendStreaming(text)
      busyRef.current = false
    }, POLL_MS)
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, speaking, useRealtimeMode])

  // --- Waveform (every frame, imperative canvas - no React state) plus
  //     throttled (~20fps) amplitude/word-highlight state, driven by the
  //     REAL TTS playback timeline (getSpeechProgress/getAmplitude), not a
  //     fixed timer - so the avatar and caption track actual audio. ---
  useEffect(() => {
    if (phase === "idle" || phase === "ended") return
    const draw = () => {
      if (useRealtimeMode) realtime.resumeIfSuspended()
      const levels = useRealtimeMode ? realtime.getLevels() : captureRef.current?.getLevels() ?? null
      const canvas = canvasRef.current
      if (levels && canvas) {
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
            ctx.fillStyle = activeSpeaking ? "#0062d2" : amp > 0.4 ? "#630ed4" : "#d2bbff"
            ctx.fillRect(i * barWidth, (h - barHeight) / 2, Math.max(1, barWidth - 1), barHeight)
          }
        }
      }

      frameCountRef.current += 1
      if (frameCountRef.current % 3 === 0) {
        if (activeSpeaking) {
          setAmplitude(activeGetAmplitude())
          const progress = activeGetSpeechProgress()
          if (progress && progress.words.length > 0 && progress.elapsed >= 0) {
            let idx = progress.words.findIndex((w) => progress.elapsed < w.end)
            if (idx === -1) idx = progress.words.length - 1
            setLiveCaption({ words: progress.words, activeIndex: idx })
          }
        } else {
          setAmplitude(0)
          setLiveCaption(null)
        }
      }

      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, activeSpeaking, useRealtimeMode])

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [activeMessages.length])

  const startLegacy = async () => {
    try {
      // Shorter trailing-silence window than the analysis-page capture (700ms)
      // trades a slightly higher chance of a mid-thought cutoff for snappier
      // turn-taking - the priority explicitly asked for here.
      const capture = new RollingAudioCapture(2, 550, 20)
      await capture.start()
      captureRef.current = capture
      pausedRef.current = false
      setPhase("listening")
      // One interactive control: talking to Aura also starts the same
      // voice AND face analysis "Analyse Now" would, rather than needing
      // three separate buttons.
      onStartAnalysis?.()
      onToggleCamera?.(true)
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

  const start = async () => {
    setMicError(null)
    if (useRealtimeMode) {
      const ok = await realtime.start(language)
      if (ok) {
        pausedRef.current = false
        setPhase("listening")
        onStartAnalysis?.()
        onToggleCamera?.(true)
        // No scripted opener spoken through Gemini (see the hook's greet()) -
        // just a plain UI cue, since the mic is already live and listening.
        if (activeMessages.length === 0) activeGreet("I'm listening — go ahead.")
        return
      }
      // Realtime failed to start (e.g. a transient Gemini/network issue) -
      // fall back to the legacy pipeline automatically rather than leaving
      // the user stuck on a broken "Start Talking" button.
      setForcedLegacy(true)
      setMicError(null)
    }
    await startLegacy()
  }

  const stopCapture = () => {
    captureRef.current?.stop()
    captureRef.current = null
    if (pollRef.current) window.clearInterval(pollRef.current)
    if (useRealtimeMode) realtime.stop()
  }

  const pause = () => {
    pausedRef.current = true
    activeInterrupt()
    if (useRealtimeMode) realtime.stop()
    setPhase("paused")
  }

  const resume = async () => {
    pausedRef.current = false
    if (useRealtimeMode) {
      const ok = await realtime.start(language)
      if (!ok) {
        setPhase("idle")
        return
      }
    }
    setPhase("listening")
  }

  const end = () => {
    activeInterrupt()
    stopCapture()
    setPhase("ended")
    setFeedback(null)
    onStopAnalysis?.()
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
    activeGreet("Of course. I'm still here.")
  }

  const completeCalmActivity = async (type: CareActivityType) => {
    await setConsent("companion_care", true)
    await submitCareAction("activity", type)
    setShowCalmActivity(false)
    activeGreet("Well done. How are you feeling now?")
  }

  useEffect(() => stopCapture, [])

  const derivedPhase: Phase =
    phase === "ended" || phase === "paused"
      ? phase
      : activeSpeaking
      ? "speaking"
      : activeSending || transcribing
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

  const lastAssistantIdx = [...activeMessages]
    .map((m, i) => ({ m, i }))
    .reverse()
    .find((x) => x.m.role === "assistant")?.i
  const activeSafety = lastAssistantIdx !== undefined ? activeSafetyBlocks[lastAssistantIdx] : undefined
  const unavailable = useRealtimeMode ? realtime.status && !realtime.status.ready : status && !status.ready
  const unavailableNote = useRealtimeMode ? realtime.status?.note : status?.note
  const visibleMessages = showFullTranscript ? activeMessages : activeMessages.slice(-TRANSCRIPT_PREVIEW)

  return (
    <section className="bg-surface-container-lowest rounded-[24px] shadow-ambient-lg p-stack-md">
      {phase === "idle" && (
        <div className="flex justify-end items-center gap-2 mb-2">
          {useRealtimeMode && (
            <span
              title="A live, continuous connection - talk naturally and interrupt Aura anytime, instead of record-then-reply."
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-primary bg-primary-container/20 text-primary text-xs font-medium"
            >
              <Zap size={12} /> Realtime
            </span>
          )}
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

      {phase === "idle" && useRealtimeMode && (
        <p className="text-label-sm text-on-surface-variant mb-4 text-center max-w-sm mx-auto">
          Talk naturally - Aura is listening continuously and you can interrupt her anytime, no need to
          wait for her to finish. Runs on a free usage tier for now, so avoid sharing anything you'd want
          kept fully private just yet.
        </p>
      )}

      {unavailable && (
        <p className="text-label-sm text-on-surface-variant mb-4 text-center">
          Voice conversation is temporarily unavailable: {unavailableNote}
        </p>
      )}

      {phase !== "ended" && (
        <div className="flex flex-col items-center text-center py-6">
          {phase === "idle" && <h1 className="text-headline-lg text-on-surface mb-1">Speak with Aura</h1>}
          <div className="relative w-64 h-56 md:w-72 md:h-64 mb-4">
            {derivedPhase === "speaking" && (
              <>
                <span className="animate-voice-ring absolute inset-0 rounded-[32px] bg-primary/40" style={{ animationDelay: "0s" }} />
                <span className="animate-voice-ring absolute inset-0 rounded-[32px] bg-primary/40" style={{ animationDelay: "0.5s" }} />
                <span className="animate-voice-ring absolute inset-0 rounded-[32px] bg-primary/40" style={{ animationDelay: "1s" }} />
              </>
            )}
            <div className="relative w-full h-full rounded-[28px] overflow-hidden bg-primary-container/10">
              <AvatarModule drivenAnimation={avatarAnimation} amplitude={amplitude} compact interactive forceAvatarType="orb" />
            </div>
          </div>
          <p className="text-body-lg text-on-surface font-medium mb-1">{statusText[derivedPhase]}</p>
          {derivedPhase === "speaking" && liveCaption && (
            <p className="text-body-md text-on-surface-variant mb-1 max-w-sm animate-fade-in-up" aria-live="polite">
              {liveCaption.words.map((w, i) => (
                <span
                  key={i}
                  className={i === liveCaption.activeIndex ? "text-primary font-semibold" : undefined}
                >
                  {w.text}{" "}
                </span>
              ))}
            </p>
          )}
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

          {activeMicError && (
            <p className="text-label-sm text-error mb-3 max-w-sm">{activeMicError}</p>
          )}

          <div key={phase} className="flex items-center gap-3 animate-fade-in-up">
            {phase === "idle" && (
              <button
                onClick={start}
                disabled={!!unavailable}
                className="flex items-center gap-2 rounded-full bg-primary text-on-primary px-6 py-3.5 text-label-md font-semibold disabled:opacity-40 hover:bg-primary-fixed-dim active:scale-95 transition-all"
              >
                <Mic size={18} /> Start Talking
              </button>
            )}
            {phase === "listening" && (
              <>
                <button
                  onClick={pause}
                  className="flex items-center gap-2 rounded-full border border-outline-variant px-5 py-3 text-label-md font-semibold text-on-surface hover:bg-surface-container-high active:scale-95 transition-all"
                >
                  <Pause size={16} /> Pause
                </button>
                <button
                  onClick={end}
                  className="flex items-center gap-2 rounded-full bg-error text-on-error px-5 py-3 text-label-md font-semibold active:scale-95 transition-transform"
                >
                  <Square size={16} /> End
                </button>
              </>
            )}
            {phase === "paused" && (
              <>
                <button
                  onClick={resume}
                  className="flex items-center gap-2 rounded-full bg-primary text-on-primary px-5 py-3 text-label-md font-semibold active:scale-95 transition-transform"
                >
                  <Play size={16} /> Continue
                </button>
                <button
                  onClick={end}
                  className="flex items-center gap-2 rounded-full border border-outline-variant px-5 py-3 text-label-md font-semibold text-on-surface hover:bg-surface-container-high active:scale-95 transition-all"
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

          {/* Quick choices after Aura's very first reply - legacy mode only:
              realtime mode has no discrete "send this text" concept, the
              user just talks. */}
          {!useRealtimeMode && phase === "listening" && activeMessages.length === 2 && (
            <div className="flex flex-wrap justify-center gap-2 mt-5 animate-fade-in-up">
              <button
                onClick={() => sendStreaming("Talk more")}
                className="rounded-full border border-outline-variant px-4 py-2 text-label-md text-on-surface hover:border-primary hover:bg-primary-container/10 active:scale-95 transition-all"
              >
                Talk more
              </button>
              <button
                onClick={() => setShowCalmActivity(true)}
                className="rounded-full border border-outline-variant px-4 py-2 text-label-md text-on-surface hover:border-primary hover:bg-primary-container/10 active:scale-95 transition-all"
              >
                Calm down
              </button>
              <button
                onClick={() => sendStreaming("I'm not sure")}
                className="rounded-full border border-outline-variant px-4 py-2 text-label-md text-on-surface hover:border-primary hover:bg-primary-container/10 active:scale-95 transition-all"
              >
                I'm not sure
              </button>
            </div>
          )}
        </div>
      )}

      {activeSafety && phase !== "ended" && <SafetyPanel safety={activeSafety} />}

      {phase !== "idle" && phase !== "ended" && activeMessages.length > 0 && (
        <div className="rounded-xl bg-surface-container-low border border-outline-variant p-4 mb-4 max-h-72 overflow-y-auto animate-fade-in-up">
          {!showFullTranscript && activeMessages.length > TRANSCRIPT_PREVIEW && (
            <button
              onClick={() => setShowFullTranscript(true)}
              className="text-label-sm text-primary hover:underline mb-3 transition-colors"
            >
              View full transcript
            </button>
          )}
          <div className="space-y-3">
            {visibleMessages.map((m, i) => (
              <div key={i} className="animate-fade-in-up">
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
                Speech <span className="text-secondary font-medium">{transcribing || activeSending ? "Processing" : "Ready"}</span>
              </span>
              {onToggleCamera && (
                <span className="flex items-center gap-1">
                  Face{" "}
                  <span className={cameraActive ? "text-secondary font-medium" : "text-on-surface-variant"}>
                    {cameraActive ? "On" : "Camera off"}
                  </span>
                </span>
              )}
            </div>
            {onToggleCamera && (
              <button
                onClick={() => onToggleCamera(!cameraActive)}
                className="flex items-center gap-1.5 text-label-sm text-on-surface-variant hover:text-primary"
              >
                {cameraActive ? <VideoOff size={14} /> : <Video size={14} />}
                {cameraActive ? "Turn camera off" : "Enable camera analysis"}
              </button>
            )}
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
        <div className="text-center py-4 animate-fade-in-up">
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
                    className="rounded-full border border-outline-variant px-4 py-2 text-label-md text-on-surface hover:border-primary hover:bg-primary-container/10 active:scale-95 transition-all"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 animate-fade-in-up">
              <p className="text-body-md text-on-surface mb-2 max-w-sm">{FOLLOWUP_MESSAGE[feedback]}</p>
              <p className="text-label-md font-semibold text-on-surface mb-1">What would you like to do next?</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  onClick={continueTalking}
                  className="rounded-xl bg-primary text-on-primary px-4 py-2.5 text-label-md font-semibold active:scale-95 transition-transform"
                >
                  Continue talking
                </button>
                {onOpenSupport && (
                  <button
                    onClick={onOpenSupport}
                    className="rounded-xl border border-outline-variant px-4 py-2.5 text-label-md text-on-surface hover:bg-surface-container-high active:scale-95 transition-all"
                  >
                    Try something calming
                  </button>
                )}
                {onOpenInsights && (
                  <button
                    onClick={onOpenInsights}
                    className="rounded-xl border border-outline-variant px-4 py-2.5 text-label-md text-on-surface hover:bg-surface-container-high active:scale-95 transition-all"
                  >
                    View insights
                  </button>
                )}
                {onOpenSupport && (
                  <button
                    onClick={onOpenSupport}
                    className="rounded-xl border border-outline-variant px-4 py-2.5 text-label-md text-on-surface hover:bg-surface-container-high active:scale-95 transition-all"
                  >
                    Get support
                  </button>
                )}
              </div>
            </div>
          )}

          <button
            onClick={() => {
              setPhase("idle")
              activeReset()
            }}
            className="text-label-sm text-on-surface-variant hover:text-primary mt-6 transition-colors"
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
